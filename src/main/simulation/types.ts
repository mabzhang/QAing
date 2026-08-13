export const SIMULATION_WORKFLOW_VERSION = 'qaing-controlled-workflow-v1'
export const SIMULATION_BATCH_SIZE = 10
export const SIMULATION_LARGE_BATCH_THRESHOLD = 40
/**
 * Workflow v1 materializes the deterministic coverage plan in memory. This is
 * an implementation safety boundary, not the product's 40-item confirmation
 * threshold: ordinary large runs (including 50+) remain supported, while an
 * adversarial safe integer cannot force a multi-terabyte Array allocation.
 */
export const SIMULATION_MATERIALIZED_SLOT_LIMIT = 10_000

export type QaSimulationAnswerStyle = 'concise' | 'standard' | 'detailed'

export interface QaSimulationBrief {
  readonly intervieweeIdentity: string
  readonly audience: string
  readonly focusTopics: readonly string[]
  readonly scenario: string
  readonly answerStyle: QaSimulationAnswerStyle
  readonly excludedTopics: readonly string[]
}

export interface SimulationProjectFence {
  readonly projectId: string
  readonly knowledgeVersion: number
  readonly projectDataRevision: number
  readonly sourceManifestHash: string
  readonly sourceCount: number
}

export type QaSimulationPreflightWarning = 'LARGE_BATCH_TIME' | 'EVIDENCE_DILUTION'

export interface QaSimulationPreflight {
  readonly fence: SimulationProjectFence
  readonly requestedCount: number
  readonly estimatedBatches: number
  readonly confirmationRequired: boolean
  readonly warnings: readonly QaSimulationPreflightWarning[]
}

export type QaCoverageLens =
  | 'overview'
  | 'value'
  | 'evidence'
  | 'implementation'
  | 'metrics'
  | 'risk'
  | 'challenge'
  | 'comparison'
  | 'timeline'
  | 'responsibility'

export interface QaCoverageSlot {
  readonly id: string
  readonly ordinal: number
  readonly topic: string
  readonly lens: QaCoverageLens
  readonly intent: string
}

export interface QaCoveragePlan {
  readonly workflowVersion: typeof SIMULATION_WORKFLOW_VERSION
  readonly requestedCount: number
  readonly briefHash: string
  readonly planHash: string
  readonly slots: readonly QaCoverageSlot[]
}

export interface SimulationSourceReference {
  readonly sourceId: string | null
  readonly sourceRevisionId: string | null
  readonly documentId: string
  readonly chunkId: string
  readonly contentHash: string
}

export interface SimulationEvidence {
  readonly projectId: string
  readonly knowledgeVersion: number
  readonly projectDataRevision: number
  readonly sourceManifestHash: string
  readonly reference: SimulationSourceReference
  readonly title: string
  /** Private model context. It must never be written to logs or renderer snapshots. */
  readonly excerpt: string
}

export interface SimulationCitation extends SimulationSourceReference {
  readonly excerpt: string
}

export interface QaSlotEvidence {
  readonly slotId: string
  readonly evidence: readonly SimulationEvidence[]
}

export interface QaSimulationItem {
  readonly slotId: string
  readonly ordinal: number
  readonly question: string
  readonly questionIdentity: string
  readonly answer: string
  readonly sourceReferences: readonly SimulationSourceReference[]
}

export interface QaSimulationCommittedItem extends QaSimulationItem {
  /** Durable citation preview; never emitted through high-frequency state snapshots. */
  readonly citations: readonly SimulationCitation[]
}

export type QaCoverageGapReason =
  | 'no_evidence'
  | 'provider_omission'
  | 'invalid_citation'
  | 'unsupported_claim'
  | 'excluded_topic'
  | 'duplicate_question'

export interface QaCoverageGap {
  readonly slotId: string
  readonly ordinal: number
  readonly topic: string
  readonly reason: QaCoverageGapReason
}

export interface SimulationTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export type QaSimulationJobState =
  | 'planning'
  | 'retrieving'
  | 'generating'
  | 'validating'
  | 'review_required'
  | 'publishing'
  | 'completed'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted'
  | 'stale'
  | 'failed'

export type QaSimulationErrorCode =
  | 'INVALID_INPUT'
  | 'NO_KNOWLEDGE'
  | 'LARGE_BATCH_CONFIRMATION_REQUIRED'
  | 'PROJECT_STALE'
  | 'JOB_NOT_FOUND'
  | 'JOB_ACTIVE'
  | 'JOB_NOT_RESUMABLE'
  | 'SUPERSEDED'
  | 'TIMEOUT'
  | 'EVIDENCE_FAILED'
  | 'PROVIDER_FAILED'
  | 'INVALID_RESPONSE'
  | 'OUTPUT_TOO_LARGE'
  | 'CAPACITY_EXCEEDED'
  | 'REPOSITORY_CONFLICT'
  | 'CANCELLED'
  | 'SERVICE_DISPOSED'

export interface QaSimulationJobRecord {
  readonly id: string
  readonly fence: SimulationProjectFence
  readonly generation: number
  readonly requestedCount: number
  readonly fulfilledCount: number
  readonly gapCount: number
  readonly approvedCount: number
  readonly publishedCount: number
  readonly brief: QaSimulationBrief
  readonly briefHash: string
  readonly workflowVersion: typeof SIMULATION_WORKFLOW_VERSION
  readonly state: QaSimulationJobState
  readonly errorCode: QaSimulationErrorCode | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt: number | null
  readonly dataRevision: number
  readonly nextBatchOrdinal: number
}

export interface QaSimulationBatchRecord {
  readonly jobId: string
  readonly generation: number
  readonly batchIndex: number
  readonly operationId: string
  readonly slotIds: readonly string[]
  readonly items: readonly QaSimulationCommittedItem[]
  readonly gaps: readonly QaCoverageGap[]
  readonly payloadHash: string
  readonly usage: SimulationTokenUsage | null
  readonly committedAt: number
}

export interface CreateSimulationJobInput {
  readonly id: string
  readonly fence: SimulationProjectFence
  readonly generation: number
  readonly requestedCount: number
  readonly brief: QaSimulationBrief
  readonly briefHash: string
  readonly workflowVersion: typeof SIMULATION_WORKFLOW_VERSION
  readonly createdAt: number
  readonly largeBatchAcknowledgedAt: number | null
}

export interface CommitSimulationBatchInput {
  readonly projectId: string
  readonly jobId: string
  readonly generation: number
  readonly batchIndex: number
  readonly operationId: string
  readonly slotIds: readonly string[]
  readonly items: readonly QaSimulationCommittedItem[]
  readonly gaps: readonly QaCoverageGap[]
  readonly payloadHash: string
  readonly usage: SimulationTokenUsage | null
  readonly committedAt: number
}

export interface SimulationKnowledgePort {
  getProjectFence(projectId: string): Promise<SimulationProjectFence | null>
  retrieveEvidence(input: {
    readonly fence: SimulationProjectFence
    readonly brief: QaSimulationBrief
    readonly slots: readonly QaCoverageSlot[]
    readonly signal: AbortSignal
  }): Promise<readonly QaSlotEvidence[]>
}

export interface SimulationProviderPort {
  generateBatch(input: {
    readonly operationId: string
    readonly generation: number
    readonly fence: SimulationProjectFence
    readonly brief: QaSimulationBrief
    readonly slots: readonly QaCoverageSlot[]
    readonly evidence: readonly QaSlotEvidence[]
    readonly signal: AbortSignal
  }): Promise<{ readonly rawJson: string; readonly usage?: SimulationTokenUsage }>
}

export interface SimulationRepositoryPort {
  createJob(input: CreateSimulationJobInput): Promise<QaSimulationJobRecord>
  getJob(projectId: string, jobId: string): Promise<QaSimulationJobRecord | null>
  getLatestJob(projectId: string): Promise<QaSimulationJobRecord | null>
  transition(input: {
    readonly projectId: string
    readonly jobId: string
    readonly expectedGeneration: number
    readonly expectedStates: readonly QaSimulationJobState[]
    readonly nextState: QaSimulationJobState
    readonly errorCode?: QaSimulationErrorCode | null
    readonly completedAt?: number | null
  }): Promise<QaSimulationJobRecord | null>
  advanceGeneration(input: {
    readonly projectId: string
    readonly jobId: string
    readonly expectedGeneration: number
    readonly expectedStates: readonly QaSimulationJobState[]
    readonly nextState: 'planning' | 'retrieving'
  }): Promise<QaSimulationJobRecord | null>
  saveCoveragePlan(input: {
    readonly projectId: string
    readonly jobId: string
    readonly generation: number
    readonly plan: QaCoveragePlan
  }): Promise<void>
  getCoveragePlan(projectId: string, jobId: string): Promise<QaCoveragePlan | null>
  listBatches(projectId: string, jobId: string): Promise<readonly QaSimulationBatchRecord[]>
  acceptedQuestionIdentities(projectId: string, jobId: string): Promise<readonly string[]>
  commitBatch(input: CommitSimulationBatchInput): Promise<{
    readonly inserted: boolean
    readonly job: QaSimulationJobRecord
  }>
}

export interface SimulationRecoveryPort {
  recoverInterruptedJobs(): Promise<readonly QaSimulationJobRecord[]>
}

export interface StartSimulationInput {
  readonly jobId?: string
  readonly fence: SimulationProjectFence
  readonly requestedCount: number
  readonly brief: QaSimulationBrief
  readonly largeBatchAcknowledged?: boolean
}

export interface SimulationPreflightInput {
  readonly projectId: string
  readonly requestedCount: number
  readonly brief: QaSimulationBrief
}
