import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeProjectInput } from './canonical'
import { ProjectSyncError } from './errors'
import { ProjectSyncService } from './service'
import type {
  CommitConvertedArtifactInput,
  CommitManualArtifactInput,
  PrepareConversionJobInput,
  ProjectDescriptor,
  ProjectIncrementalPlan,
  ProjectManifestEntry,
  ProjectRecord,
  ProjectScanCommitInput,
  ProjectSyncRepository,
  ProjectSyncResult,
  ProjectSyncRun,
  ProjectTrigger,
  ProjectConverter,
  ProjectConverterRequest,
  ProjectConverterResult,
  RecoverableConversionJob,
  ProjectWatchHandle,
} from './types'

class MemoryRepository implements ProjectSyncRepository {
  project: ProjectRecord | null = null
  manifest: ProjectManifestEntry[] = []
  jobs = new Map<string, RecoverableConversionJob>()
  readonly scans: ProjectScanCommitInput[] = []
  readonly appliedPlans: Array<{
    readonly renames: ProjectIncrementalPlan['renames']
    readonly tombstoneSourceIds: readonly string[]
  }> = []
  readonly committed: CommitConvertedArtifactInput[] = []
  readonly manual: CommitManualArtifactInput[] = []
  readonly manualFailures: string[] = []
  readonly manualOperations = new Set<string>()
  readonly completed: ProjectSyncResult[] = []
  generation = 0
  beginSyncFailure: Error | null = null
  commitFailure: Error | null = null
  commitAttempts = 0
  markPublishedFailure: Error | null = null

  async getProject(): Promise<ProjectRecord | null> { return this.project }
  async registerProject(project: ProjectDescriptor): Promise<ProjectRecord> {
    this.project = { ...project, scanGeneration: this.generation }
    return this.project
  }
  async beginSyncRun(projectId: string, trigger: ProjectTrigger): Promise<ProjectSyncRun> {
    void trigger
    if (this.beginSyncFailure) {
      const failure = this.beginSyncFailure
      this.beginSyncFailure = null
      throw failure
    }
    this.generation += 1
    if (!this.project || this.project.id !== projectId) throw new Error('missing')
    this.project = { ...this.project, scanGeneration: this.generation }
    return { projectId, runId: `run-${String(this.generation)}`, generation: this.generation }
  }
  async loadManifest(): Promise<readonly ProjectManifestEntry[]> { return this.manifest }
  async recordScan(input: ProjectScanCommitInput): Promise<void> {
    this.scans.push(input)
    this.applyMissingGrace(input.plan, input.generation)
  }
  async applyIncrementalPlan(input: {
    readonly renames: ProjectIncrementalPlan['renames']
    readonly tombstoneSourceIds: readonly string[]
  }): Promise<void> {
    this.appliedPlans.push(input)
    for (const rename of input.renames) {
      this.manifest = this.manifest.map((entry) => entry.sourceId === rename.sourceId
        ? { ...entry, ...rename.observation, sourceId: entry.sourceId }
        : entry)
    }
    for (const sourceId of input.tombstoneSourceIds) {
      this.manifest = this.manifest.map((entry) => entry.sourceId === sourceId
        ? { ...entry, state: 'tombstoned' }
        : entry)
    }
  }
  async validateCanonicalArtifact(input: {
    readonly canonicalContent: string
    readonly validationProfile: 'generated' | 'manual'
  }): Promise<void> {
    if (!input.canonicalContent.trim()) throw new ProjectSyncError('OUTPUT_INVALID')
  }
  async prepareConversion(input: PrepareConversionJobInput): Promise<void> {
    this.jobs.set(input.operationId, { ...input, state: 'PREPARED', outputSha256: null })
  }
  async markConversionStaged(operationId: string, generation: number, outputSha256: string): Promise<void> {
    const job = this.requireJob(operationId, generation)
    this.jobs.set(operationId, { ...job, state: 'STAGED', outputSha256 })
  }
  async markConversionPublished(operationId: string, generation: number): Promise<void> {
    if (this.markPublishedFailure) throw this.markPublishedFailure
    const job = this.requireJob(operationId, generation)
    this.jobs.set(operationId, { ...job, state: 'PUBLISHED_FS' })
  }
  async commitConversion(input: CommitConvertedArtifactInput): Promise<void> {
    this.commitAttempts += 1
    if (this.commitFailure) throw this.commitFailure
    expect(createHash('sha256').update(input.canonicalContent, 'utf8').digest('hex'))
      .toBe(input.canonicalBodySha256)
    this.committed.push(input)
    this.jobs.delete(input.operationId)
    const observation = this.scans.at(-1)?.scan.observations.find((entry) => entry.rawSha256 === input.inputSha256)
    if (!observation) throw new Error('observation missing')
    const existing = this.manifest.find((entry) => entry.sourceId === input.sourceId)
    const record: ProjectManifestEntry = {
      ...observation,
      sourceId: input.sourceId,
      state: 'ready',
      activeRawSha256: input.inputSha256,
      activeCanonicalSha256: input.outputSha256,
      outputRelativePath: input.outputRelativePath,
      outputSize: input.outputSize,
      outputMtimeNs: input.outputMtimeNs,
      outputDevice: input.outputDevice,
      outputInode: input.outputInode,
      missingSinceGeneration: null,
      lastSeenGeneration: input.generation,
    }
    if (existing) this.manifest.splice(this.manifest.indexOf(existing), 1, record)
    else this.manifest.push(record)
  }
  async commitManualArtifact(input: CommitManualArtifactInput): Promise<{ readonly inserted: boolean }> {
    expect(createHash('sha256').update(input.canonicalContent, 'utf8').digest('hex'))
      .toBe(input.canonicalBodySha256)
    if (this.manualOperations.has(input.operationId)) return { inserted: false }
    this.manualOperations.add(input.operationId)
    this.manual.push(input)
    return { inserted: true }
  }
  async failManualArtifact(input: { readonly relativePath: string }): Promise<void> {
    this.manualFailures.push(input.relativePath)
  }
  async failConversion(operationId: string): Promise<void> { this.jobs.delete(operationId) }
  async cancelConversion(operationId: string): Promise<void> { this.jobs.delete(operationId) }
  async completeSyncRun(result: ProjectSyncResult): Promise<void> { this.completed.push(result) }
  async listRecoverableJobs(): Promise<readonly RecoverableConversionJob[]> { return [...this.jobs.values()] }

  private requireJob(operationId: string, generation: number): RecoverableConversionJob {
    const job = this.jobs.get(operationId)
    if (!job || job.generation !== generation) throw new ProjectSyncError('STALE_GENERATION')
    return job
  }

  private applyMissingGrace(plan: ProjectIncrementalPlan, generation: number): void {
    for (const sourceId of plan.missingGraceSourceIds) {
      this.manifest = this.manifest.map((entry) => entry.sourceId === sourceId
        ? { ...entry, state: 'missing_grace', missingSinceGeneration: generation }
        : entry)
    }
  }
}

class DeterministicConverter implements ProjectConverter {
  readonly convertMock = vi.fn<ProjectConverter['convert']>(async (
    request: ProjectConverterRequest,
    options: { readonly signal: AbortSignal },
  ) => {
    void options
    return canonicalizeProjectInput(request)
  })
  readonly convert: ProjectConverter['convert'] = (request, options) => this.convertMock(request, options)
  readonly dispose = vi.fn(async () => undefined)
}

const fixtures: string[] = []
const services: ProjectSyncService[] = []

async function setup(): Promise<{
  readonly root: string
  readonly repository: MemoryRepository
  readonly converter: DeterministicConverter
  readonly service: ProjectSyncService
  readonly project: ProjectDescriptor
}> {
  const root = await mkdtemp(join(tmpdir(), 'qaing-project-service-'))
  fixtures.push(root)
  const repository = new MemoryRepository()
  const converter = new DeterministicConverter()
  const service = new ProjectSyncService({ repository, converter })
  services.push(service)
  const project = await service.prepareRoot({ rootPath: root, createMissing: true })
  return { root, repository, converter, service, project }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  vi.useRealTimers()
})

describe('ProjectSyncService', () => {
  it('requires an explicit create decision when the fixed layout is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qaing-project-service-'))
    fixtures.push(root)
    const repository = new MemoryRepository()
    const converter = new DeterministicConverter()
    const service = new ProjectSyncService({ repository, converter })
    services.push(service)
    await expect(service.prepareRoot({ rootPath: root, createMissing: false })).rejects.toMatchObject({
      code: 'PROJECT_LAYOUT_MISSING',
    })
    expect(repository.project).toBeNull()
  })

  it('converts, atomically publishes, commits only canonical content, then skips unchanged input', async () => {
    const { root, repository, converter, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'a.txt'), 'hello')
    const first = await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    expect(first).toMatchObject({ phase: 'complete', counts: { converted: 1, failed: 0 } })
    expect(repository.committed).toHaveLength(1)
    expect(repository.committed[0]?.canonicalContent).toContain('# a.txt')
    expect(repository.committed[0]?.canonicalContent).not.toContain('source_sha256:')
    expect(converter.convertMock).toHaveBeenCalledOnce()
    const outputPath = repository.committed[0]?.outputRelativePath
    expect(outputPath).toBeTruthy()
    expect(await readFile(join(root, outputPath ?? ''), 'utf8')).toContain('source_sha256:')

    const second = await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    expect(second.counts.unchanged).toBe(1)
    expect(converter.convertMock).toHaveBeenCalledOnce()
    expect(repository.committed).toHaveLength(1)
  })

  it('returns the same active promise and starts only one generation', async () => {
    const { root, repository, converter, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'a.txt'), 'hello')
    let resolveConversion!: () => void
    converter.convertMock.mockImplementationOnce((request) => new Promise((resolve) => {
      resolveConversion = () => { resolve(canonicalizeProjectInput(request)) }
    }))
    const first = service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    const second = service.sync({ projectId: project.id, trigger: 'watcher', apply: true })
    expect(first).toBe(second)
    await vi.waitFor(() => { expect(converter.convertMock).toHaveBeenCalledOnce() })
    resolveConversion()
    await expect(first).resolves.toMatchObject({ phase: 'complete' })
    expect(repository.generation).toBe(1)
  })

  it('queues one stronger apply run behind an active check-only run', async () => {
    const { root, repository, converter, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'pending.txt'), 'must eventually convert')

    const checked = service.sync({ projectId: project.id, trigger: 'watcher', apply: false })
    const applied = service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    const duplicateApply = service.sync({ projectId: project.id, trigger: 'manual', apply: true })

    expect(applied).toBe(duplicateApply)
    await expect(checked).resolves.toMatchObject({ counts: { converted: 0 } })
    await expect(applied).resolves.toMatchObject({ counts: { converted: 1, failed: 0 } })
    expect(repository.generation).toBe(2)
    expect(converter.convertMock).toHaveBeenCalledOnce()
  })

  it('runs a queued manual apply even when the active background check fails', async () => {
    const { root, repository, converter, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'pending.txt'), 'retry independently')
    repository.beginSyncFailure = new Error('temporary database failure')

    const checked = service.sync({ projectId: project.id, trigger: 'watcher', apply: false })
    const applied = service.sync({ projectId: project.id, trigger: 'manual', apply: true })

    await expect(checked).rejects.toThrow('temporary database failure')
    await expect(applied).resolves.toMatchObject({ counts: { converted: 1, failed: 0 } })
    expect(repository.generation).toBe(1)
    expect(converter.convertMock).toHaveBeenCalledOnce()
  })

  it('uses manifest quick probes for unchanged source and managed artifact files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qaing-project-quick-'))
    fixtures.push(root)
    const repository = new MemoryRepository()
    const converter = new DeterministicConverter()
    const hashed: string[] = []
    const service = new ProjectSyncService({
      repository,
      converter,
      scanProbe: { onHash: (relativePath) => { hashed.push(relativePath) } },
    })
    services.push(service)
    const project = await service.prepareRoot({ rootPath: root, createMissing: true })
    const sourcePath = join(root, '原始资料', 'a.txt')
    await writeFile(sourcePath, 'hello')
    await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    expect(hashed).toEqual(['原始资料/a.txt'])
    hashed.length = 0
    const second = await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    expect(second).toMatchObject({ phase: 'complete', counts: { unchanged: 1, converted: 0, failed: 0 } })
    expect(hashed).toHaveLength(0)
    expect(converter.convertMock).toHaveBeenCalledOnce()
  })

  it('never overwrites a modified managed output', async () => {
    const { root, repository, converter, service, project } = await setup()
    const inputPath = join(root, '原始资料', 'a.txt')
    await writeFile(inputPath, 'first')
    await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    const outputRelative = repository.committed[0]?.outputRelativePath ?? ''
    const outputPath = join(root, outputRelative)
    await writeFile(outputPath, '# user edited generated output')
    await writeFile(inputPath, 'second')
    const result = await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    expect(result.counts.blocked).toBeGreaterThan(0)
    expect(converter.convertMock).toHaveBeenCalledOnce()
    expect(await readFile(outputPath, 'utf8')).toBe('# user edited generated output')
  })

  it('validates manual artifacts without sending them to the converter', async () => {
    const { root, repository, converter, service, project } = await setup()
    const manual = 'Plain reviewed body without a forced heading.\n'
    await writeFile(join(root, '转换资料库', '资料', 'manual.md'), manual)
    const result = await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    expect(result.counts.converted).toBe(1)
    expect(repository.manual).toHaveLength(1)
    expect(repository.manual[0]?.canonicalContent).toBe('Plain reviewed body without a forced heading.')
    expect(converter.convertMock).not.toHaveBeenCalled()
  })

  it('leaves PUBLISHED_FS recoverable after a DB commit failure and replays it', async () => {
    const { root, repository, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'a.txt'), 'hello')
    repository.commitFailure = new Error('db busy')
    const failed = await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    expect(failed.counts.failed).toBe(1)
    expect([...repository.jobs.values()]).toEqual([expect.objectContaining({ state: 'PUBLISHED_FS' })])
    repository.commitFailure = null
    await expect(service.recover(project.id)).resolves.toMatchObject({ committed: 1, failed: 0 })
    expect(repository.committed).toHaveLength(1)
    expect(repository.jobs.size).toBe(0)
  })

  it('rolls back an owned published artifact when its source changes before recovery', async () => {
    const { root, repository, service, project } = await setup()
    const inputPath = join(root, '原始资料', 'a.txt')
    await writeFile(inputPath, 'first')
    repository.commitFailure = new Error('db busy')
    const failed = await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    expect(failed.counts.failed).toBe(1)
    const job = [...repository.jobs.values()][0]
    expect(job).toMatchObject({ state: 'PUBLISHED_FS' })
    const outputPath = join(root, job?.outputRelativePath ?? '')
    await expect(readFile(outputPath, 'utf8')).resolves.toContain('first')

    await writeFile(inputPath, 'second')
    repository.commitFailure = null
    await expect(service.recover(project.id)).resolves.toMatchObject({ committed: 0, rolledBack: 1, failed: 0 })
    await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(repository.jobs.size).toBe(0)

    await expect(service.sync({ projectId: project.id, trigger: 'manual', apply: true }))
      .resolves.toMatchObject({ phase: 'complete', counts: { converted: 1, failed: 0 } })
    await expect(readFile(outputPath, 'utf8')).resolves.toContain('second')
  })

  it('recovers when rename succeeds but persisting PUBLISHED_FS fails', async () => {
    const { root, repository, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'a.txt'), 'hello')
    repository.markPublishedFailure = new Error('db busy after rename')
    const first = await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    expect(first.counts.failed).toBe(1)
    const job = [...repository.jobs.values()][0]
    expect(job).toMatchObject({ state: 'STAGED' })
    await expect(readFile(join(root, job?.outputRelativePath ?? ''), 'utf8')).resolves.toContain('# a.txt')
    repository.markPublishedFailure = null
    await expect(service.recover(project.id)).resolves.toMatchObject({ committed: 1, failed: 0 })
    expect(repository.committed).toHaveLength(1)
  })

  it('cancels an active run without publishing or committing partial content', async () => {
    const { root, repository, converter, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'a.txt'), 'hello')
    converter.convertMock.mockImplementationOnce((
      _request: ProjectConverterRequest,
      options: { readonly signal: AbortSignal },
    ): Promise<ProjectConverterResult> => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const reason = options.signal.reason as unknown
        reject(reason instanceof Error ? reason : new Error('cancelled'))
      }, { once: true })
    }))
    const promise = service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    await vi.waitFor(() => { expect(repository.generation).toBe(1) })
    expect(service.cancel('run-1')).toBe(true)
    await expect(promise).rejects.toMatchObject({ code: 'SYNC_CANCELLED' })
    expect(repository.committed).toHaveLength(0)
    expect(repository.jobs.size).toBe(0)
  })

  it('uses watcher events only as debounced hints and honors confirm versus apply policy', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'qaing-project-watch-'))
    fixtures.push(root)
    const repository = new MemoryRepository()
    const converter = new DeterministicConverter()
    const listeners: Array<() => void> = []
    const close = vi.fn()
    const watchFactory = vi.fn((_path: string, listener: () => void): ProjectWatchHandle => {
      listeners.push(listener)
      return { close }
    })
    const service = new ProjectSyncService({ repository, converter, watchFactory })
    services.push(service)
    const project = await service.prepareRoot({ rootPath: root, createMissing: true })
    await writeFile(join(root, '原始资料', 'a.txt'), 'hello')
    await service.watch(project.id, 'manual')
    expect(listeners).toHaveLength(3)
    listeners[0]?.()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(repository.generation).toBe(0)

    await service.watch(project.id, 'auto_check_confirm')
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => { expect(repository.completed).toHaveLength(1) })
    expect(repository.scans).toHaveLength(1)
    expect(converter.convertMock).not.toHaveBeenCalled()

    await service.watch(project.id, 'auto_check_apply')
    await writeFile(join(root, '原始资料', 'b.txt'), 'new')
    listeners[1]?.()
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => { expect(repository.completed).toHaveLength(2) })
    expect(converter.convertMock).toHaveBeenCalledTimes(2)
    service.unwatch(project.id)
    expect(close).toHaveBeenCalledTimes(3)
  })

  it('does not feed app-owned output writes back into another watcher run', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'qaing-project-watch-output-'))
    fixtures.push(root)
    const repository = new MemoryRepository()
    const converter = new DeterministicConverter()
    const listeners: Array<() => void> = []
    let finishConversion!: () => void
    converter.convertMock.mockImplementationOnce((request) => new Promise((resolve) => {
      finishConversion = () => { resolve(canonicalizeProjectInput(request)) }
    }))
    const service = new ProjectSyncService({
      repository,
      converter,
      watchFactory: (_path, listener): ProjectWatchHandle => {
        listeners.push(listener)
        return { close: () => undefined }
      },
    })
    services.push(service)
    const project = await service.prepareRoot({ rootPath: root, createMissing: true })
    await service.watch(project.id, 'auto_check_apply')
    await writeFile(join(root, '原始资料', 'watched.txt'), 'output feedback must be suppressed')

    listeners[0]?.()
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => { expect(converter.convertMock).toHaveBeenCalledOnce() })
    // Conversion can take longer than the post-write settle window. The
    // operation-scoped guard must remain active for its whole lifetime.
    await vi.advanceTimersByTimeAsync(2_000)
    // A real fs.watch reports the staging write and final rename through the
    // output-root listener while conversion is still active.
    listeners[2]?.()
    listeners[2]?.()
    finishConversion()
    await vi.waitFor(() => { expect(repository.completed).toHaveLength(1) })
    listeners[2]?.()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(repository.generation).toBe(1)
    expect(repository.completed).toHaveLength(1)
  })

  it('allows watcher reconciliation but suppresses unattended apply while a live session owns the knowledge version', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'qaing-project-watch-guard-'))
    fixtures.push(root)
    const repository = new MemoryRepository()
    const converter = new DeterministicConverter()
    const listeners: Array<() => void> = []
    let allowApply = false
    const service = new ProjectSyncService({
      repository,
      converter,
      canAutoApply: () => allowApply,
      watchFactory: (_path, listener): ProjectWatchHandle => {
        listeners.push(listener)
        return { close: () => undefined }
      },
    })
    services.push(service)
    const project = await service.prepareRoot({ rootPath: root, createMissing: true })
    await service.watch(project.id, 'auto_check_apply')
    await writeFile(join(root, '原始资料', 'guarded.txt'), 'must wait for the live session to finish')

    listeners[0]?.()
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => { expect(repository.completed).toHaveLength(1) })
    expect(repository.scans).toHaveLength(1)
    expect(converter.convertMock).not.toHaveBeenCalled()

    allowApply = true
    expect(service.resumeAutoApply(project.id)).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => { expect(repository.completed).toHaveLength(2) })
    expect(converter.convertMock).toHaveBeenCalledOnce()
    expect(service.resumeAutoApply(project.id)).toBe(false)
  })

  it('invalidates a deferred watcher apply when the user downgrades the sync policy', async () => {
    const { root, repository, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'watcher-policy.txt'), '只允许当前自动策略提交')
    await service.watch(project.id, 'auto_check_apply')
    repository.commitFailure = new ProjectSyncError('PROJECT_SESSION_ACTIVE', 'PROJECT_SESSION_ACTIVE', true)

    await expect(service.sync({ projectId: project.id, trigger: 'watcher', apply: true }))
      .resolves.toMatchObject({ counts: { converted: 0, failed: 1 } })
    expect([...repository.jobs.values()]).toEqual([expect.objectContaining({ state: 'PUBLISHED_FS' })])
    await service.watch(project.id, 'manual')
    repository.commitFailure = null

    expect(service.resumeAutoApply(project.id)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(repository.generation).toBe(1)
    expect(repository.committed).toEqual([])
  })

  it('queues a deferred explicit apply behind an overlapping run and consumes it only after replay succeeds', async () => {
    const { root, repository, converter, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'first.txt'), 'first deferred')
    repository.commitFailure = new ProjectSyncError('PROJECT_SESSION_ACTIVE', 'PROJECT_SESSION_ACTIVE', true)
    await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    repository.commitFailure = null
    await writeFile(join(root, '原始资料', 'second.txt'), 'overlapping work')
    let release!: () => void
    converter.convertMock.mockImplementationOnce((request) => new Promise((resolve) => {
      release = () => { resolve(canonicalizeProjectInput(request)) }
    }))

    const overlapping = service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    await vi.waitFor(() => { expect(converter.convertMock).toHaveBeenCalledTimes(2) })
    expect(service.resumeAutoApply(project.id)).toBe(true)
    expect(service.resumeAutoApply(project.id)).toBe(true)
    release()
    await expect(overlapping).resolves.toMatchObject({ phase: 'complete' })
    await vi.waitFor(() => { expect(repository.generation).toBe(3) })
    expect(repository.committed).toHaveLength(2)
    expect(service.resumeAutoApply(project.id)).toBe(false)
  })

  it('keeps an explicit replay intent when a non-session commit failure is counted inside a complete run', async () => {
    const { root, repository, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'explicit-replay.txt'), 'explicit retry')
    repository.commitFailure = new ProjectSyncError('PROJECT_SESSION_ACTIVE', 'PROJECT_SESSION_ACTIVE', true)
    await service.sync({ projectId: project.id, trigger: 'manual', apply: true })

    repository.commitFailure = null
    await expect(service.recover(project.id)).resolves.toMatchObject({ committed: 1, failed: 0 })
    await writeFile(join(root, '原始资料', 'explicit-replay-next.txt'), 'next explicit retry')
    repository.commitFailure = new Error('temporary database failure')
    expect(service.resumeAutoApply(project.id)).toBe(true)
    await vi.waitFor(() => { expect(repository.completed).toHaveLength(2) })
    expect(repository.completed[1]).toMatchObject({ phase: 'complete', counts: { failed: 1 } })
    repository.commitFailure = null
    await vi.waitFor(() => {
      service.resumeAutoApply(project.id)
      expect(repository.generation).toBe(3)
    })
    await vi.waitFor(() => { expect(repository.jobs.size).toBe(0) })
    expect(repository.committed).toHaveLength(2)
    expect(new Set(repository.committed.map((entry) => entry.operationId)).size).toBe(2)
    expect(service.resumeAutoApply(project.id)).toBe(false)
  })

  it('keeps an epoch-valid watcher replay after a transient failure and consumes it only on success', async () => {
    const { root, repository, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'watcher-replay.txt'), 'watcher retry')
    await service.watch(project.id, 'auto_check_apply')
    repository.commitFailure = new ProjectSyncError('PROJECT_SESSION_ACTIVE', 'PROJECT_SESSION_ACTIVE', true)
    await service.sync({ projectId: project.id, trigger: 'watcher', apply: true })

    repository.commitFailure = null
    await expect(service.recover(project.id)).resolves.toMatchObject({ committed: 1, failed: 0 })
    await writeFile(join(root, '原始资料', 'watcher-replay-next.txt'), 'next watcher retry')
    repository.commitFailure = new Error('temporary watcher failure')
    expect(service.resumeAutoApply(project.id)).toBe(true)
    await vi.waitFor(() => { expect(repository.completed).toHaveLength(2) })
    expect(repository.completed[1]).toMatchObject({ phase: 'complete', counts: { failed: 1 } })
    repository.commitFailure = null

    await vi.waitFor(() => {
      service.resumeAutoApply(project.id)
      expect(repository.generation).toBe(3)
    })
    await vi.waitFor(() => { expect(repository.jobs.size).toBe(0) })
    expect(repository.committed).toHaveLength(2)
    expect(new Set(repository.committed.map((entry) => entry.operationId)).size).toBe(2)
    expect(service.resumeAutoApply(project.id)).toBe(false)
  })

  it('deduplicates session-release recovery, retries three times, and preserves replay intent after exhaustion', async () => {
    const { root, repository, service, project } = await setup()
    await writeFile(join(root, '原始资料', 'recovery-retry.txt'), 'bounded recovery')
    repository.commitFailure = new ProjectSyncError('PROJECT_SESSION_ACTIVE', 'PROJECT_SESSION_ACTIVE', true)
    await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    repository.commitFailure = new Error('temporary recovery failure')

    const first = service.resumeAfterSession(project.id)
    const duplicate = service.resumeAfterSession(project.id)
    expect(first).toBe(duplicate)
    await expect(first).rejects.toMatchObject({ code: 'DB_COMMIT_FAILED', retryable: true })
    expect(repository.commitAttempts).toBe(4)
    expect([...repository.jobs.values()]).toEqual([expect.objectContaining({ state: 'PUBLISHED_FS' })])

    repository.commitFailure = null
    await expect(service.resumeAfterSession(project.id)).resolves.toBe(true)
    await vi.waitFor(() => { expect(repository.jobs.size).toBe(0) })
    expect(repository.committed).toHaveLength(1)
  })

  it('coalesces a real input hint during a managed output write into one follow-up scan', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'qaing-project-watch-input-'))
    fixtures.push(root)
    const repository = new MemoryRepository()
    const converter = new DeterministicConverter()
    const listeners: Array<() => void> = []
    let finishConversion!: () => void
    converter.convertMock.mockImplementationOnce((request) => new Promise((resolve) => {
      finishConversion = () => { resolve(canonicalizeProjectInput(request)) }
    }))
    const service = new ProjectSyncService({
      repository,
      converter,
      watchFactory: (_path, listener): ProjectWatchHandle => {
        listeners.push(listener)
        return { close: () => undefined }
      },
    })
    services.push(service)
    const project = await service.prepareRoot({ rootPath: root, createMissing: true })
    await service.watch(project.id, 'auto_check_apply')
    await writeFile(join(root, '原始资料', 'first.txt'), 'first')
    listeners[0]?.()
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => { expect(converter.convertMock).toHaveBeenCalledOnce() })

    await writeFile(join(root, '原始资料', 'second.txt'), 'second')
    listeners[0]?.()
    finishConversion()
    await vi.waitFor(() => { expect(repository.completed).toHaveLength(1) })
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => { expect(repository.completed).toHaveLength(2) })

    expect(repository.generation).toBe(2)
    expect(converter.convertMock).toHaveBeenCalledTimes(2)
  })

  it('does not apply a rename during check-only sync and applies it only after confirmation', async () => {
    const { root, repository, service, project } = await setup()
    const oldPath = join(root, '原始资料', 'old.txt')
    const newPath = join(root, '原始资料', 'new.txt')
    await writeFile(oldPath, 'same')
    await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    await rename(oldPath, newPath)
    const checked = await service.sync({ projectId: project.id, trigger: 'manual', apply: false })
    expect(checked.phase).toBe('complete')
    expect(repository.appliedPlans).toHaveLength(1)
    expect(repository.manifest[0]?.relativePath).toBe('原始资料/old.txt')
    await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    expect(repository.appliedPlans.at(-1)?.renames).toHaveLength(1)
    expect(repository.manifest[0]?.relativePath).toBe('原始资料/new.txt')
  })

  it('does not tombstone last-good content after repeated check-only missing scans', async () => {
    const { root, repository, service, project } = await setup()
    const path = join(root, '原始资料', 'a.txt')
    await writeFile(path, 'stable')
    await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    await rm(path)

    const firstCheck = await service.sync({ projectId: project.id, trigger: 'manual', apply: false })
    const secondCheck = await service.sync({ projectId: project.id, trigger: 'manual', apply: false })
    expect(firstCheck.counts.tombstoned).toBe(0)
    expect(secondCheck.counts.tombstoned).toBe(0)
    expect(repository.appliedPlans).toHaveLength(1)
    expect(repository.manifest[0]).toMatchObject({
      state: 'missing_grace',
      activeRawSha256: createHash('sha256').update('stable').digest('hex'),
    })
  })
})
