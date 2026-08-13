import { createHash } from 'node:crypto'
import type {
  CommitSimulationBatchInput as DataCommitSimulationBatchInput,
  CreateSimulationJobInput as DataCreateSimulationJobInput,
  SimulationBatchCommitResult as DataSimulationBatchCommitResult,
  SimulationEvidenceHit,
  SimulationItemPage,
  SimulationJobPage,
  SimulationJobRecord as DataSimulationJobRecord,
  SimulationJobStatus,
  SimulationProjectFence as DataSimulationProjectFence,
  TransitionSimulationJobInput as DataTransitionSimulationJobInput,
  UpdateSimulationItemInput,
  UpdateSimulationItemResult,
} from '../data/types'
import { SimulationWorkflowError } from './errors'
import {
  coverageBatches,
  createCoveragePlan,
  simulationBriefHash,
  simulationOperationId,
} from './planner'
import { normalizeGeneratedQuestion } from './validator'
import {
  SIMULATION_WORKFLOW_VERSION,
  type CommitSimulationBatchInput,
  type CreateSimulationJobInput,
  type QaCoverageGap,
  type QaCoveragePlan,
  type QaSimulationBatchRecord,
  type QaSimulationBrief,
  type QaSimulationErrorCode,
  type QaSimulationJobRecord,
  type QaSimulationJobState,
  type QaSlotEvidence,
  type SimulationKnowledgePort,
  type SimulationProjectFence,
  type SimulationRepositoryPort,
} from './types'

const ACTIVE_STATES: readonly QaSimulationJobState[] = [
  'planning',
  'retrieving',
  'generating',
  'validating',
]
const RESULT_PAGE_SIZE = 100
const EVIDENCE_PER_SLOT = 4
const MAX_DURABLE_CITATION_CHARACTERS = 1_600

export interface SimulationDataStorePort {
  getProjectSimulationFence(projectId: string): DataSimulationProjectFence
  searchProjectSimulationEvidence(input: {
    readonly projectId: string
    readonly knowledgeVersion: number
    readonly sourceManifestHash?: string
    readonly query: string
    readonly limit?: number
  }): readonly SimulationEvidenceHit[]
  createSimulationJob(input: DataCreateSimulationJobInput): {
    readonly job: DataSimulationJobRecord
    readonly inserted: boolean
  }
  getSimulationJob(projectId: string, jobId: string): DataSimulationJobRecord | null
  getLatestSimulationJob(projectId: string): DataSimulationJobRecord | null
  getSimulationJobPage(input: {
    readonly projectId: string
    readonly cursor?: string | null
    readonly limit?: number
    readonly expectedDataRevision?: number
  }): SimulationJobPage
  updateSimulationItem(input: UpdateSimulationItemInput): UpdateSimulationItemResult
  transitionSimulationJob(input: DataTransitionSimulationJobInput): {
    readonly job: DataSimulationJobRecord
    readonly inserted: boolean
  }
  commitSimulationBatch(input: DataCommitSimulationBatchInput): DataSimulationBatchCommitResult
  getSimulationItemPage(input: {
    readonly projectId: string
    readonly jobId: string
    readonly cursor?: string | null
    readonly limit?: number
    readonly expectedDataRevision?: number
  }): SimulationItemPage
}

function digest(...parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\0')
  return hash.digest('hex')
}

function operationId(kind: string, ...parts: readonly string[]): string {
  return `sim_${kind}_${digest(kind, ...parts).slice(0, 32)}`
}

function fenceFromData(job: DataSimulationJobRecord): SimulationProjectFence {
  return {
    projectId: job.projectId,
    knowledgeVersion: job.knowledgeVersion,
    projectDataRevision: job.projectDataRevision,
    sourceManifestHash: job.sourceManifestHash,
    sourceCount: job.sourceCount,
  }
}

function briefFromData(job: DataSimulationJobRecord): QaSimulationBrief {
  if (!['concise', 'standard', 'detailed'].includes(job.brief.answerStyle)) {
    throw new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
  }
  return {
    ...job.brief,
    answerStyle: job.brief.answerStyle as QaSimulationBrief['answerStyle'],
  }
}

function stateFromData(status: SimulationJobStatus): QaSimulationJobState {
  switch (status) {
    case 'draft':
    case 'awaiting_large_run_confirmation':
    case 'queued': return 'planning'
    case 'running': return 'generating'
    case 'paused': return 'interrupted'
    case 'completed':
    case 'completed_with_gaps': return 'review_required'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'stale': return 'stale'
  }
}

function jobFromData(job: DataSimulationJobRecord, state = stateFromData(job.status)): QaSimulationJobRecord {
  const brief = briefFromData(job)
  return {
    id: job.jobId,
    fence: fenceFromData(job),
    generation: job.generation,
    requestedCount: job.targetCount,
    fulfilledCount: job.reliableCount,
    gapCount: job.gapCount,
    approvedCount: job.approvedCount,
    publishedCount: job.publishedCount,
    brief,
    briefHash: simulationBriefHash(brief),
    workflowVersion: SIMULATION_WORKFLOW_VERSION,
    state,
    errorCode: job.errorCode as QaSimulationErrorCode | null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    dataRevision: job.dataRevision,
    nextBatchOrdinal: job.nextBatchOrdinal,
  }
}

function repositoryError(error: unknown): SimulationWorkflowError {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('SIMULATION_KNOWLEDGE_STALE')) {
    return new SimulationWorkflowError('PROJECT_STALE', false)
  }
  if (message.includes('SIMULATION_CAS_MISMATCH') || message.includes('conflict')) {
    return new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
  }
  return new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
}

function gapReason(reason: QaCoverageGap['reason']): DataCommitSimulationBatchInput['gaps'][number]['reason'] {
  switch (reason) {
    case 'no_evidence': return 'NO_RELEVANT_EVIDENCE'
    case 'provider_omission': return 'INSUFFICIENT_DETAIL'
    case 'invalid_citation':
    case 'unsupported_claim': return 'UNSUPPORTED_OR_UNCONVERTED_SOURCE'
    case 'excluded_topic': return 'INSUFFICIENT_DETAIL'
    case 'duplicate_question': return 'DUPLICATE_COVERAGE_ONLY'
  }
}

function suggestedMaterial(gap: QaCoverageGap): string {
  switch (gap.reason) {
    case 'no_evidence': return `补充与“${gap.topic}”直接相关且可引用的项目资料。`
    case 'provider_omission': return `补充“${gap.topic}”的背景、结论和事实细节。`
    case 'invalid_citation': return `检查“${gap.topic}”资料的引用与转换完整性。`
    case 'unsupported_claim': return `补充支持“${gap.topic}”主体、数字和指标的明确证据。`
    case 'excluded_topic': return `“${gap.topic}”命中了禁答主题；如需覆盖，请先修改模拟问答设置。`
    case 'duplicate_question': return `补充“${gap.topic}”的不同事实维度以扩展覆盖。`
  }
}

export class DataStoreSimulationRepository implements SimulationRepositoryPort {
  readonly #store: SimulationDataStorePort

  constructor(store: SimulationDataStorePort) {
    this.#store = store
  }

  async createJob(input: CreateSimulationJobInput): Promise<QaSimulationJobRecord> {
    const createOperationId = operationId(
      'create',
      input.id,
      input.fence.projectId,
      String(input.fence.knowledgeVersion),
      String(input.fence.projectDataRevision),
      input.fence.sourceManifestHash,
      String(input.requestedCount),
      input.briefHash,
      String(input.largeBatchAcknowledgedAt !== null),
    )
    try {
      let data = this.#store.createSimulationJob({
        operationId: createOperationId,
        jobId: input.id,
        projectId: input.fence.projectId,
        fence: input.fence,
        targetCount: input.requestedCount,
        brief: input.brief,
        largeRunAcknowledgedAt: input.largeBatchAcknowledgedAt,
      }).job
      if (data.status === 'awaiting_large_run_confirmation') {
        throw new SimulationWorkflowError('LARGE_BATCH_CONFIRMATION_REQUIRED', false)
      }
      if (data.status === 'draft') data = this.#transitionData(data, 'queued')
      if (data.status === 'queued') data = this.#transitionData(data, 'running')
      if (data.status !== 'running') throw new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
      return jobFromData(data, 'planning')
    } catch (error) {
      if (error instanceof SimulationWorkflowError) throw error
      throw repositoryError(error)
    }
  }

  async getJob(projectId: string, jobId: string): Promise<QaSimulationJobRecord | null> {
    const job = this.#store.getSimulationJob(projectId, jobId)
    return job ? jobFromData(job) : null
  }

  async getLatestJob(projectId: string): Promise<QaSimulationJobRecord | null> {
    const job = this.#store.getLatestSimulationJob(projectId)
    return job ? jobFromData(job) : null
  }

  async transition(input: {
    readonly projectId: string
    readonly jobId: string
    readonly expectedGeneration: number
    readonly expectedStates: readonly QaSimulationJobState[]
    readonly nextState: QaSimulationJobState
    readonly errorCode?: QaSimulationErrorCode | null
    readonly completedAt?: number | null
  }): Promise<QaSimulationJobRecord | null> {
    const current = this.#store.getSimulationJob(input.projectId, input.jobId)
    if (!current || current.generation !== input.expectedGeneration) return null
    const projected = stateFromData(current.status)
    const activeExpected = current.status === 'running' && input.expectedStates.some((state) => ACTIVE_STATES.includes(state))
    if (!input.expectedStates.includes(projected) && !activeExpected) return null
    if (input.nextState === 'retrieving' || input.nextState === 'generating' || input.nextState === 'validating') {
      if (current.status !== 'running') return null
      return jobFromData(current, input.nextState)
    }
    let nextStatus: SimulationJobStatus
    switch (input.nextState) {
      case 'review_required':
        nextStatus = current.gapCount === 0 && current.reliableCount === current.targetCount
          ? 'completed'
          : 'completed_with_gaps'
        break
      case 'interrupted': nextStatus = 'paused'; break
      case 'cancelled': nextStatus = 'cancelled'; break
      case 'failed': nextStatus = 'failed'; break
      case 'stale': nextStatus = 'stale'; break
      default: return null
    }
    try {
      return jobFromData(this.#transitionData(current, nextStatus, input.errorCode ?? null), input.nextState)
    } catch (error) {
      if (error instanceof SimulationWorkflowError) throw error
      throw repositoryError(error)
    }
  }

  async advanceGeneration(input: {
    readonly projectId: string
    readonly jobId: string
    readonly expectedGeneration: number
    readonly expectedStates: readonly QaSimulationJobState[]
    readonly nextState: 'planning' | 'retrieving'
  }): Promise<QaSimulationJobRecord | null> {
    const current = this.#store.getSimulationJob(input.projectId, input.jobId)
    if (
      !current || current.status !== 'paused' || current.generation !== input.expectedGeneration ||
      !input.expectedStates.includes('interrupted')
    ) return null
    try {
      const resumed = this.#transitionData(current, 'running')
      if (resumed.generation !== current.generation + 1) {
        throw new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
      }
      return jobFromData(resumed, input.nextState)
    } catch (error) {
      if (error instanceof SimulationWorkflowError) throw error
      throw repositoryError(error)
    }
  }

  async saveCoveragePlan(input: {
    readonly projectId: string
    readonly jobId: string
    readonly generation: number
    readonly plan: QaCoveragePlan
  }): Promise<void> {
    const current = this.#store.getSimulationJob(input.projectId, input.jobId)
    if (!current || current.generation !== input.generation || current.status !== 'running') {
      throw new SimulationWorkflowError('SUPERSEDED', false)
    }
    const deterministic = createCoveragePlan(briefFromData(current), current.targetCount)
    if (deterministic.planHash !== input.plan.planHash) {
      throw new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
    }
  }

  async getCoveragePlan(projectId: string, jobId: string): Promise<QaCoveragePlan | null> {
    const current = this.#store.getSimulationJob(projectId, jobId)
    return current ? createCoveragePlan(briefFromData(current), current.targetCount) : null
  }

  async listBatches(projectId: string, jobId: string): Promise<readonly QaSimulationBatchRecord[]> {
    const current = this.#store.getSimulationJob(projectId, jobId)
    if (!current) return []
    const brief = briefFromData(current)
    const plan = createCoveragePlan(brief, current.targetCount)
    return coverageBatches(plan).slice(0, current.nextBatchOrdinal).map((slots, batchIndex) => ({
      jobId,
      generation: current.generation,
      batchIndex,
      operationId: simulationOperationId({
        jobId,
        fence: fenceFromData(current),
        briefHash: simulationBriefHash(brief),
        batchIndex,
        slotIds: slots.map((slot) => slot.id),
      }),
      slotIds: slots.map((slot) => slot.id),
      items: [],
      gaps: [],
      payloadHash: '0'.repeat(64),
      usage: null,
      committedAt: current.updatedAt,
    }))
  }

  async acceptedQuestionIdentities(projectId: string, jobId: string): Promise<readonly string[]> {
    const current = this.#store.getSimulationJob(projectId, jobId)
    if (!current) return []
    let cursor: string | null = null
    const identities: string[] = []
    do {
      const page = this.#store.getSimulationItemPage({
        projectId,
        jobId,
        cursor,
        limit: RESULT_PAGE_SIZE,
        expectedDataRevision: current.dataRevision,
      })
      identities.push(...page.items.map((item) => normalizeGeneratedQuestion(item.question)))
      cursor = page.nextCursor
    } while (cursor)
    return identities
  }

  async commitBatch(input: CommitSimulationBatchInput): Promise<{
    readonly inserted: boolean
    readonly job: QaSimulationJobRecord
  }> {
    const current = this.#store.getSimulationJob(input.projectId, input.jobId)
    if (!current || current.generation !== input.generation || current.status !== 'running') {
      throw new SimulationWorkflowError('SUPERSEDED', false)
    }
    const plan = createCoveragePlan(briefFromData(current), current.targetCount)
    const topics = new Map(plan.slots.map((slot) => [slot.id, slot.topic]))
    try {
      const result = this.#store.commitSimulationBatch({
        operationId: input.operationId,
        projectId: input.projectId,
        jobId: input.jobId,
        expectedGeneration: input.generation,
        expectedDataRevision: current.dataRevision,
        plannedCount: input.slotIds.length,
        items: input.items.map((item) => ({
          question: item.question,
          answer: item.answer,
          category: topics.get(item.slotId) ?? null,
          citations: item.citations.map((citation) => ({
            chunkId: citation.chunkId,
            documentId: citation.documentId,
            sourceId: citation.sourceId,
            sourceRevisionId: citation.sourceRevisionId,
            contentHash: citation.contentHash,
            excerpt: citation.excerpt,
          })),
        })),
        gaps: input.gaps.map((gap) => ({
          topic: gap.topic,
          reason: gapReason(gap.reason),
          missingCount: 1,
          suggestedMaterial: suggestedMaterial(gap),
          checkedSourceCount: current.sourceCount,
        })),
      })
      return { inserted: result.inserted, job: jobFromData(result.job) }
    } catch (error) {
      if (error instanceof SimulationWorkflowError) throw error
      throw repositoryError(error)
    }
  }

  #transitionData(
    current: DataSimulationJobRecord,
    nextStatus: SimulationJobStatus,
    errorCode: string | null = null,
  ): DataSimulationJobRecord {
    return this.#store.transitionSimulationJob({
      operationId: operationId(
        'status',
        current.projectId,
        current.jobId,
        String(current.generation),
        String(current.dataRevision),
        current.status,
        nextStatus,
      ),
      projectId: current.projectId,
      jobId: current.jobId,
      expectedStatus: current.status,
      expectedGeneration: current.generation,
      expectedDataRevision: current.dataRevision,
      nextStatus,
      errorCode,
    }).job
  }
}

export class DataStoreSimulationKnowledge implements SimulationKnowledgePort {
  readonly #store: Pick<SimulationDataStorePort, 'getProjectSimulationFence' | 'searchProjectSimulationEvidence'>

  constructor(store: Pick<SimulationDataStorePort, 'getProjectSimulationFence' | 'searchProjectSimulationEvidence'>) {
    this.#store = store
  }

  async getProjectFence(projectId: string): Promise<SimulationProjectFence | null> {
    try {
      return this.#store.getProjectSimulationFence(projectId)
    } catch {
      return null
    }
  }

  async retrieveEvidence(input: Parameters<SimulationKnowledgePort['retrieveEvidence']>[0]): Promise<readonly QaSlotEvidence[]> {
    const result: QaSlotEvidence[] = []
    for (const slot of input.slots) {
      if (input.signal.aborted) throw new SimulationWorkflowError('CANCELLED', false)
      try {
        const hits = this.#store.searchProjectSimulationEvidence({
          projectId: input.fence.projectId,
          knowledgeVersion: input.fence.knowledgeVersion,
          sourceManifestHash: input.fence.sourceManifestHash,
          query: slot.topic,
          limit: EVIDENCE_PER_SLOT,
        })
        result.push({
          slotId: slot.id,
          evidence: hits.map((hit) => ({
            projectId: input.fence.projectId,
            knowledgeVersion: input.fence.knowledgeVersion,
            projectDataRevision: input.fence.projectDataRevision,
            sourceManifestHash: input.fence.sourceManifestHash,
            reference: {
              sourceId: hit.sourceId,
              sourceRevisionId: hit.sourceRevisionId,
              documentId: hit.documentId,
              chunkId: hit.chunkId,
              contentHash: hit.contentHash,
            },
            title: hit.title,
            // DataStore accepts only a canonical substring up to 1,600 chars
            // as the durable citation preview. The model and validator see
            // exactly that same bounded evidence, so accepted claims cannot
            // rely on text omitted from the persisted citation.
            excerpt: hit.excerpt.slice(0, MAX_DURABLE_CITATION_CHARACTERS).trim(),
          })),
        })
      } catch (error) {
        if (input.signal.aborted) throw new SimulationWorkflowError('CANCELLED', false)
        const message = error instanceof Error ? error.message : ''
        if (message.includes('SIMULATION_KNOWLEDGE_STALE')) {
          throw new SimulationWorkflowError('PROJECT_STALE', false)
        }
        throw new SimulationWorkflowError('EVIDENCE_FAILED', true)
      }
    }
    return result
  }
}
