import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SimulationProviderError, SimulationWorkflowError } from './errors'
import { QaSimulationService } from './service'
import type {
  CommitSimulationBatchInput,
  CreateSimulationJobInput,
  QaCoveragePlan,
  QaSimulationBatchRecord,
  QaSimulationBrief,
  QaSimulationJobRecord,
  QaSimulationJobState,
  QaSlotEvidence,
  SimulationKnowledgePort,
  SimulationProviderPort,
  SimulationProjectFence,
  SimulationRepositoryPort,
} from './types'

const BRIEF: QaSimulationBrief = {
  intervieweeIdentity: '项目负责人',
  audience: '评审专家',
  focusTopics: ['预算', '实施计划'],
  scenario: '项目评审',
  answerStyle: 'standard',
  excludedTopics: ['个人隐私'],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class MemoryRepository implements SimulationRepositoryPort {
  readonly jobs = new Map<string, QaSimulationJobRecord>()
  readonly plans = new Map<string, QaCoveragePlan>()
  readonly batches = new Map<string, QaSimulationBatchRecord[]>()

  async createJob(input: CreateSimulationJobInput): Promise<QaSimulationJobRecord> {
    if (this.jobs.has(input.id)) throw new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
    const job: QaSimulationJobRecord = {
      id: input.id,
      fence: input.fence,
      generation: input.generation,
      requestedCount: input.requestedCount,
      fulfilledCount: 0,
      gapCount: 0,
      approvedCount: 0,
      publishedCount: 0,
      brief: input.brief,
      briefHash: input.briefHash,
      workflowVersion: input.workflowVersion,
      state: 'planning',
      errorCode: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      completedAt: null,
      dataRevision: 0,
      nextBatchOrdinal: 0,
    }
    this.jobs.set(input.id, job)
    return job
  }

  async getJob(projectId: string, jobId: string): Promise<QaSimulationJobRecord | null> {
    const job = this.jobs.get(jobId) ?? null
    return job?.fence.projectId === projectId ? job : null
  }

  async getLatestJob(projectId: string): Promise<QaSimulationJobRecord | null> {
    return [...this.jobs.values()]
      .filter((job) => job.fence.projectId === projectId)
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  }

  async transition(input: {
    readonly projectId: string
    readonly jobId: string
    readonly expectedGeneration: number
    readonly expectedStates: readonly QaSimulationJobState[]
    readonly nextState: QaSimulationJobState
    readonly errorCode?: QaSimulationJobRecord['errorCode']
    readonly completedAt?: number | null
  }): Promise<QaSimulationJobRecord | null> {
    const current = this.jobs.get(input.jobId)
    if (
      !current
      || current.fence.projectId !== input.projectId
      || current.generation !== input.expectedGeneration
      || !input.expectedStates.includes(current.state)
    ) return null
    const next: QaSimulationJobRecord = {
      ...current,
      state: input.nextState,
      errorCode: input.errorCode === undefined ? current.errorCode : input.errorCode,
      completedAt: input.completedAt === undefined ? current.completedAt : input.completedAt,
      updatedAt: current.updatedAt + 1,
      dataRevision: current.dataRevision + 1,
    }
    this.jobs.set(current.id, next)
    return next
  }

  async advanceGeneration(input: {
    readonly projectId: string
    readonly jobId: string
    readonly expectedGeneration: number
    readonly expectedStates: readonly QaSimulationJobState[]
    readonly nextState: 'planning' | 'retrieving'
  }): Promise<QaSimulationJobRecord | null> {
    const current = this.jobs.get(input.jobId)
    if (!current || current.fence.projectId !== input.projectId || current.generation !== input.expectedGeneration || !input.expectedStates.includes(current.state)) {
      return null
    }
    const next = {
      ...current,
      generation: current.generation + 1,
      state: input.nextState,
      errorCode: null,
      completedAt: null,
      updatedAt: current.updatedAt + 1,
      dataRevision: current.dataRevision + 1,
    } satisfies QaSimulationJobRecord
    this.jobs.set(current.id, next)
    return next
  }

  async saveCoveragePlan(input: { readonly projectId: string; readonly jobId: string; readonly generation: number; readonly plan: QaCoveragePlan }): Promise<void> {
    const current = this.jobs.get(input.jobId)
    if (!current || current.fence.projectId !== input.projectId || current.generation !== input.generation || !['planning', 'retrieving'].includes(current.state)) {
      throw new SimulationWorkflowError('SUPERSEDED', false)
    }
    const existing = this.plans.get(input.jobId)
    if (existing && existing.planHash !== input.plan.planHash) throw new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
    this.plans.set(input.jobId, input.plan)
  }

  async getCoveragePlan(_projectId: string, jobId: string): Promise<QaCoveragePlan | null> {
    return this.plans.get(jobId) ?? null
  }

  async listBatches(_projectId: string, jobId: string): Promise<readonly QaSimulationBatchRecord[]> {
    return this.batches.get(jobId) ?? []
  }

  async acceptedQuestionIdentities(_projectId: string, jobId: string): Promise<readonly string[]> {
    return (this.batches.get(jobId) ?? []).flatMap((batch) => batch.items.map((item) => item.questionIdentity))
  }

  async commitBatch(input: CommitSimulationBatchInput): Promise<{ readonly inserted: boolean; readonly job: QaSimulationJobRecord }> {
    const current = this.jobs.get(input.jobId)
    if (!current || current.fence.projectId !== input.projectId || current.generation !== input.generation || !['retrieving', 'generating', 'validating'].includes(current.state)) {
      throw new SimulationWorkflowError('SUPERSEDED', false)
    }
    const batches = this.batches.get(input.jobId) ?? []
    const existing = batches.find((batch) => batch.operationId === input.operationId)
    if (existing) return { inserted: false, job: current }
    const batch: QaSimulationBatchRecord = { ...input }
    batches.push(batch)
    this.batches.set(input.jobId, batches)
    const next = {
      ...current,
      fulfilledCount: current.fulfilledCount + input.items.length,
      gapCount: current.gapCount + input.gaps.length,
      updatedAt: current.updatedAt + 1,
      dataRevision: current.dataRevision + 1,
      nextBatchOrdinal: current.nextBatchOrdinal + 1,
    }
    this.jobs.set(input.jobId, next)
    return { inserted: true, job: next }
  }
}

function evidenceFor(
  slot: { readonly id: string; readonly ordinal: number },
  projectId: string,
  knowledgeVersion: number,
): QaSlotEvidence {
  const amount = 100 + slot.ordinal
  const excerpt = `测试项目2026年第${slot.ordinal}项预算为${amount}万元，不包含税费。`
  return {
    slotId: slot.id,
    evidence: [{
      projectId,
      knowledgeVersion,
      projectDataRevision: 4,
      sourceManifestHash: 'a'.repeat(64),
      reference: {
        sourceId: 'source-1',
        sourceRevisionId: 'revision-1',
        documentId: 'document-1',
        chunkId: `chunk-${slot.ordinal}`,
        contentHash: createHash('sha256').update(excerpt).digest('hex'),
      },
      title: '测试资料',
      excerpt,
    }],
  }
}

class FakeKnowledge implements SimulationKnowledgePort {
  readonly fences = new Map<string, SimulationProjectFence>([
    ['project-a', {
      projectId: 'project-a', knowledgeVersion: 3, projectDataRevision: 4,
      sourceManifestHash: 'a'.repeat(64), sourceCount: 1,
    }],
    ['project-b', {
      projectId: 'project-b', knowledgeVersion: 5, projectDataRevision: 6,
      sourceManifestHash: 'b'.repeat(64), sourceCount: 2,
    }],
  ])
  readonly missingOrdinals = new Set<number>()
  calls = 0
  implementation: SimulationKnowledgePort['retrieveEvidence'] | null = null

  async getProjectFence(projectId: string): Promise<SimulationProjectFence | null> {
    return this.fences.get(projectId) ?? null
  }

  async retrieveEvidence(input: Parameters<SimulationKnowledgePort['retrieveEvidence']>[0]): Promise<readonly QaSlotEvidence[]> {
    this.calls += 1
    if (this.implementation) return this.implementation(input)
    return input.slots
      .filter((slot) => !this.missingOrdinals.has(slot.ordinal))
      .map((slot) => evidenceFor(slot, input.fence.projectId, input.fence.knowledgeVersion))
  }
}

type ProviderInput = Parameters<SimulationProviderPort['generateBatch']>[0]
type ProviderOutput = Awaited<ReturnType<SimulationProviderPort['generateBatch']>>

class FakeProvider implements SimulationProviderPort {
  readonly calls: ProviderInput[] = []
  implementation: ((input: ProviderInput, call: number) => Promise<ProviderOutput>) | null = null
  concurrent = 0
  maxConcurrent = 0

  async generateBatch(input: ProviderInput): Promise<ProviderOutput> {
    this.calls.push(input)
    this.concurrent += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent)
    try {
      if (this.implementation) return await this.implementation(input, this.calls.length)
      return this.valid(input)
    } finally {
      this.concurrent -= 1
    }
  }

  valid(input: ProviderInput): ProviderOutput {
    const evidence = new Map(input.evidence.map((bundle) => [bundle.slotId, bundle.evidence[0]!]))
    return {
      rawJson: JSON.stringify({
        items: input.slots.map((slot) => {
          const source = evidence.get(slot.id)!
          return {
            slotId: slot.id,
            question: `测试项目2026年第${slot.ordinal}项预算是多少？`,
            answer: source.excerpt,
            sourceReferences: [source.reference],
          }
        }),
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    }
  }
}

function fixture(options: Partial<ConstructorParameters<typeof QaSimulationService>[0]> = {}) {
  const repository = new MemoryRepository()
  const knowledge = new FakeKnowledge()
  const provider = new FakeProvider()
  let now = 1_000
  const service = new QaSimulationService({
    repository,
    knowledge,
    provider,
    retryDelayMs: 0,
    operationTimeoutMs: 100,
    now: () => { now += 1; return now },
    jobIdFactory: () => 'generated-job',
    ...options,
  })
  return { repository, knowledge, provider, service }
}

function startInput(jobId: string, requestedCount = 30) {
  return {
    jobId,
    fence: {
      projectId: 'project-a', knowledgeVersion: 3, projectDataRevision: 4,
      sourceManifestHash: 'a'.repeat(64), sourceCount: 1,
    },
    requestedCount,
    brief: BRIEF,
  } as const
}

describe('controlled QA simulation workflow', () => {
  it('preflights the caller default of 30 and warns for a supported run above 40', async () => {
    const { service } = fixture()
    await expect(service.preflight({ projectId: 'project-a', requestedCount: 30, brief: BRIEF })).resolves.toMatchObject({
      requestedCount: 30,
      estimatedBatches: 3,
      confirmationRequired: false,
      warnings: [],
    })
    await expect(service.preflight({ projectId: 'project-a', requestedCount: 101, brief: BRIEF })).resolves.toMatchObject({
      requestedCount: 101,
      estimatedBatches: 11,
      confirmationRequired: true,
      warnings: ['LARGE_BATCH_TIME', 'EVIDENCE_DILUTION'],
    })
    await service.dispose()
  })

  it('rejects an adversarial materialized-plan size explicitly before allocation', async () => {
    const { knowledge, repository, service } = fixture()
    await expect(service.preflight({
      projectId: 'project-a',
      requestedCount: Number.MAX_SAFE_INTEGER,
      brief: BRIEF,
    })).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED', retryable: false })
    await expect(service.start({
      ...startInput('capacity-overflow', 10_001),
      largeBatchAcknowledged: true,
    })).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED', retryable: false })
    expect(knowledge.calls).toBe(0)
    expect(repository.jobs.size).toBe(0)
    await service.dispose()
  })

  it.each([41, 100, 101])('requires acknowledgement and generates all %i requested slots without truncation', async (requestedCount) => {
    const { repository, provider, service } = fixture()
    const jobId = `large-ack-${String(requestedCount)}`
    await expect(service.start(startInput(`large-no-ack-${String(requestedCount)}`, requestedCount))).rejects.toMatchObject({
      code: 'LARGE_BATCH_CONFIRMATION_REQUIRED',
    })
    await service.start({ ...startInput(jobId, requestedCount), largeBatchAcknowledged: true })
    const job = await service.waitForIdle('project-a', jobId)
    expect(job).toMatchObject({ state: 'review_required', requestedCount, fulfilledCount: requestedCount, gapCount: 0 })
    const expectedBatchSizes = Array.from(
      { length: Math.ceil(requestedCount / 10) },
      (_value, index) => Math.min(10, requestedCount - index * 10),
    )
    expect(provider.calls.map((call) => call.slots.length)).toEqual(expectedBatchSizes)
    expect(repository.batches.get(jobId)).toHaveLength(expectedBatchSizes.length)
    await service.dispose()
  })

  it('keeps provider concurrency at one even when two jobs run together', async () => {
    const { provider, service } = fixture()
    provider.implementation = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return provider.valid(input)
    }
    await service.start(startInput('parallel-a', 11))
    await service.start(startInput('parallel-b', 11))
    await Promise.all([
      service.waitForIdle('project-a', 'parallel-a'),
      service.waitForIdle('project-a', 'parallel-b'),
    ])
    expect(provider.maxConcurrent).toBe(1)
    await service.dispose()
  })

  it('retries a bounded invalid JSON response and commits only the complete valid batch', async () => {
    const { provider, repository, service } = fixture()
    provider.implementation = async (input, call) => call === 1 ? { rawJson: '{invalid' } : provider.valid(input)
    await service.start(startInput('retry-json', 3))
    const job = await service.waitForIdle('project-a', 'retry-json')
    expect(job).toMatchObject({ state: 'review_required', fulfilledCount: 3 })
    expect(provider.calls).toHaveLength(2)
    expect(repository.batches.get('retry-json')).toHaveLength(1)
    expect(repository.batches.get('retry-json')?.[0]).not.toHaveProperty('rawJson')
    expect(repository.batches.get('retry-json')?.[0]?.payloadHash).toMatch(/^[a-f0-9]{64}$/u)
    await service.dispose()
  })

  it('retries transient evidence retrieval with the same frozen slots', async () => {
    const { knowledge, provider, service } = fixture()
    knowledge.implementation = async (input) => {
      if (knowledge.calls === 1) throw new SimulationWorkflowError('EVIDENCE_FAILED', true)
      return input.slots.map((slot) => evidenceFor(slot, input.fence.projectId, input.fence.knowledgeVersion))
    }
    await service.start(startInput('retry-evidence', 2))
    await expect(service.waitForIdle('project-a', 'retry-evidence')).resolves.toMatchObject({ state: 'review_required', fulfilledCount: 2 })
    expect(knowledge.calls).toBe(2)
    expect(provider.calls).toHaveLength(1)
    await service.dispose()
  })

  it('records evidence shortages as explicit gaps without calling the model for those slots', async () => {
    const { knowledge, provider, repository, service } = fixture()
    knowledge.missingOrdinals.add(2)
    await service.start(startInput('evidence-gap', 3))
    const job = await service.waitForIdle('project-a', 'evidence-gap')
    expect(job).toMatchObject({ state: 'review_required', fulfilledCount: 2, gapCount: 1 })
    expect(provider.calls[0]?.slots.map((slot) => slot.ordinal)).toEqual([1, 3])
    expect(repository.batches.get('evidence-gap')?.[0]?.gaps).toEqual([
      expect.objectContaining({ ordinal: 2, reason: 'no_evidence' }),
    ])
    await service.dispose()
  })

  it('resumes only paused work with a new generation and rejects terminal failures', async () => {
    const { provider, repository, service } = fixture()
    provider.implementation = async (input, call) => {
      if (call === 2) throw new SimulationProviderError('UPSTREAM_REJECTED', false)
      return provider.valid(input)
    }
    await service.start(startInput('resume-job', 11))
    const failed = await service.waitForIdle('project-a', 'resume-job')
    expect(failed).toMatchObject({ state: 'failed', generation: 1, fulfilledCount: 10, errorCode: 'PROVIDER_FAILED' })
    expect(repository.batches.get('resume-job')).toHaveLength(1)

    await expect(service.resume('project-a', 'resume-job')).rejects.toMatchObject({ code: 'JOB_NOT_RESUMABLE' })
    repository.jobs.set('resume-job', { ...failed, state: 'interrupted', completedAt: null })
    provider.implementation = async (input) => provider.valid(input)
    const resumed = await service.resume('project-a', 'resume-job')
    expect(resumed.generation).toBe(2)
    const completed = await service.waitForIdle('project-a', 'resume-job')
    expect(completed).toMatchObject({ state: 'review_required', generation: 2, fulfilledCount: 11 })
    expect(provider.calls.map((call) => call.slots.length)).toEqual([10, 1, 1])
    expect(provider.calls[1]?.operationId).toBe(provider.calls[2]?.operationId)
    expect(provider.calls.map((call) => call.generation)).toEqual([1, 1, 2])
    await service.dispose()
  })

  it('turns a bounded provider timeout into a resumable failure', async () => {
    const wait = deferred<ProviderOutput>()
    const { provider, service } = fixture({ operationTimeoutMs: 5, maxAttempts: 1 })
    provider.implementation = async () => wait.promise
    await service.start(startInput('timeout-job', 1))
    await expect(service.waitForIdle('project-a', 'timeout-job')).resolves.toMatchObject({ state: 'failed', errorCode: 'TIMEOUT' })
    await service.dispose()
  })

  it('cancels an in-flight provider that ignores abort and rejects its late result', async () => {
    const late = deferred<ProviderOutput>()
    const { provider, repository, service } = fixture()
    provider.implementation = async () => late.promise
    await service.start(startInput('cancel-job', 1))
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    const cancelled = await service.cancel('project-a', 'cancel-job')
    expect(cancelled.state).toBe('cancelled')
    late.resolve(provider.valid(provider.calls[0]!))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(repository.batches.get('cancel-job')).toBeUndefined()
    await service.dispose()
  })

  it('does not let an abort-ignoring provider starve the next queued job', async () => {
    const late = deferred<ProviderOutput>()
    const { provider, repository, service } = fixture()
    provider.implementation = async (input, call) => call === 1 ? late.promise : provider.valid(input)
    await service.start(startInput('stuck-provider', 1))
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    await service.cancel('project-a', 'stuck-provider')
    await service.start(startInput('next-provider', 1))
    await expect(service.waitForIdle('project-a', 'next-provider')).resolves.toMatchObject({
      state: 'review_required', fulfilledCount: 1,
    })
    late.resolve(provider.valid(provider.calls[0]!))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(repository.batches.get('stuck-provider')).toBeUndefined()
    await service.dispose()
  })

  it('marks a job stale when the knowledge version changes before commit', async () => {
    const { knowledge, provider, repository, service } = fixture()
    provider.implementation = async (input) => {
      knowledge.fences.set('project-a', {
        projectId: 'project-a', knowledgeVersion: 4, projectDataRevision: 5,
        sourceManifestHash: 'b'.repeat(64), sourceCount: 1,
      })
      return provider.valid(input)
    }
    await service.start(startInput('stale-job', 1))
    await expect(service.waitForIdle('project-a', 'stale-job')).resolves.toMatchObject({ state: 'stale', errorCode: 'PROJECT_STALE' })
    expect(repository.batches.get('stale-job')).toBeUndefined()
    await service.dispose()
  })

  it('does not stale a running job when only embedding/index metadata advances', async () => {
    const { knowledge, provider, service } = fixture()
    provider.implementation = async (input) => {
      knowledge.fences.set('project-a', {
        ...input.fence,
        projectDataRevision: input.fence.projectDataRevision + 1,
      })
      return provider.valid(input)
    }
    await service.start(startInput('index-metadata-fence', 1))
    await expect(service.waitForIdle('project-a', 'index-metadata-fence')).resolves.toMatchObject({
      state: 'review_required', fulfilledCount: 1,
    })
    await service.dispose()
  })

  it('persists invalid citations as reviewable gaps instead of trusted answers', async () => {
    const { provider, repository, service } = fixture()
    provider.implementation = async (input) => {
      const valid = JSON.parse(provider.valid(input).rawJson) as { items: Array<{ sourceReferences: Array<{ chunkId: string }> }> }
      valid.items[0]!.sourceReferences[0]!.chunkId = 'forged-chunk'
      return { rawJson: JSON.stringify(valid) }
    }
    await service.start(startInput('citation-gap', 1))
    const job = await service.waitForIdle('project-a', 'citation-gap')
    expect(job).toMatchObject({ state: 'review_required', fulfilledCount: 0, gapCount: 1 })
    expect(repository.batches.get('citation-gap')?.[0]?.gaps[0]?.reason).toBe('invalid_citation')
    await service.dispose()
  })

  it('persists an excluded-topic match only as a gap and never as a draft item', async () => {
    const { repository, service } = fixture()
    await service.start({
      ...startInput('excluded-topic-gap', 1),
      brief: { ...BRIEF, excludedTopics: ['预 算'] },
    })
    const job = await service.waitForIdle('project-a', 'excluded-topic-gap')
    expect(job).toMatchObject({ state: 'review_required', fulfilledCount: 0, gapCount: 1 })
    expect(repository.batches.get('excluded-topic-gap')?.[0]).toMatchObject({
      items: [],
      gaps: [{ reason: 'excluded_topic' }],
    })
    await service.dispose()
  })

  it('isolates notification listener failures from durable progress', async () => {
    const { service } = fixture()
    const healthy = vi.fn()
    service.subscribe(() => { throw new Error('listener failure') })
    service.subscribe(healthy)
    await service.start(startInput('listener-job', 1))
    await expect(service.waitForIdle('project-a', 'listener-job')).resolves.toMatchObject({ state: 'review_required' })
    expect(healthy).toHaveBeenCalled()
    await service.dispose()
  })

  it('interrupts active work on disposal and refuses new work afterwards', async () => {
    const wait = deferred<ProviderOutput>()
    const { provider, service } = fixture()
    provider.implementation = async () => wait.promise
    await service.start(startInput('dispose-job', 1))
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    await service.dispose()
    await expect(service.getJob('project-a', 'dispose-job')).resolves.toMatchObject({ state: 'interrupted' })
    await expect(service.start(startInput('after-dispose', 1))).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
  })

  it('pauses active model work for a foreground session and resumes with a new generation', async () => {
    const wait = deferred<ProviderOutput>()
    const { provider, service } = fixture()
    provider.implementation = async () => wait.promise
    await service.start(startInput('foreground-preemption', 1))
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    await service.pauseActive()
    await expect(service.getJob('project-a', 'foreground-preemption')).resolves.toMatchObject({
      state: 'interrupted', generation: 1,
    })
    provider.implementation = async (input) => provider.valid(input)
    await expect(service.resume('project-a', 'foreground-preemption')).resolves.toMatchObject({
      generation: 2,
    })
    await expect(service.waitForIdle('project-a', 'foreground-preemption')).resolves.toMatchObject({
      state: 'review_required', generation: 2,
    })
    await service.dispose()
  })

  it('fails preflight before any cloud work when the project has no usable knowledge', async () => {
    const { knowledge, provider, service } = fixture()
    knowledge.fences.delete('project-a')
    await expect(service.preflight({ projectId: 'project-a', requestedCount: 30, brief: BRIEF })).rejects.toMatchObject({
      code: 'NO_KNOWLEDGE',
    })
    expect(provider.calls).toEqual([])
    await service.dispose()
  })
})
