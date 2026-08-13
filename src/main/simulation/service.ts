import { createHash, randomUUID } from 'node:crypto'
import { SimulationProviderError, SimulationWorkflowError } from './errors'
import {
  coverageBatches,
  createCoveragePlan,
  normalizeSimulationBrief,
  simulationBriefHash,
  simulationOperationId,
  validateRequestedCount,
} from './planner'
import {
  normalizeEvidenceBundles,
  parseProviderBatch,
  validateProviderBatch,
} from './validator'
import {
  SIMULATION_BATCH_SIZE,
  SIMULATION_LARGE_BATCH_THRESHOLD,
  SIMULATION_WORKFLOW_VERSION,
  type CommitSimulationBatchInput,
  type QaCoverageGap,
  type QaCoverageSlot,
  type QaSimulationErrorCode,
  type QaSimulationJobRecord,
  type QaSimulationJobState,
  type QaSimulationPreflight,
  type QaSlotEvidence,
  type SimulationKnowledgePort,
  type SimulationPreflightInput,
  type SimulationProjectFence,
  type SimulationProviderPort,
  type SimulationRepositoryPort,
  type SimulationTokenUsage,
  type StartSimulationInput,
} from './types'

const DEFAULT_OPERATION_TIMEOUT_MS = 45_000
const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_RETRY_DELAY_MS = 150
const DEFAULT_MAX_RAW_CHARACTERS = 100_000

const ACTIVE_STATES: readonly QaSimulationJobState[] = [
  'planning',
  'retrieving',
  'generating',
  'validating',
]
const RESUMABLE_STATES: readonly QaSimulationJobState[] = ['interrupted']

interface ActiveOperation {
  readonly projectId: string
  readonly generation: number
  readonly controller: AbortController
  readonly promise: Promise<void>
}

type JobListener = (job: QaSimulationJobRecord) => void

interface ServiceOptions {
  readonly repository: SimulationRepositoryPort
  readonly knowledge: SimulationKnowledgePort
  readonly provider: SimulationProviderPort
  readonly operationTimeoutMs?: number
  readonly maxAttempts?: number
  readonly retryDelayMs?: number
  readonly maxRawCharacters?: number
  readonly now?: () => number
  readonly jobIdFactory?: () => string
}

class SingleConcurrencyGate {
  #busy = false
  readonly #waiting: Array<{
    readonly signal: AbortSignal
    readonly resolve: (release: () => void) => void
    readonly reject: (error: SimulationWorkflowError) => void
    readonly onAbort: () => void
  }> = []

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.#acquire(signal)
    let rejectAbort: ((error: SimulationWorkflowError) => void) | null = null
    const onAbort = (): void => rejectAbort?.(new SimulationWorkflowError('CANCELLED', false))
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      // A non-cooperative provider must not retain the sole permit forever.
      // Generation fencing rejects its late result; conforming providers also
      // terminate their underlying HTTP request on the same AbortSignal.
      return await Promise.race([operation(), abortPromise])
    } finally {
      signal.removeEventListener('abort', onAbort)
      release()
    }
  }

  #acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new SimulationWorkflowError('CANCELLED', false))
    if (!this.#busy) {
      this.#busy = true
      return Promise.resolve(() => this.#release())
    }
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        resolve,
        reject,
        onAbort: (): void => {
          const index = this.#waiting.indexOf(entry)
          if (index >= 0) this.#waiting.splice(index, 1)
          reject(new SimulationWorkflowError('CANCELLED', false))
        },
      }
      signal.addEventListener('abort', entry.onAbort, { once: true })
      this.#waiting.push(entry)
    })
  }

  #release(): void {
    while (this.#waiting.length > 0) {
      const next = this.#waiting.shift()
      if (!next) break
      next.signal.removeEventListener('abort', next.onAbort)
      if (next.signal.aborted) continue
      next.resolve(() => this.#release())
      return
    }
    this.#busy = false
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function validatePositiveInteger(value: number, code: QaSimulationErrorCode): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new SimulationWorkflowError(code, false)
  return value
}

function validateJobId(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(normalized)) throw new SimulationWorkflowError('INVALID_INPUT', false)
  return normalized
}

function validateFence(fence: SimulationProjectFence): void {
  if (!fence.projectId.trim() || fence.projectId.length > 256 || /[\0\r\n]/u.test(fence.projectId)) {
    throw new SimulationWorkflowError('INVALID_INPUT', false)
  }
  validatePositiveInteger(fence.knowledgeVersion, 'INVALID_INPUT')
  if (!Number.isSafeInteger(fence.projectDataRevision) || fence.projectDataRevision < 0) {
    throw new SimulationWorkflowError('INVALID_INPUT', false)
  }
  if (!/^[a-f0-9]{64}$/u.test(fence.sourceManifestHash)) {
    throw new SimulationWorkflowError('INVALID_INPUT', false)
  }
  validatePositiveInteger(fence.sourceCount, 'INVALID_INPUT')
}

function sameFence(left: SimulationProjectFence, right: SimulationProjectFence): boolean {
  return left.projectId === right.projectId
    && left.knowledgeVersion === right.knowledgeVersion
    && left.sourceManifestHash === right.sourceManifestHash
    && left.sourceCount === right.sourceCount
}

function noEvidenceGap(slot: QaCoverageSlot): QaCoverageGap {
  return { slotId: slot.id, ordinal: slot.ordinal, topic: slot.topic, reason: 'no_evidence' }
}

function normalizedWorkflowError(error: unknown, fallback: QaSimulationErrorCode): SimulationWorkflowError {
  if (error instanceof SimulationWorkflowError) return error
  if (error instanceof SimulationProviderError) return new SimulationWorkflowError('PROVIDER_FAILED', error.retryable)
  return new SimulationWorkflowError(fallback, false)
}

export class QaSimulationService {
  readonly #repository: SimulationRepositoryPort
  readonly #knowledge: SimulationKnowledgePort
  readonly #provider: SimulationProviderPort
  readonly #operationTimeoutMs: number
  readonly #maxAttempts: number
  readonly #retryDelayMs: number
  readonly #maxRawCharacters: number
  readonly #now: () => number
  readonly #jobIdFactory: () => string
  readonly #providerGate = new SingleConcurrencyGate()
  readonly #active = new Map<string, ActiveOperation>()
  readonly #cancelRequested = new Set<string>()
  readonly #listeners = new Set<JobListener>()
  #disposed = false

  constructor(options: ServiceOptions) {
    this.#repository = options.repository
    this.#knowledge = options.knowledge
    this.#provider = options.provider
    this.#operationTimeoutMs = validatePositiveInteger(
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      'INVALID_INPUT',
    )
    this.#maxAttempts = validatePositiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'INVALID_INPUT')
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    if (!Number.isSafeInteger(this.#retryDelayMs) || this.#retryDelayMs < 0) {
      throw new SimulationWorkflowError('INVALID_INPUT', false)
    }
    this.#maxRawCharacters = validatePositiveInteger(
      options.maxRawCharacters ?? DEFAULT_MAX_RAW_CHARACTERS,
      'INVALID_INPUT',
    )
    this.#now = options.now ?? Date.now
    this.#jobIdFactory = options.jobIdFactory ?? (() => `sim_${randomUUID().replaceAll('-', '')}`)
  }

  async preflight(input: SimulationPreflightInput): Promise<QaSimulationPreflight> {
    this.#assertUsable()
    const requestedCount = validateRequestedCount(input.requestedCount)
    normalizeSimulationBrief(input.brief)
    if (!input.projectId.trim() || input.projectId.length > 256) {
      throw new SimulationWorkflowError('INVALID_INPUT', false)
    }
    const fence = await this.#knowledge.getProjectFence(input.projectId)
    if (fence === null || fence.knowledgeVersion < 1 || fence.sourceCount < 1) {
      throw new SimulationWorkflowError('NO_KNOWLEDGE', false)
    }
    validateFence(fence)
    const confirmationRequired = requestedCount > SIMULATION_LARGE_BATCH_THRESHOLD
    return {
      fence,
      requestedCount,
      estimatedBatches: Math.ceil(requestedCount / SIMULATION_BATCH_SIZE),
      confirmationRequired,
      warnings: confirmationRequired ? ['LARGE_BATCH_TIME', 'EVIDENCE_DILUTION'] : [],
    }
  }

  async start(input: StartSimulationInput): Promise<QaSimulationJobRecord> {
    this.#assertUsable()
    const requestedCount = validateRequestedCount(input.requestedCount)
    const brief = normalizeSimulationBrief(input.brief)
    validateFence(input.fence)
    if (requestedCount > SIMULATION_LARGE_BATCH_THRESHOLD && input.largeBatchAcknowledged !== true) {
      throw new SimulationWorkflowError('LARGE_BATCH_CONFIRMATION_REQUIRED', false)
    }
    await this.#assertFence(input.fence)
    const jobId = validateJobId(input.jobId ?? this.#jobIdFactory())
    const createdAt = this.#now()
    const job = await this.#repository.createJob({
      id: jobId,
      fence: input.fence,
      generation: 1,
      requestedCount,
      brief,
      briefHash: simulationBriefHash(brief),
      workflowVersion: SIMULATION_WORKFLOW_VERSION,
      createdAt,
      largeBatchAcknowledgedAt: input.largeBatchAcknowledged === true ? createdAt : null,
    })
    this.#emit(job)
    this.#launch(job)
    return job
  }

  getJob(projectId: string, jobId: string): Promise<QaSimulationJobRecord | null> {
    return this.#repository.getJob(projectId, validateJobId(jobId))
  }

  getLatestJob(projectId: string): Promise<QaSimulationJobRecord | null> {
    return this.#repository.getLatestJob(projectId)
  }

  subscribe(listener: JobListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async cancel(projectId: string, jobIdValue: string): Promise<QaSimulationJobRecord> {
    const jobId = validateJobId(jobIdValue)
    const job = await this.#requireJob(projectId, jobId)
    if (!ACTIVE_STATES.includes(job.state)) return job
    this.#cancelRequested.add(jobId)
    this.#emit({ ...job, state: 'cancel_requested', errorCode: 'CANCELLED' })
    this.#active.get(jobId)?.controller.abort()
    const operation = this.#active.get(jobId)
    if (operation) await operation.promise
    this.#cancelRequested.delete(jobId)
    return this.#requireJob(projectId, jobId)
  }

  async resume(projectId: string, jobIdValue: string): Promise<QaSimulationJobRecord> {
    this.#assertUsable()
    const jobId = validateJobId(jobIdValue)
    if (this.#active.has(jobId)) throw new SimulationWorkflowError('JOB_ACTIVE', false)
    const job = await this.#requireJob(projectId, jobId)
    if (!RESUMABLE_STATES.includes(job.state)) throw new SimulationWorkflowError('JOB_NOT_RESUMABLE', false)
    try {
      await this.#assertFence(job.fence)
    } catch (error) {
      const code = normalizedWorkflowError(error, 'PROJECT_STALE').code
      if (code !== 'PROJECT_STALE' && code !== 'NO_KNOWLEDGE') throw error
      return this.#transition(job, RESUMABLE_STATES, 'stale', 'PROJECT_STALE', this.#now())
    }
    const plan = await this.#repository.getCoveragePlan(projectId, job.id)
    const resumed = await this.#repository.advanceGeneration({
      projectId,
      jobId: job.id,
      expectedGeneration: job.generation,
      expectedStates: RESUMABLE_STATES,
      nextState: plan ? 'retrieving' : 'planning',
    })
    if (!resumed) throw new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
    this.#emit(resumed)
    this.#launch(resumed)
    return resumed
  }

  async waitForIdle(projectId: string, jobIdValue: string): Promise<QaSimulationJobRecord> {
    const jobId = validateJobId(jobIdValue)
    await this.#active.get(jobId)?.promise
    return this.#requireJob(projectId, jobId)
  }

  async pauseActive(): Promise<void> {
    const operations = [...this.#active.values()]
    for (const operation of operations) operation.controller.abort()
    await Promise.allSettled(operations.map((operation) => operation.promise))
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.pauseActive()
    this.#listeners.clear()
  }

  #launch(job: QaSimulationJobRecord): void {
    if (this.#active.has(job.id)) throw new SimulationWorkflowError('JOB_ACTIVE', false)
    const controller = new AbortController()
    const operation = this.#run(job, controller.signal)
      .catch(async (error: unknown) => {
        await this.#settleFailure(job.id, job.generation, error).catch(() => undefined)
      })
      .finally(() => {
        const active = this.#active.get(job.id)
        if (active?.promise === operation) this.#active.delete(job.id)
      })
    this.#active.set(job.id, {
      projectId: job.fence.projectId,
      generation: job.generation,
      controller,
      promise: operation,
    })
  }

  async #run(job: QaSimulationJobRecord, signal: AbortSignal): Promise<void> {
    let plan = await this.#repository.getCoveragePlan(job.fence.projectId, job.id)
    if (!plan) {
      await this.#assertRunnable(job.id, job.generation, signal)
      plan = createCoveragePlan(job.brief, job.requestedCount)
      await this.#repository.saveCoveragePlan({
        projectId: job.fence.projectId,
        jobId: job.id,
        generation: job.generation,
        plan,
      })
    }
    if (
      plan.workflowVersion !== SIMULATION_WORKFLOW_VERSION
      || plan.requestedCount !== job.requestedCount
      || plan.briefHash !== job.briefHash
    ) {
      throw new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
    }

    const completed = new Set((await this.#repository.listBatches(job.fence.projectId, job.id)).map((batch) => batch.operationId))
    const acceptedIdentities = new Set(await this.#repository.acceptedQuestionIdentities(job.fence.projectId, job.id))
    const batches = coverageBatches(plan)
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const slots = batches[batchIndex] as readonly QaCoverageSlot[]
      const operationId = simulationOperationId({
        jobId: job.id,
        fence: job.fence,
        briefHash: job.briefHash,
        batchIndex,
        slotIds: slots.map((slot) => slot.id),
      })
      if (completed.has(operationId)) continue

      await this.#assertRunnable(job.id, job.generation, signal)
      await this.#move(job.id, job.generation, 'retrieving')
      const evidence = normalizeEvidenceBundles(
        await this.#withRetry(
          signal,
          'EVIDENCE_FAILED',
          (attemptSignal) => this.#knowledge.retrieveEvidence({
            fence: job.fence,
            brief: job.brief,
            slots,
            signal: attemptSignal,
          }),
        ),
        slots,
        job.fence,
      )
      const bySlot = new Map(evidence.map((bundle) => [bundle.slotId, bundle]))
      const answerableSlots = slots.filter((slot) => (bySlot.get(slot.id)?.evidence.length ?? 0) > 0)
      const noEvidenceGaps = slots.filter((slot) => !answerableSlots.includes(slot)).map(noEvidenceGap)

      let items: CommitSimulationBatchInput['items'] = []
      let gaps: readonly QaCoverageGap[] = noEvidenceGaps
      let usage: SimulationTokenUsage | null = null
      let payloadHash = sha256(JSON.stringify(noEvidenceGaps))

      if (answerableSlots.length > 0) {
        await this.#move(job.id, job.generation, 'generating')
        const generated = await this.#generateBatchWithRetry({
          job,
          operationId,
          slots: answerableSlots,
          evidence: answerableSlots.map((slot) => bySlot.get(slot.id) as NonNullable<ReturnType<typeof bySlot.get>>),
          signal,
        })
        await this.#move(job.id, job.generation, 'validating')
        const validated = validateProviderBatch({
          providerItems: generated.providerItems,
          slots: answerableSlots,
          evidence: generated.evidence,
          existingQuestionIdentities: acceptedIdentities,
          excludedTopics: job.brief.excludedTopics,
        })
        items = validated.items
        gaps = [...noEvidenceGaps, ...validated.gaps]
        usage = generated.usage
        payloadHash = sha256(generated.rawJson)
        for (const identity of validated.acceptedIdentities) acceptedIdentities.add(identity)
      }

      await this.#assertRunnable(job.id, job.generation, signal)
      const currentFence = await this.#knowledge.getProjectFence(job.fence.projectId)
      if (currentFence === null || !sameFence(currentFence, job.fence)) {
        throw new SimulationWorkflowError('PROJECT_STALE', false)
      }
      const committed = await this.#repository.commitBatch({
        projectId: job.fence.projectId,
        jobId: job.id,
        generation: job.generation,
        batchIndex,
        operationId,
        slotIds: slots.map((slot) => slot.id),
        items,
        gaps,
        payloadHash,
        usage,
        committedAt: this.#now(),
      })
      this.#emit(committed.job)
    }

    const current = await this.#assertRunnable(job.id, job.generation, signal)
    await this.#transition(current, ACTIVE_STATES, 'review_required')
  }

  async #generateBatchWithRetry(input: {
    readonly job: QaSimulationJobRecord
    readonly operationId: string
    readonly slots: readonly QaCoverageSlot[]
    readonly evidence: readonly QaSlotEvidence[]
    readonly signal: AbortSignal
  }): Promise<{
    readonly rawJson: string
    readonly providerItems: ReturnType<typeof parseProviderBatch>
    readonly evidence: readonly QaSlotEvidence[]
    readonly usage: SimulationTokenUsage | null
  }> {
    return this.#withRetry(input.signal, 'PROVIDER_FAILED', async (attemptSignal) => (
      this.#providerGate.run(attemptSignal, async () => {
        const result = await this.#provider.generateBatch({
          operationId: input.operationId,
          generation: input.job.generation,
          fence: input.job.fence,
          brief: input.job.brief,
          slots: input.slots,
          evidence: input.evidence,
          signal: attemptSignal,
        })
        if (result.rawJson.length > this.#maxRawCharacters) {
          throw new SimulationWorkflowError('OUTPUT_TOO_LARGE', false)
        }
        return {
          rawJson: result.rawJson,
          providerItems: parseProviderBatch(result.rawJson),
          evidence: input.evidence,
          usage: result.usage ?? null,
        }
      })
    ))
  }

  async #withRetry<T>(
    signal: AbortSignal,
    fallback: QaSimulationErrorCode,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let lastError = new SimulationWorkflowError(fallback, false)
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        return await this.#withTimeout(signal, operation)
      } catch (error) {
        if (signal.aborted) throw new SimulationWorkflowError('CANCELLED', false)
        lastError = normalizedWorkflowError(error, fallback)
        if (!lastError.retryable || attempt === this.#maxAttempts) throw lastError
        await this.#delay(signal, this.#retryDelayMs)
      }
    }
    throw lastError
  }

  async #withTimeout<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) throw new SimulationWorkflowError('CANCELLED', false)
    const controller = new AbortController()
    let rejectAbort: ((error: SimulationWorkflowError) => void) | null = null
    const onAbort = (): void => {
      controller.abort()
      rejectAbort?.(new SimulationWorkflowError('CANCELLED', false))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new SimulationWorkflowError('TIMEOUT', true))
      }, this.#operationTimeoutMs)
    })
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
      if (signal.aborted) onAbort()
    })
    try {
      return await Promise.race([operation(controller.signal), timeoutPromise, abortPromise])
    } finally {
      if (timeout) clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }

  #delay(signal: AbortSignal, durationMs: number): Promise<void> {
    if (signal.aborted) return Promise.reject(new SimulationWorkflowError('CANCELLED', false))
    if (durationMs === 0) return signal.aborted
      ? Promise.reject(new SimulationWorkflowError('CANCELLED', false))
      : Promise.resolve()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, durationMs)
      const onAbort = (): void => {
        clearTimeout(timeout)
        reject(new SimulationWorkflowError('CANCELLED', false))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async #assertRunnable(jobId: string, generation: number, signal: AbortSignal): Promise<QaSimulationJobRecord> {
    if (signal.aborted) throw new SimulationWorkflowError('CANCELLED', false)
    const projectId = this.#findActiveProject(jobId, generation)
    const job = await this.#requireJob(projectId, jobId)
    if (job.generation !== generation || !ACTIVE_STATES.includes(job.state)) {
      throw new SimulationWorkflowError('SUPERSEDED', false)
    }
    await this.#assertFence(job.fence)
    return job
  }

  async #assertFence(expected: SimulationProjectFence): Promise<void> {
    const current = await this.#knowledge.getProjectFence(expected.projectId)
    if (current === null || current.knowledgeVersion < 1 || current.sourceCount < 1) {
      throw new SimulationWorkflowError('NO_KNOWLEDGE', false)
    }
    if (!sameFence(current, expected)) throw new SimulationWorkflowError('PROJECT_STALE', false)
  }

  async #move(jobId: string, generation: number, nextState: 'retrieving' | 'generating' | 'validating'): Promise<QaSimulationJobRecord> {
    const job = await this.#requireJob(this.#findActiveProject(jobId, generation), jobId)
    if (job.generation !== generation) throw new SimulationWorkflowError('SUPERSEDED', false)
    if (job.state === nextState) return job
    return this.#transition(job, ACTIVE_STATES, nextState)
  }

  async #transition(
    job: QaSimulationJobRecord,
    expectedStates: readonly QaSimulationJobState[],
    nextState: QaSimulationJobState,
    errorCode?: QaSimulationErrorCode | null,
    completedAt?: number | null,
  ): Promise<QaSimulationJobRecord> {
    const transitioned = await this.#repository.transition({
      projectId: job.fence.projectId,
      jobId: job.id,
      expectedGeneration: job.generation,
      expectedStates,
      nextState,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(completedAt === undefined ? {} : { completedAt }),
    })
    if (!transitioned) throw new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
    this.#emit(transitioned)
    return transitioned
  }

  async #settleFailure(jobId: string, generation: number, error: unknown): Promise<void> {
    const projectId = this.#findActiveProject(jobId, generation)
    const job = await this.#repository.getJob(projectId, jobId)
    if (!job || job.generation !== generation || ![...ACTIVE_STATES, 'cancel_requested'].includes(job.state)) return
    const normalized = normalizedWorkflowError(error, 'PROVIDER_FAILED')
    if (this.#cancelRequested.has(jobId)) {
      await this.#transition(job, ACTIVE_STATES, 'cancelled', 'CANCELLED', this.#now())
      return
    }
    if (this.#disposed || normalized.code === 'CANCELLED') {
      await this.#transition(job, ACTIVE_STATES, 'interrupted', 'CANCELLED')
      return
    }
    if (normalized.code === 'PROJECT_STALE' || normalized.code === 'NO_KNOWLEDGE') {
      await this.#transition(job, ACTIVE_STATES, 'stale', 'PROJECT_STALE', this.#now())
      return
    }
    await this.#transition(job, ACTIVE_STATES, 'failed', normalized.code, this.#now())
  }

  async #requireJob(projectId: string, jobId: string): Promise<QaSimulationJobRecord> {
    const job = await this.#repository.getJob(projectId, jobId)
    if (!job) throw new SimulationWorkflowError('JOB_NOT_FOUND', false)
    return job
  }

  #findActiveProject(jobId: string, generation: number): string {
    const active = this.#active.get(jobId)
    if (active?.generation !== generation) throw new SimulationWorkflowError('SUPERSEDED', false)
    // Active operations are launched from a durable job. The project is kept
    // in a private map to avoid ever resolving a job across project scopes.
    return active.projectId
  }

  #emit(job: QaSimulationJobRecord): void {
    for (const listener of this.#listeners) {
      try { listener(job) } catch { /* SQLite remains canonical; notifications are best effort. */ }
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new SimulationWorkflowError('SERVICE_DISPOSED', false)
  }
}
