import { createHash } from 'node:crypto'
import { watch as watchFileSystem } from 'node:fs'
import { join } from 'node:path'
import { validateManualArtifact } from './artifact'
import { canonicalBody } from './canonical'
import { ProjectSyncError, asProjectSyncError, throwIfAborted } from './errors'
import { readStableFile, relativePathKey, sameRootIdentity } from './filesystem'
import {
  PROJECT_INPUT_DOCUMENTS_DIRECTORY,
  PROJECT_INPUT_QA_DIRECTORY,
  PROJECT_OUTPUT_DIRECTORY,
  prepareProjectRoot,
} from './layout'
import { planProjectIncrement } from './planner'
import {
  discardPublishedArtifact,
  discardStagedArtifact,
  publishStagedArtifact,
  readPublishedCanonical,
  stageCanonicalArtifact,
  stagingRelativePath,
} from './saga'
import { BoundedProjectScanner, DEFAULT_PROJECT_SCANNER_LIMITS } from './scanner'
import type {
  CommitManualArtifactInput,
  PlannedConversion,
  ProjectDescriptor,
  ProjectErrorCode,
  ProjectIncrementalPlan,
  ProjectManifestEntry,
  ProjectRecoverySummary,
  ProjectRecord,
  ProjectScanResult,
  ProjectSyncCounts,
  ProjectSyncInput,
  ProjectSyncPhase,
  ProjectSyncPolicy,
  ProjectSyncProgress,
  ProjectSyncResult,
  ProjectSyncRun,
  ProjectSyncService as ProjectSyncServiceContract,
  ProjectSyncServiceOptions,
  ProjectWatchFactory,
  ProjectWatchHandle,
  RecoverableConversionJob,
} from './types'

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024
const DEFAULT_CONVERSION_TIMEOUT_MS = 30_000
const DEFAULT_WATCH_DEBOUNCE_MS = 450

interface ActiveSync {
  readonly controller: AbortController
  readonly input: ProjectSyncInput
  promise: Promise<ProjectSyncResult>
  runId: string | null
  queuedInput: ProjectSyncInput | null
  queuedPromise: Promise<ProjectSyncResult> | null
}

interface WatchState {
  policy: ProjectSyncPolicy
  policyEpoch: number
  readonly handles: ProjectWatchHandle[]
  timer: ReturnType<typeof setTimeout> | null
  dirty: boolean
  deferredAutoApply: boolean
  managedOutputMutations: number
  suppressOutputHintsUntil: number
}

interface DeferredApplyIntent {
  readonly input: ProjectSyncInput
  readonly source: 'explicit' | 'watcher_auto'
  readonly policyEpoch: number | null
}

function defaultWatchFactory(path: string, listener: () => void): ProjectWatchHandle {
  const watcher = watchFileSystem(path, { recursive: true }, listener)
  watcher.on('error', listener)
  return watcher
}

type MutableSyncCounts = { -readonly [Key in keyof ProjectSyncCounts]: ProjectSyncCounts[Key] }

function emptyCounts(): MutableSyncCounts {
  return {
    discovered: 0,
    unchanged: 0,
    converted: 0,
    external: 0,
    unsupported: 0,
    blocked: 0,
    missingGrace: 0,
    tombstoned: 0,
    failed: 0,
  }
}

function validatePositiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be between 1 and ${String(maximum)}`)
  }
  return value
}

function errorCode(error: unknown, fallback: ProjectErrorCode): ProjectErrorCode {
  return error instanceof ProjectSyncError ? error.code : fallback
}

function safeAbortSignal(external?: AbortSignal): { readonly controller: AbortController; readonly signal: AbortSignal } {
  const controller = new AbortController()
  return { controller, signal: external ? AbortSignal.any([controller.signal, external]) : controller.signal }
}

function syncInputCovers(active: ProjectSyncInput, requested: ProjectSyncInput): boolean {
  if (active.projectId !== requested.projectId) return false
  if (requested.apply && !active.apply) return false
  return requested.allowDestructiveChanges !== true || active.allowDestructiveChanges === true
}

function mergeSyncInputs(current: ProjectSyncInput | null, requested: ProjectSyncInput): ProjectSyncInput {
  if (current === null) return requested
  const trigger = current.trigger === 'manual' || requested.trigger === 'manual'
    ? 'manual'
    : current.trigger === 'startup' || requested.trigger === 'startup'
      ? 'startup'
      : 'watcher'
  return {
    projectId: requested.projectId,
    trigger,
    apply: current.apply || requested.apply,
    ...((current.allowDestructiveChanges === true || requested.allowDestructiveChanges === true)
      ? { allowDestructiveChanges: true }
      : {}),
  }
}

function operationId(...parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\0')
  return `manual_${hash.digest('hex').slice(0, 32)}`
}

export class ProjectSyncService implements ProjectSyncServiceContract {
  readonly #repository: ProjectSyncServiceOptions['repository']
  readonly #converter: ProjectSyncServiceOptions['converter']
  readonly #scanner: BoundedProjectScanner
  readonly #scannerLimits
  readonly #conversionConcurrency: number
  readonly #conversionTimeoutMs: number
  readonly #maxOutputBytes: number
  readonly #maxAutomaticTombstones: number
  readonly #now: () => number
  readonly #onProgress: ((event: ProjectSyncProgress) => void) | undefined
  readonly #canAutoApply: ((projectId: string) => boolean) | undefined
  readonly #watchFactory: ProjectWatchFactory
  readonly #activeByProject = new Map<string, ActiveSync>()
  readonly #activeByRun = new Map<string, ActiveSync>()
  readonly #watchStates = new Map<string, WatchState>()
  readonly #sessionDeferredApply = new Map<string, DeferredApplyIntent>()
  readonly #deferredReplayTasks = new Map<string, Promise<void>>()
  readonly #sessionReleaseTasks = new Map<string, Promise<boolean>>()
  #disposed = false

  constructor(options: ProjectSyncServiceOptions) {
    this.#repository = options.repository
    this.#converter = options.converter
    this.#scannerLimits = { ...DEFAULT_PROJECT_SCANNER_LIMITS, ...options.scannerLimits }
    this.#scanner = new BoundedProjectScanner(this.#scannerLimits, options.scanProbe)
    this.#conversionConcurrency = validatePositiveInteger('conversionConcurrency', options.conversionConcurrency ?? 2, 8)
    this.#conversionTimeoutMs = validatePositiveInteger(
      'conversionTimeoutMs',
      options.conversionTimeoutMs ?? DEFAULT_CONVERSION_TIMEOUT_MS,
      10 * 60_000,
    )
    this.#maxOutputBytes = validatePositiveInteger(
      'maxOutputBytes',
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      100 * 1024 * 1024,
    )
    this.#maxAutomaticTombstones = validatePositiveInteger(
      'maxAutomaticTombstones',
      options.maxAutomaticTombstones ?? 20,
      10_000,
    )
    this.#now = options.now ?? Date.now
    this.#onProgress = options.onProgress
    this.#canAutoApply = options.canAutoApply
    this.#watchFactory = options.watchFactory ?? defaultWatchFactory
  }

  async prepareRoot(input: Parameters<ProjectSyncServiceContract['prepareRoot']>[0], signal?: AbortSignal): Promise<ProjectDescriptor> {
    this.#assertUsable()
    if (signal) throwIfAborted(signal)
    const descriptor = await prepareProjectRoot(input)
    if (signal) throwIfAborted(signal)
    return this.#repository.registerProject(descriptor)
  }

  sync(input: ProjectSyncInput, externalSignal?: AbortSignal): Promise<ProjectSyncResult> {
    return this.#sync(input, externalSignal, false)
  }

  #sync(input: ProjectSyncInput, externalSignal: AbortSignal | undefined, forceNewAttempt: boolean): Promise<ProjectSyncResult> {
    this.#assertUsable()
    const existing = this.#activeByProject.get(input.projectId)
    if (existing) {
      if (!forceNewAttempt && syncInputCovers(existing.input, input)) return existing.promise
      existing.queuedInput = mergeSyncInputs(existing.queuedInput, input)
      const runQueued = (): Promise<ProjectSyncResult> => {
        const queued = existing.queuedInput
        existing.queuedInput = null
        existing.queuedPromise = null
        if (queued === null) throw new ProjectSyncError('SYNC_CANCELLED')
        return this.#sync(queued, externalSignal, false)
      }
      // A manual/apply request owns an independent attempt. A failed or
      // cancelled background check must not swallow the stronger queued run.
      existing.queuedPromise ??= existing.promise.then(runQueued, runQueued)
      return existing.queuedPromise
    }
    const { controller, signal } = safeAbortSignal(externalSignal)
    const active = {
      controller,
      input,
      runId: null,
      queuedInput: null,
      queuedPromise: null,
    } as ActiveSync
    active.promise = this.#runSync(input, active, signal).finally(() => {
      if (this.#activeByProject.get(input.projectId) === active) this.#activeByProject.delete(input.projectId)
      if (active.runId && this.#activeByRun.get(active.runId) === active) this.#activeByRun.delete(active.runId)
      const watcher = this.#watchStates.get(input.projectId)
      if (watcher?.dirty) this.#scheduleWatchSync(input.projectId, watcher)
    })
    this.#activeByProject.set(input.projectId, active)
    return active.promise
  }

  cancel(runId: string): boolean {
    const active = this.#activeByRun.get(runId)
    if (!active || active.controller.signal.aborted) return false
    active.controller.abort(new ProjectSyncError('SYNC_CANCELLED'))
    return true
  }

  async recover(projectId: string, signal?: AbortSignal): Promise<ProjectRecoverySummary> {
    this.#assertUsable()
    const localSignal = signal ?? new AbortController().signal
    const project = await this.#requireProject(projectId)
    const jobs = await this.#repository.listRecoverableJobs(projectId)
    const summary = { projectId, committed: 0, rolledBack: 0, failed: 0 }
    if (jobs.length > 0) this.#beginManagedOutputMutation(projectId)
    try {
      for (const job of jobs) {
        throwIfAborted(localSignal)
        try {
          const recovered = await this.#recoverJob(project, job, localSignal)
          if (recovered === 'committed') summary.committed += 1
          else summary.rolledBack += 1
        } catch {
          summary.failed += 1
        }
      }
    } finally {
      if (jobs.length > 0) this.#endManagedOutputMutation(projectId)
    }
    return summary
  }

  async watch(projectId: string, policy: ProjectSyncPolicy): Promise<void> {
    this.#assertUsable()
    const existing = this.#watchStates.get(projectId)
    if (existing) {
      if (existing.policy !== policy) existing.policyEpoch += 1
      existing.policy = policy
      if (policy !== 'auto_check_apply') {
        existing.deferredAutoApply = false
        if (this.#sessionDeferredApply.get(projectId)?.source === 'watcher_auto') {
          this.#sessionDeferredApply.delete(projectId)
        }
      }
      if (existing.dirty) this.#scheduleWatchSync(projectId, existing)
      return
    }
    const project = await this.#requireProject(projectId)
    const state: WatchState = {
      policy,
      policyEpoch: 1,
      handles: [],
      timer: null,
      dirty: false,
      deferredAutoApply: false,
      managedOutputMutations: 0,
      suppressOutputHintsUntil: 0,
    }
    const onHint = (kind: 'input' | 'output'): void => {
      if (kind === 'output' && (
        state.managedOutputMutations > 0 || Date.now() <= state.suppressOutputHintsUntil
      )) return
      state.dirty = true
      this.#scheduleWatchSync(projectId, state)
    }
    try {
      for (const relativeDirectory of [PROJECT_INPUT_DOCUMENTS_DIRECTORY, PROJECT_INPUT_QA_DIRECTORY]) {
        state.handles.push(this.#watchFactory(join(project.rootPath, relativeDirectory), () => { onHint('input') }))
      }
      state.handles.push(this.#watchFactory(
        join(project.rootPath, PROJECT_OUTPUT_DIRECTORY),
        () => { onHint('output') },
      ))
      this.#watchStates.set(projectId, state)
    } catch (error) {
      for (const handle of state.handles) handle.close()
      throw new ProjectSyncError('PROJECT_ROOT_UNAVAILABLE', 'PROJECT_ROOT_UNAVAILABLE', true,
        error instanceof Error ? { cause: error } : undefined)
    }
  }

  resumeAutoApply(projectId: string): boolean {
    const state = this.#watchStates.get(projectId)
    let intent = this.#sessionDeferredApply.get(projectId)
    const explicitReplay = intent?.source === 'explicit'
    const watcherIntentValid = intent?.source === 'watcher_auto' && state?.policy === 'auto_check_apply'
      && state.policyEpoch === intent.policyEpoch
    if (intent && !explicitReplay && !watcherIntentValid) this.#sessionDeferredApply.delete(projectId)
    const watcherReplay = state?.policy === 'auto_check_apply' && state.deferredAutoApply
    if (!explicitReplay && !watcherIntentValid && !watcherReplay) return false
    if (!intent && watcherReplay && state) {
      intent = {
        input: { projectId, trigger: 'watcher', apply: true },
        source: 'watcher_auto',
        policyEpoch: state.policyEpoch,
      }
      this.#sessionDeferredApply.set(projectId, intent)
    }
    if ((explicitReplay || watcherIntentValid) && intent) {
      if (!this.#deferredReplayTasks.has(projectId)) {
        const task = this.#sync(intent.input, undefined, true)
          .then((result) => {
            if (
              result.phase === 'complete' && result.counts.failed === 0 &&
              this.#sessionDeferredApply.get(projectId) === intent
            ) {
              this.#sessionDeferredApply.delete(projectId)
              const currentState = this.#watchStates.get(projectId)
              if (intent.source === 'watcher_auto' && currentState?.policyEpoch === intent.policyEpoch) {
                currentState.deferredAutoApply = false
              }
            }
          })
          .catch(() => undefined)
          .finally(() => {
            if (this.#deferredReplayTasks.get(projectId) === task) this.#deferredReplayTasks.delete(projectId)
          })
        this.#deferredReplayTasks.set(projectId, task)
      }
      return true
    }
    // A watcher-only deferred flag was converted into an epoch-bound intent
    // above and is handled by the same success-only consumption path.
    return this.resumeAutoApply(projectId)
  }

  resumeAfterSession(projectId: string): Promise<boolean> {
    const existing = this.#sessionReleaseTasks.get(projectId)
    if (existing) return existing
    const task = (async (): Promise<boolean> => {
      await this.#activeByProject.get(projectId)?.promise.catch(() => undefined)
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const summary = await this.recover(projectId)
        if (summary.failed === 0) return this.resumeAutoApply(projectId)
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
      }
      throw new ProjectSyncError('DB_COMMIT_FAILED', 'DB_COMMIT_FAILED', true)
    })().finally(() => {
      if (this.#sessionReleaseTasks.get(projectId) === task) this.#sessionReleaseTasks.delete(projectId)
    })
    this.#sessionReleaseTasks.set(projectId, task)
    return task
  }

  unwatch(projectId: string): void {
    const state = this.#watchStates.get(projectId)
    if (!state) return
    this.#watchStates.delete(projectId)
    if (state.timer) clearTimeout(state.timer)
    for (const handle of state.handles) handle.close()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#sessionDeferredApply.clear()
    for (const projectId of [...this.#watchStates.keys()]) this.unwatch(projectId)
    for (const active of this.#activeByProject.values()) {
      active.controller.abort(new ProjectSyncError('SYNC_CANCELLED'))
    }
    await Promise.allSettled([...this.#activeByProject.values()].map((active) => active.promise))
    await Promise.allSettled([...this.#sessionReleaseTasks.values(), ...this.#deferredReplayTasks.values()])
    await this.#converter.dispose()
  }

  async #runSync(input: ProjectSyncInput, active: ActiveSync, signal: AbortSignal): Promise<ProjectSyncResult> {
    const project = await this.#requireProject(input.projectId)
    throwIfAborted(signal)
    this.#consumeWatchHint(input.projectId)
    const run = await this.#repository.beginSyncRun(input.projectId, input.trigger)
    active.runId = run.runId
    this.#activeByRun.set(run.runId, active)
    const counts = emptyCounts()
    this.#emit(run, 'recovering', counts)
    let result: ProjectSyncResult
    try {
      await this.#recoverForSync(project, signal)
      this.#emit(run, 'scanning', counts)
      const manifest = await this.#repository.loadManifest(input.projectId)
      const scanned = await this.#scanner.scan(project, signal, manifest)
      if (!sameRootIdentity(project.rootIdentity, scanned.rootIdentity)) {
        throw new ProjectSyncError('PROJECT_ROOT_IDENTITY_CHANGED')
      }
      const prepared = this.#prepareArtifactPass(scanned, manifest)
      const plan = this.#withoutModifiedConversions(
        planProjectIncrement(input.projectId, run.generation, prepared.scan.observations, prepared.manifest),
        prepared.modifiedSourceIds,
      )
      counts.discovered = prepared.scan.observations.length + prepared.scan.artifacts.length
      counts.blocked = prepared.scan.blocked.length + plan.ambiguousRelativePaths.length
      counts.unchanged = plan.unchangedSourceIds.length
      counts.external = plan.unsupported.filter((entry) => entry.disposition === 'external').length
      counts.unsupported = plan.unsupported.length - counts.external
      counts.missingGrace = plan.missingGraceSourceIds.length
      counts.tombstoned = 0
      this.#emit(run, 'planning', counts)
      await this.#repository.recordScan({
        runId: run.runId,
        projectId: run.projectId,
        generation: run.generation,
        // The repository receives managed artifacts for output-integrity
        // status, but its adapter must never turn them into source rows.
        scan: prepared.scan,
        plan,
      })
      throwIfAborted(signal)
      if (input.apply) {
        const tombstones = input.allowDestructiveChanges === true ||
            plan.tombstoneSourceIds.length <= this.#maxAutomaticTombstones
          ? plan.tombstoneSourceIds
          : []
        if (tombstones.length !== plan.tombstoneSourceIds.length) counts.blocked += plan.tombstoneSourceIds.length
        counts.tombstoned = tombstones.length
        await this.#repository.applyIncrementalPlan({
          projectId: run.projectId,
          runId: run.runId,
          generation: run.generation,
          renames: plan.renames,
          tombstoneSourceIds: tombstones,
        })
        this.#emit(run, 'converting', counts)
        if (plan.conversions.length > 0) this.#beginManagedOutputMutation(project.id)
        try {
          await this.#convertPlan(project, run, plan, counts, signal, input)
        } finally {
          if (plan.conversions.length > 0) this.#endManagedOutputMutation(project.id)
        }
        await this.#commitManualArtifacts(project, run, prepared.manualArtifacts, counts, signal)
      }
      result = { ...run, phase: 'complete', counts: { ...counts }, completedAt: this.#now() }
      await this.#repository.completeSyncRun(result)
      this.#emit(run, 'complete', counts)
      return result
    } catch (error) {
      const converted = asProjectSyncError(error, 'DB_COMMIT_FAILED')
      if (converted.code === 'PROJECT_SESSION_ACTIVE' && input.apply) {
        this.#rememberSessionDeferred(input)
      }
      const phase: ProjectSyncResult['phase'] = converted.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed'
      result = { ...run, phase, counts: { ...counts }, completedAt: this.#now() }
      await this.#repository.completeSyncRun(result).catch(() => undefined)
      this.#emit(run, phase, counts)
      throw converted
    }
  }

  async #recoverForSync(project: ProjectRecord, signal: AbortSignal): Promise<void> {
    const jobs = await this.#repository.listRecoverableJobs(project.id)
    if (jobs.length > 0) this.#beginManagedOutputMutation(project.id)
    try {
      for (const job of jobs) {
        throwIfAborted(signal)
        await this.#recoverJob(project, job, signal)
      }
    } finally {
      if (jobs.length > 0) this.#endManagedOutputMutation(project.id)
    }
  }

  async #recoverJob(
    project: ProjectRecord,
    job: RecoverableConversionJob,
    signal: AbortSignal,
  ): Promise<'committed' | 'rolled_back'> {
    if (job.state === 'PREPARED' || !job.outputSha256) {
      await discardStagedArtifact(project.rootPath, job.tempRelativePath).catch(() => undefined)
      await this.#repository.cancelConversion(job.operationId, job.generation)
      return 'rolled_back'
    }
    let inputRead
    try {
      inputRead = await readStableFile(
        project.rootPath,
        job.observation.relativePath,
        this.#scannerLimits.maxFileBytes,
        signal,
        false,
      )
    } catch (error) {
      if (error instanceof ProjectSyncError && error.code === 'SYNC_CANCELLED') throw error
      return this.#rollBackStaleRecovery(project, job, errorCode(error, 'INPUT_CHANGED_DURING_READ'), signal)
    }
    if (inputRead.sha256 !== job.inputSha256) {
      return this.#rollBackStaleRecovery(project, job, 'INPUT_CHANGED_DURING_READ', signal)
    }
    if (job.state === 'STAGED') {
      let finalAlreadyPublished = false
      try {
        await readPublishedCanonical({
          rootPath: project.rootPath,
          relativePath: job.outputRelativePath,
          expectedHash: job.outputSha256,
          maxOutputBytes: this.#maxOutputBytes,
          signal,
        })
        finalAlreadyPublished = true
      } catch (error) {
        if (!(error instanceof ProjectSyncError) || error.code === 'SYNC_CANCELLED') throw error
      }
      if (!finalAlreadyPublished) {
        try {
          await publishStagedArtifact({
            rootPath: project.rootPath,
            staged: {
              tempRelativePath: job.tempRelativePath,
              finalRelativePath: job.outputRelativePath,
              outputSha256: job.outputSha256,
            },
            expectedExistingSha256: job.expectedExistingOutputSha256,
            maxOutputBytes: this.#maxOutputBytes,
            signal,
          })
        } catch (error) {
          if (error instanceof ProjectSyncError && error.code === 'SYNC_CANCELLED') throw error
          await discardStagedArtifact(project.rootPath, job.tempRelativePath).catch(() => undefined)
          await this.#repository.failConversion(
            job.operationId,
            job.generation,
            errorCode(error, 'OUTPUT_INVALID'),
          )
          return 'rolled_back'
        }
      }
      await this.#repository.markConversionPublished(job.operationId, job.generation)
    }
    const canonical = await readPublishedCanonical({
      rootPath: project.rootPath,
      relativePath: job.outputRelativePath,
      expectedHash: job.outputSha256,
      maxOutputBytes: this.#maxOutputBytes,
      signal,
    })
    await this.#repository.validateCanonicalArtifact({
      trustKind: job.observation.trustKind,
      canonicalContent: canonical.canonicalBody,
      validationProfile: 'generated',
    })
    await this.#repository.commitConversion({
      operationId: job.operationId,
      projectId: job.projectId,
      runId: job.runId,
      generation: job.generation,
      sourceId: job.sourceId,
      trustKind: job.observation.trustKind,
      inputSha256: job.inputSha256,
      outputRelativePath: job.outputRelativePath,
      canonicalContent: canonical.canonicalBody,
      outputSha256: job.outputSha256,
      canonicalBodySha256: createHash('sha256').update(canonical.canonicalBody, 'utf8').digest('hex'),
      outputSize: canonical.size,
      outputMtimeNs: canonical.mtimeNs,
      outputDevice: canonical.device,
      outputInode: canonical.inode,
    })
    return 'committed'
  }

  async #rollBackStaleRecovery(
    project: ProjectRecord,
    job: RecoverableConversionJob,
    code: ProjectErrorCode,
    signal: AbortSignal,
  ): Promise<'rolled_back'> {
    await discardStagedArtifact(project.rootPath, job.tempRelativePath).catch(() => undefined)
    if (job.outputSha256) {
      try {
        await discardPublishedArtifact({
          rootPath: project.rootPath,
          relativePath: job.outputRelativePath,
          expectedHash: job.outputSha256,
          maxOutputBytes: this.#maxOutputBytes,
          signal,
        })
      } catch (error) {
        if (error instanceof ProjectSyncError && error.code === 'SYNC_CANCELLED') throw error
        const finalCode = error instanceof ProjectSyncError && error.code === 'GENERATED_OUTPUT_MODIFIED'
          ? error.code
          : code
        await this.#repository.failConversion(job.operationId, job.generation, finalCode)
        if (finalCode === 'GENERATED_OUTPUT_MODIFIED') throw error
        return 'rolled_back'
      }
    }
    await this.#repository.failConversion(job.operationId, job.generation, code)
    return 'rolled_back'
  }

  #prepareArtifactPass(scan: ProjectScanResult, manifest: readonly ProjectManifestEntry[]): {
    readonly scan: ProjectScanResult
    readonly manifest: readonly ProjectManifestEntry[]
    readonly manualArtifacts: ProjectScanResult['artifacts']
    readonly modifiedSourceIds: ReadonlySet<string>
  } {
    const artifactByPath = new Map(scan.artifacts.map((entry) => [entry.pathKey, entry]))
    const managedPaths = new Set<string>()
    const modifiedSourceIds = new Set<string>()
    const blocked = [...scan.blocked]
    const planningManifest = manifest.map((entry): ProjectManifestEntry => {
      if (!entry.outputRelativePath) return entry
      const key = relativePathKey(entry.outputRelativePath)
      managedPaths.add(key)
      const artifact = artifactByPath.get(key)
      if (!artifact) {
        return { ...entry, state: 'needs_conversion', activeCanonicalSha256: null }
      }
      if (entry.activeCanonicalSha256 && artifact.sha256 !== entry.activeCanonicalSha256) {
        modifiedSourceIds.add(entry.sourceId)
        blocked.push({
          relativePath: artifact.relativePath,
          trustKind: artifact.trustKind,
          errorCode: 'GENERATED_OUTPUT_MODIFIED',
        })
        return { ...entry, state: 'generated_output_modified' }
      }
      return entry
    })
    return {
      scan: { ...scan, blocked },
      manifest: planningManifest,
      manualArtifacts: scan.artifacts.filter((entry) => !managedPaths.has(entry.pathKey)),
      modifiedSourceIds,
    }
  }

  #withoutModifiedConversions(plan: ProjectIncrementalPlan, modifiedSourceIds: ReadonlySet<string>): ProjectIncrementalPlan {
    if (modifiedSourceIds.size === 0) return plan
    return { ...plan, conversions: plan.conversions.filter((entry) => !modifiedSourceIds.has(entry.sourceId)) }
  }

  async #convertPlan(
    project: ProjectRecord,
    run: ProjectSyncRun,
    plan: ProjectIncrementalPlan,
    counts: MutableSyncCounts,
    signal: AbortSignal,
    syncInput: ProjectSyncInput,
  ): Promise<void> {
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(this.#conversionConcurrency, plan.conversions.length) },
      async () => {
        while (cursor < plan.conversions.length) {
          const conversion = plan.conversions[cursor]
          cursor += 1
          if (!conversion) return
          throwIfAborted(signal)
          try {
            await this.#convertOne(project, run, conversion, signal)
            counts.converted += 1
          } catch (error) {
            if (error instanceof ProjectSyncError && error.code === 'SYNC_CANCELLED') throw error
            if (error instanceof ProjectSyncError && error.code === 'PROJECT_SESSION_ACTIVE') {
              this.#rememberSessionDeferred(syncInput)
            }
            counts.failed += 1
          }
          this.#emit(run, 'converting', counts)
        }
      },
    )
    await Promise.all(workers)
  }

  async #convertOne(
    project: ProjectRecord,
    run: ProjectSyncRun,
    conversion: PlannedConversion,
    signal: AbortSignal,
  ): Promise<void> {
    const inputSha256 = conversion.observation.rawSha256
    const tempRelativePath = stagingRelativePath(conversion.operationId, conversion.outputRelativePath)
    await this.#repository.prepareConversion({
      ...conversion,
      projectId: project.id,
      runId: run.runId,
      generation: run.generation,
      inputSha256,
      tempRelativePath,
    })
    let state: 'PREPARED' | 'STAGED' | 'PUBLISHED_FS' = 'PREPARED'
    try {
      const source = await readStableFile(
        project.rootPath,
        conversion.observation.relativePath,
        this.#scannerLimits.maxFileBytes,
        signal,
        true,
      )
      if (source.sha256 !== inputSha256) throw new ProjectSyncError('INPUT_CHANGED_DURING_READ')
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => {
        timeoutController.abort(new ProjectSyncError('CONVERTER_TIMEOUT', 'CONVERTER_TIMEOUT', true))
      }, this.#conversionTimeoutMs)
      let converted
      try {
        converted = await this.#converter.convert({
          projectId: project.id,
          sourceId: conversion.sourceId,
          relativePath: conversion.observation.relativePath,
          trustKind: conversion.observation.trustKind,
          detectedType: conversion.observation.detectedType,
          rawSha256: inputSha256,
          input: source.bytes,
        }, { signal: AbortSignal.any([signal, timeoutController.signal]) })
      } finally {
        clearTimeout(timeout)
      }
      const current = await readStableFile(
        project.rootPath,
        conversion.observation.relativePath,
        this.#scannerLimits.maxFileBytes,
        signal,
        false,
      )
      if (current.sha256 !== inputSha256) throw new ProjectSyncError('INPUT_CHANGED_DURING_READ')
      await this.#repository.validateCanonicalArtifact({
        trustKind: conversion.observation.trustKind,
        canonicalContent: canonicalBody(converted.canonicalMarkdown),
        validationProfile: 'generated',
      })
      const staged = await stageCanonicalArtifact({
        rootPath: project.rootPath,
        operationId: conversion.operationId,
        finalRelativePath: conversion.outputRelativePath,
        canonicalMarkdown: converted.canonicalMarkdown,
        outputSha256: converted.outputSha256,
        maxOutputBytes: this.#maxOutputBytes,
        signal,
      })
      await this.#repository.markConversionStaged(conversion.operationId, run.generation, staged.outputSha256)
      state = 'STAGED'
      await publishStagedArtifact({
        rootPath: project.rootPath,
        staged,
        expectedExistingSha256: conversion.expectedExistingOutputSha256,
        maxOutputBytes: this.#maxOutputBytes,
        signal,
      })
      state = 'PUBLISHED_FS'
      await this.#repository.markConversionPublished(conversion.operationId, run.generation)
      const canonical = await readPublishedCanonical({
        rootPath: project.rootPath,
        relativePath: conversion.outputRelativePath,
        expectedHash: converted.outputSha256,
        maxOutputBytes: this.#maxOutputBytes,
        signal,
      })
      await this.#repository.commitConversion({
        operationId: conversion.operationId,
        projectId: project.id,
        runId: run.runId,
        generation: run.generation,
        sourceId: conversion.sourceId,
        trustKind: conversion.observation.trustKind,
        inputSha256,
        outputRelativePath: conversion.outputRelativePath,
        canonicalContent: canonical.canonicalBody,
        outputSha256: converted.outputSha256,
        canonicalBodySha256: converted.canonicalBodySha256,
        outputSize: canonical.size,
        outputMtimeNs: canonical.mtimeNs,
        outputDevice: canonical.device,
        outputInode: canonical.inode,
      })
    } catch (error) {
      if (state !== 'PUBLISHED_FS') {
        await discardStagedArtifact(project.rootPath, tempRelativePath).catch(() => undefined)
        if (error instanceof ProjectSyncError && error.code === 'SYNC_CANCELLED') {
          await this.#repository.cancelConversion(conversion.operationId, run.generation).catch(() => undefined)
        } else {
          await this.#repository.failConversion(
            conversion.operationId,
            run.generation,
            errorCode(error, 'OUTPUT_INVALID'),
          ).catch(() => undefined)
        }
      }
      throw error
    }
  }

  async #commitManualArtifacts(
    project: ProjectRecord,
    run: ProjectSyncRun,
    artifacts: ProjectScanResult['artifacts'],
    counts: MutableSyncCounts,
    signal: AbortSignal,
  ): Promise<void> {
    for (const artifact of artifacts) {
      throwIfAborted(signal)
      try {
        const read = await readStableFile(project.rootPath, artifact.relativePath, this.#maxOutputBytes, signal, true)
        if (read.sha256 !== artifact.sha256) throw new ProjectSyncError('INPUT_CHANGED_DURING_READ')
        const validated = validateManualArtifact(read.bytes, artifact.trustKind)
        await this.#repository.validateCanonicalArtifact({
          trustKind: artifact.trustKind,
          canonicalContent: validated.canonicalContent,
          validationProfile: 'manual',
        })
        const input: CommitManualArtifactInput = {
          operationId: operationId(project.id, artifact.pathKey, artifact.sha256, 'manual'),
          projectId: project.id,
          runId: run.runId,
          generation: run.generation,
          relativePath: artifact.relativePath,
          trustKind: artifact.trustKind,
          canonicalContent: validated.canonicalContent,
          outputSha256: validated.outputSha256,
          canonicalBodySha256: validated.canonicalBodySha256,
        }
        const committed = await this.#repository.commitManualArtifact(input)
        if (committed.inserted) counts.converted += 1
      } catch (error) {
        if (error instanceof ProjectSyncError && error.code === 'SYNC_CANCELLED') throw error
        if (error instanceof ProjectSyncError && error.code === 'PROJECT_SESSION_ACTIVE') throw error
        counts.failed += 1
        await this.#repository.failManualArtifact({
          projectId: project.id,
          runId: run.runId,
          generation: run.generation,
          relativePath: artifact.relativePath,
          trustKind: artifact.trustKind,
          inputSha256: artifact.sha256,
          errorCode: errorCode(error, 'OUTPUT_INVALID'),
        }).catch(() => undefined)
      }
      this.#emit(run, 'converting', counts)
    }
  }

  async #requireProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.#repository.getProject(projectId)
    if (!project) throw new ProjectSyncError('PROJECT_ROOT_UNAVAILABLE')
    const descriptor = await prepareProjectRoot({ rootPath: project.rootPath, projectId, createMissing: false })
    if (!sameRootIdentity(project.rootIdentity, descriptor.rootIdentity)) {
      throw new ProjectSyncError('PROJECT_ROOT_IDENTITY_CHANGED')
    }
    return project
  }

  #scheduleWatchSync(projectId: string, state: WatchState): void {
    if (this.#disposed || state.timer) return
    if (state.policy === 'manual') return
    state.timer = setTimeout(() => {
      state.timer = null
      if (!state.dirty || this.#disposed) return
      if (this.#activeByProject.has(projectId)) return
      state.dirty = false
      const allowAutoApply = state.policy === 'auto_check_apply' && (this.#canAutoApply?.(projectId) ?? true)
      state.deferredAutoApply = state.policy === 'auto_check_apply' && !allowAutoApply
      void this.sync({
        projectId,
        trigger: 'watcher',
        apply: allowAutoApply,
      }).catch(() => undefined)
    }, DEFAULT_WATCH_DEBOUNCE_MS)
  }

  #consumeWatchHint(projectId: string): void {
    const state = this.#watchStates.get(projectId)
    if (!state) return
    state.dirty = false
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
  }

  #rememberSessionDeferred(input: ProjectSyncInput): void {
    if (!input.apply) return
    const source = input.trigger === 'manual' ? 'explicit' : 'watcher_auto'
    const state = this.#watchStates.get(input.projectId)
    if (source === 'watcher_auto' && state?.policy !== 'auto_check_apply') return
    const next: DeferredApplyIntent = {
      input: { ...input },
      source,
      policyEpoch: source === 'watcher_auto' ? state?.policyEpoch ?? null : null,
    }
    const current = this.#sessionDeferredApply.get(input.projectId)
    if (current?.source === 'explicit' && source !== 'explicit') return
    this.#sessionDeferredApply.set(input.projectId, next)
  }

  #beginManagedOutputMutation(projectId: string): void {
    const state = this.#watchStates.get(projectId)
    if (!state) return
    state.managedOutputMutations += 1
    this.#extendOutputHintSuppression(state)
  }

  #endManagedOutputMutation(projectId: string): void {
    const state = this.#watchStates.get(projectId)
    if (!state) return
    state.managedOutputMutations = Math.max(0, state.managedOutputMutations - 1)
    this.#extendOutputHintSuppression(state)
  }

  #extendOutputHintSuppression(state: WatchState): void {
    state.suppressOutputHintsUntil = Math.max(
      state.suppressOutputHintsUntil,
      Date.now() + (DEFAULT_WATCH_DEBOUNCE_MS * 2),
    )
  }

  #emit(run: ProjectSyncRun, phase: ProjectSyncPhase, counts: ProjectSyncCounts): void {
    try {
      this.#onProgress?.({
        projectId: run.projectId,
        runId: run.runId,
        generation: run.generation,
        phase,
        counts: { ...counts },
      })
    } catch {
      // Progress delivery is best-effort and must not own sync correctness.
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new ProjectSyncError('SYNC_CANCELLED')
  }
}
