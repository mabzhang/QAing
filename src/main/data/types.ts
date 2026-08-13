import type {
  AnswerOrigin,
  AnswerVersionStage,
  QaAnswerVersion,
  QaRoundStatus,
  QaWorkspacePage,
  QaWorkspaceRound,
  RetrievalRoute,
  SourceReference,
} from '../../core/types'

export type DocumentKind = 'text' | 'markdown' | 'front_transcript'
export type SessionMode = 'front' | 'qa'
export type AudioSource = 'microphone' | 'system'
export type IndexOwnerType = 'chunk' | 'preset_qa'
export type IndexJobStatus = 'pending' | 'processing' | 'ready' | 'failed'
export type FrontDraftStatus = 'capturing' | 'raw_ready' | 'structuring' | 'structured' | 'complete' | 'failed'

export interface DocumentRecord {
  readonly id: string
  readonly title: string
  readonly kind: DocumentKind
  readonly sourceUri: string | null
  readonly content: string
  readonly contentHash: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ChunkRecord {
  readonly id: string
  readonly documentId: string
  readonly ordinal: number
  readonly content: string
  readonly contentHash: string
  readonly tokenCount: number
  readonly embedding: Float32Array | null
  readonly embeddingModelId: string | null
  readonly embeddingModelRevision: string | null
  readonly embeddingDimension: number | null
  readonly embeddingNormalized: boolean
  readonly embeddedAt: number | null
}

export interface PresetQaRecord {
  readonly id: string
  readonly question: string
  readonly normalizedQuestion: string
  readonly answer: string
  readonly contentHash: string
  readonly embedding: Float32Array | null
  readonly embeddingModelId: string | null
  readonly embeddingModelRevision: string | null
  readonly embeddingDimension: number | null
  readonly embeddingNormalized: boolean
  readonly embeddedAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface SessionRecord {
  readonly id: string
  readonly projectId: string | null
  readonly mode: SessionMode
  readonly audioSource: AudioSource
  readonly status: string
  readonly startedAt: number
  readonly endedAt: number | null
}

export interface TurnRecord {
  readonly id: string
  readonly projectId: string | null
  readonly sessionId: string
  readonly ordinal: number
  readonly question: string
  readonly answer: string
  readonly sourceIds: readonly string[]
  readonly roundId: string | null
  readonly answerOrigin: AnswerOrigin | null
  readonly selectedAnswerVersionId: string | null
  readonly createdAt: number
}

export interface EnsureQaRoundInput {
  readonly projectId: string
  readonly sessionId: string
  readonly roundId: string
  readonly question: string
  readonly startedAt?: number
}

export interface SaveQaAnswerVersionInput {
  readonly projectId: string
  readonly operationId: string
  readonly roundId: string
  readonly sessionId: string
  readonly stage: AnswerVersionStage
  readonly questionRevision: number
  readonly questionSnapshot: string
  readonly questionIdentity: string
  readonly answer: string
  readonly retrievalRoute: RetrievalRoute
  readonly sources: readonly SourceReference[]
  readonly elapsedMs: number
  readonly createdAt: number
}

export interface SaveQaAnswerVersionResult {
  readonly version: QaAnswerVersion
  readonly versionId: string
  readonly inserted: boolean
  readonly dataRevision: number
}

export interface CommitQaRoundInput {
  readonly projectId: string
  readonly roundId: string
  readonly selectedAnswerVersionId: string
  readonly turn: {
    readonly id: string
    readonly sessionId: string
    readonly question: string
    readonly answer: string
    readonly sourceIds?: readonly string[]
    readonly answerOrigin: AnswerOrigin
    readonly createdAt?: number
  }
}

export interface CommitQaRoundResult {
  readonly round: QaWorkspaceRound
  readonly turn: TurnRecord
  readonly dataRevision: number
}

export interface CloseQaRoundResult {
  readonly round: QaWorkspaceRound
  readonly dataRevision: number
}

export interface QaWorkspacePageInput {
  readonly projectId: string
  readonly cursor?: string | null
  readonly limit?: number
  readonly expectedDataRevision?: number
}

export interface LegacyQaWorkspacePageInput {
  readonly cursor?: string | null
  readonly limit?: number
  readonly expectedDataRevision?: number
}

export interface CloseQaRoundInput {
  readonly projectId: string
  readonly roundId: string
  readonly status: TerminalQaRoundStatus
  readonly completedAt?: number
}

export interface DeleteQaWorkspaceRoundResult {
  readonly deleted: boolean
  readonly dataRevision: number
}

export interface ClearQaWorkspaceProjectResult {
  readonly deletedRounds: number
  readonly deletedTurns: number
  readonly dataRevision: number
}

export interface AssignLegacyQaSessionResult {
  readonly rounds: number
  readonly turns: number
  readonly versions: number
  readonly dataRevision: number
}

export interface QaWorkspaceExportSnapshot {
  readonly projectId: string
  readonly snapshotRevision: number
}

export interface QaWorkspaceExportPageInput {
  readonly projectId: string
  readonly snapshotRevision: number
  readonly cursor?: string | null
  readonly limit?: number
}

export type TerminalQaRoundStatus = Extract<QaRoundStatus, 'skipped' | 'cancelled' | 'interrupted' | 'failed'>

export type { QaAnswerVersion, QaWorkspacePage, QaWorkspaceRound }

export interface FrontDraftRecord {
  readonly id: string
  readonly sessionId: string
  readonly transcript: string
  readonly contentHash: string
  readonly structuredMarkdown: string | null
  readonly status: FrontDraftStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export interface IndexJobRecord {
  readonly id: string
  readonly ownerType: IndexOwnerType
  readonly ownerId: string
  readonly operation: 'upsert' | 'delete'
  readonly contentHash: string
  readonly status: IndexJobStatus
  readonly attemptCount: number
  readonly lastErrorCode: string | null
  readonly availableAt: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ChunkInput {
  readonly content: string
  readonly tokenCount: number
}

export interface DocumentImportInput {
  readonly title: string
  readonly kind: DocumentKind
  readonly content: string
  readonly chunks: readonly ChunkInput[]
  readonly sourceUri?: string
}

export interface CommitProjectFrontDocumentInput {
  readonly projectId: string
  readonly sessionId: string
  readonly draftId: string
  readonly document: DocumentImportInput
}

export interface ProjectFrontDocumentLinkRecord {
  readonly projectId: string
  readonly sessionId: string
  readonly draftId: string
  readonly documentId: string
  readonly documentContentHash: string
  readonly linkedAt: number
  readonly updatedAt: number
}

export interface PresetQaInput {
  readonly question: string
  readonly answer: string
}

export interface KeywordHit {
  readonly ownerType: IndexOwnerType
  readonly ownerId: string
  readonly documentId: string
  readonly title: string
  readonly excerpt: string
  readonly rank: number
}

export interface EmbeddingMetadata {
  readonly modelId: string
  readonly modelRevision: string
  readonly dimension: number
  readonly normalized: boolean
}

export interface StoredVector {
  readonly ownerType: IndexOwnerType
  readonly ownerId: string
  readonly documentId: string
  readonly title: string
  readonly excerpt: string
  readonly contentHash: string
  readonly vector: Float32Array
  readonly metadata: EmbeddingMetadata
}

export type ProjectSyncPolicy = 'manual' | 'auto_check_confirm' | 'auto_check_apply'
export type ProjectAvailability = 'available' | 'unavailable' | 'identity_changed'
export type ProjectTrustKind = 'document' | 'preset_qa'
export type ProjectCategoryHint = 'brand' | 'product' | 'general'
export type ProjectSourceState =
  | 'needs_conversion'
  | 'converting'
  | 'validating'
  | 'artifact_staged'
  | 'published_fs'
  | 'embedding_pending'
  | 'ready'
  | 'missing_grace'
  | 'tombstoned'
  | 'blocked'
  | 'conversion_failed'
  | 'commit_failed'
  | 'index_failed'
export type ProjectRevisionState =
  | 'observed'
  | 'prepared'
  | 'staged'
  | 'published_fs'
  | 'committed'
  | 'failed'
  | 'superseded'
export type ConversionMode = 'local' | 'llm' | 'external' | 'manual'
export type ProjectContentKind = 'document' | 'preset_qa'
export type ProjectConversionDisposition = 'local' | 'external' | 'unsupported' | 'blocked'
export type ConversionJobState = 'prepared' | 'staged' | 'published_fs' | 'committed' | 'failed' | 'cancelled'
export type ProjectSyncRunState =
  | 'scanning'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled'
export type ProjectSyncTrigger = 'manual' | 'watch' | 'startup'
export type ProjectSourcePageFilter = 'all' | 'attention' | 'failed'

export interface ProjectRecord {
  readonly id: string
  readonly displayName: string
  /** Local-only canonical path. Never include this field in renderer events or diagnostics. */
  readonly rootPath: string
  readonly rootIdentity: string
  readonly schemaVersion: number
  readonly syncPolicy: ProjectSyncPolicy
  readonly scanGeneration: number
  readonly knowledgeVersion: number
  readonly availability: ProjectAvailability
  readonly lastErrorCode: string | null
  readonly lastScanAt: number | null
  readonly dataRevision: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateProjectManifestInput {
  readonly id: string
  readonly displayName: string
  readonly rootPath: string
  readonly rootIdentity: string
  readonly schemaVersion: number
  readonly syncPolicy?: ProjectSyncPolicy
}

export interface ProjectSourceFileRecord {
  readonly sourceId: string
  readonly projectId: string
  readonly trustKind: ProjectTrustKind
  readonly displayRelativePath: string
  readonly pathKey: string
  readonly categoryHint: ProjectCategoryHint | null
  readonly sizeBytes: number
  /** Decimal nanoseconds kept as text to avoid JavaScript integer precision loss. */
  readonly mtimeNs: string
  readonly deviceId: string | null
  readonly inode: string | null
  readonly observedRawSha256: string | null
  readonly detectedType: string
  readonly conversionDisposition: ProjectConversionDisposition
  readonly activeRevisionId: string | null
  readonly lastGoodRevisionId: string | null
  readonly lastSeenGeneration: number
  readonly state: ProjectSourceState
  readonly errorCode: string | null
  readonly missingSinceGeneration: number | null
  readonly tombstonedAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ProjectSourceRevisionRecord {
  readonly revisionId: string
  readonly sourceId: string
  readonly rawSha256: string
  readonly sizeBytes: number
  readonly detectedType: string
  readonly generation: number
  readonly state: ProjectRevisionState
  readonly conversionMode: ConversionMode | null
  readonly converterId: string | null
  readonly converterVersion: string | null
  readonly artifactSchemaVersion: number | null
  readonly modelId: string | null
  readonly modelRevision: string | null
  readonly promptConfigHash: string | null
  readonly cacheKey: string | null
  readonly errorCode: string | null
  readonly createdAt: number
  readonly activatedAt: number | null
}

export interface ConversionArtifactRecord {
  readonly artifactId: string
  readonly revisionId: string
  readonly relativeOutputPath: string
  /** SHA-256 of the complete on-disk artifact, including provenance frontmatter. */
  readonly outputSha256: string
  /** SHA-256 of the normalized indexable body. Null until the artifact is committed. */
  readonly canonicalBodySha256: string | null
  readonly outputSizeBytes: number | null
  readonly outputMtimeNs: string | null
  readonly outputDeviceId: string | null
  readonly outputInode: string | null
  readonly contentKind: ProjectContentKind
  readonly warnings: readonly string[]
  readonly validationState: 'staged' | 'published_fs' | 'committed' | 'superseded' | 'failed' | 'modified'
  readonly publishedAt: number | null
  readonly committedAt: number | null
  readonly manualModifiedAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ConversionJobRecord {
  readonly operationId: string
  readonly projectId: string
  readonly sourceId: string
  readonly revisionId: string
  readonly artifactId: string | null
  readonly generation: number
  readonly state: ConversionJobState
  readonly inputSha256: string
  readonly tempRelativePath: string
  readonly finalRelativePath: string
  readonly outputSha256: string | null
  readonly conversionMode: ConversionMode
  readonly converterId: string
  readonly converterVersion: string
  readonly artifactSchemaVersion: number
  readonly modelId: string | null
  readonly modelRevision: string | null
  readonly promptConfigHash: string | null
  readonly cacheKey: string
  readonly attempt: number
  readonly errorCode: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ProjectSyncCounts {
  readonly discovered: number
  readonly added: number
  readonly changed: number
  readonly renamed: number
  readonly unchanged: number
  /** Canonical artifacts successfully committed during this run. */
  readonly converted: number
  /** Active manual artifacts visible after this run; informational, not an error state. */
  readonly manualReady: number
  readonly missingGrace: number
  readonly tombstoned: number
  readonly blocked: number
  readonly failed: number
}

export interface ProjectSyncRunRecord {
  readonly runId: string
  readonly projectId: string
  readonly generation: number
  readonly trigger: ProjectSyncTrigger
  readonly state: ProjectSyncRunState
  readonly rootIdentity: string
  readonly counts: ProjectSyncCounts
  readonly errorCode: string | null
  readonly startedAt: number
  readonly completedAt: number | null
  readonly updatedAt: number
}

export interface ProjectScanObservation {
  readonly trustKind: ProjectTrustKind
  readonly displayRelativePath: string
  /** NFC + case-folded key produced by the bounded scanner. */
  readonly pathKey: string
  readonly categoryHint?: ProjectCategoryHint | null
  readonly sizeBytes: number
  readonly mtimeNs: string
  readonly deviceId?: string | null
  readonly inode?: string | null
  readonly rawSha256?: string | null
  readonly detectedType: string
  readonly conversionDisposition?: ProjectConversionDisposition
  /** Stable closed-set scanner error such as INPUT_SYMLINK_BLOCKED or INPUT_TOO_LARGE. */
  readonly blockedReason?: string | null
}

export interface CommitManualProjectArtifactInput {
  readonly operationId: string
  readonly projectId: string
  readonly runId: string
  readonly generation: number
  readonly displayRelativePath: string
  readonly pathKey: string
  readonly trustKind: ProjectTrustKind
  readonly canonicalContent: string
  /** SHA-256 of the complete user-owned Markdown file. */
  readonly outputSha256: string
  /** SHA-256 of canonicalContent after normalization. */
  readonly canonicalBodySha256: string
  readonly document?: DocumentImportInput
  readonly qaItems?: readonly PresetQaInput[]
  readonly outputSizeBytes?: number
  readonly outputMtimeNs?: string
  readonly outputDeviceId?: string
  readonly outputInode?: string
}

export interface FailManualProjectArtifactInput {
  readonly projectId: string
  readonly runId: string
  readonly generation: number
  readonly displayRelativePath: string
  readonly pathKey: string
  readonly trustKind: ProjectTrustKind
  /** SHA-256 of the invalid/manual file bytes; its body may be unavailable. */
  readonly inputSha256: string
  readonly errorCode: string
}

export interface BeginProjectScanInput {
  readonly runId: string
  readonly projectId: string
  readonly trigger: ProjectSyncTrigger
  readonly rootIdentity: string
  readonly startedAt?: number
}

export interface ApplyProjectScanManifestInput {
  readonly runId: string
  readonly projectId: string
  readonly generation: number
  readonly observations: readonly ProjectScanObservation[]
  readonly completedAt?: number
}

export interface ProjectScanApplyResult {
  readonly run: ProjectSyncRunRecord
  readonly counts: ProjectSyncCounts
  readonly addedSourceIds: readonly string[]
  readonly changedSourceIds: readonly string[]
  readonly renamedSourceIds: readonly string[]
  readonly unchangedSourceIds: readonly string[]
  readonly missingGraceSourceIds: readonly string[]
  readonly tombstonedSourceIds: readonly string[]
  readonly pendingRenames: ReadonlyArray<{
    readonly sourceId: string
    readonly trustKind: ProjectTrustKind
    readonly displayRelativePath: string
    readonly pathKey: string
    readonly categoryHint: ProjectCategoryHint | null
    readonly sizeBytes: number
    readonly mtimeNs: string
    readonly deviceId: string | null
    readonly inode: string | null
    readonly rawSha256: string
    readonly detectedType: string
    readonly conversionDisposition?: ProjectConversionDisposition
    readonly errorCode?: string | null
  }>
  readonly pendingTombstoneSourceIds: readonly string[]
  readonly pendingRevisions: ReadonlyArray<{
    readonly sourceId: string
    readonly revisionId: string
  }>
}

export interface ApplyProjectIncrementalPlanInput {
  readonly projectId: string
  readonly runId: string
  readonly generation: number
  readonly renames: ReadonlyArray<{
    readonly sourceId: string
    readonly trustKind: ProjectTrustKind
    readonly displayRelativePath: string
    readonly pathKey: string
    readonly categoryHint?: ProjectCategoryHint | null
    readonly sizeBytes: number
    readonly mtimeNs: string
    readonly deviceId?: string | null
    readonly inode?: string | null
    readonly rawSha256: string
    readonly detectedType: string
    readonly conversionDisposition?: ProjectConversionDisposition
    readonly errorCode?: string | null
  }>
  readonly tombstoneSourceIds: readonly string[]
  readonly appliedAt?: number
}

export interface PrepareConversionJobInput {
  readonly operationId: string
  readonly projectId: string
  readonly sourceId: string
  readonly revisionId: string
  readonly generation: number
  readonly inputSha256: string
  readonly tempRelativePath: string
  readonly finalRelativePath: string
  readonly conversionMode: ConversionMode
  readonly converterId: string
  readonly converterVersion: string
  readonly artifactSchemaVersion: number
  readonly modelId?: string | null
  readonly modelRevision?: string | null
  readonly promptConfigHash?: string | null
  readonly cacheKey: string
}

export interface StageConversionArtifactInput {
  readonly operationId: string
  readonly artifactId: string
  readonly outputSha256: string
  readonly contentKind: ProjectContentKind
  readonly warnings?: readonly string[]
}

export interface ConversionSagaResult {
  readonly job: ConversionJobRecord
  readonly artifact: ConversionArtifactRecord
}

export interface CommitProjectDocumentArtifactInput {
  readonly operationId: string
  readonly artifactId: string
  /** SHA-256 of the complete published Markdown file. */
  readonly outputSha256: string
  /** SHA-256 of the normalized document.content body. */
  readonly canonicalBodySha256: string
  readonly document: DocumentImportInput
  readonly outputSizeBytes?: number
  readonly outputMtimeNs?: string
  readonly outputDeviceId?: string
  readonly outputInode?: string
}

export interface CommitProjectQaArtifactInput {
  readonly operationId: string
  readonly artifactId: string
  /** Exact normalized, indexable Markdown body (frontmatter already removed). */
  readonly canonicalContent: string
  /** SHA-256 of the complete published Markdown file. */
  readonly outputSha256: string
  /** SHA-256 of canonicalContent after normalization. */
  readonly canonicalBodySha256: string
  readonly items: readonly PresetQaInput[]
  readonly outputSizeBytes?: number
  readonly outputMtimeNs?: string
  readonly outputDeviceId?: string
  readonly outputInode?: string
}

export interface ProjectStatusSummary {
  readonly projectId: string
  readonly availability: ProjectAvailability
  readonly knowledgeVersion: number
  readonly dataRevision: number
  readonly lastScanAt: number | null
  readonly totalFiles: number
  readonly ready: number
  readonly attention: number
  readonly failed: number
  readonly pendingEmbedding: number
  readonly readyEmbedding: number
  readonly failedEmbedding: number
  readonly manualReady: number
  readonly awaitingExternal: number
  readonly needsConversion: number
  /** Keyword-usable active document sources, including project-scoped front recordings. */
  readonly usableDocumentSources: number
  /** Active source files that currently publish one or more reviewed preset QA items. */
  readonly usablePresetQaSources: number
  /** Distinct reviewed preset QA items currently active in this project. */
  readonly usablePresetQaItems: number
  /** Sources that require an explicit user action; background embedding/conversion work is excluded. */
  readonly actionRequiredSources: number
  readonly hasUsableKnowledge: boolean
  readonly latestRun: ProjectSyncRunRecord | null
}

export type SimulationJobStatus =
  | 'draft'
  | 'awaiting_large_run_confirmation'
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed_with_gaps'
  | 'failed'
  | 'cancelled'
  | 'stale'

export type SimulationReviewState = 'draft' | 'approved' | 'rejected' | 'publishing' | 'published' | 'stale'

export type SimulationGapReason =
  | 'NO_RELEVANT_EVIDENCE'
  | 'INSUFFICIENT_DETAIL'
  | 'CONFLICTING_SOURCES'
  | 'UNSUPPORTED_OR_UNCONVERTED_SOURCE'
  | 'DUPLICATE_COVERAGE_ONLY'
  | 'STALE_SOURCE'

export interface SimulationInterviewBrief {
  readonly intervieweeIdentity: string
  readonly audience: string
  readonly focusTopics: readonly string[]
  readonly scenario: string
  readonly answerStyle: 'concise' | 'standard' | 'detailed'
  readonly excludedTopics: readonly string[]
}

export interface SimulationProjectFence {
  readonly projectId: string
  readonly knowledgeVersion: number
  readonly projectDataRevision: number
  readonly sourceManifestHash: string
  readonly sourceCount: number
}

export interface SimulationEvidenceHit {
  readonly chunkId: string
  readonly documentId: string
  readonly sourceId: string | null
  readonly sourceRevisionId: string | null
  readonly title: string
  readonly excerpt: string
  readonly contentHash: string
}

export interface SimulationJobRecord {
  readonly jobId: string
  readonly projectId: string
  readonly createOperationId: string
  readonly knowledgeVersion: number
  readonly projectDataRevision: number
  readonly sourceManifestHash: string
  readonly sourceCount: number
  readonly targetCount: number
  readonly brief: SimulationInterviewBrief
  readonly briefFingerprint: string
  readonly status: SimulationJobStatus
  /** Attempt generation. A resume from a paused run increments it before accepting new provider results. */
  readonly generation: number
  readonly reliableCount: number
  readonly gapCount: number
  readonly approvedCount: number
  readonly publishedCount: number
  readonly nextBatchOrdinal: number
  readonly dataRevision: number
  readonly largeRunAcknowledgedAt: number | null
  readonly errorCode: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt: number | null
}

export interface SimulationBatchRecord {
  readonly batchId: string
  readonly jobId: string
  readonly operationId: string
  readonly ordinal: number
  readonly plannedCount: number
  readonly reliableCount: number
  readonly gapCount: number
  readonly contentFingerprint: string
  readonly createdAt: number
}

export interface SimulationCitationRecord {
  readonly citationId: string
  readonly itemId: string
  readonly ordinal: number
  readonly chunkId: string
  readonly documentId: string
  /** Canonical document title captured when the citation is committed. */
  readonly title: string
  readonly sourceId: string | null
  readonly sourceRevisionId: string | null
  readonly contentHash: string
  readonly excerpt: string
}

export interface SimulationItemRecord {
  readonly itemId: string
  readonly jobId: string
  readonly batchId: string
  readonly ordinal: number
  readonly question: string
  readonly answer: string
  readonly category: string | null
  readonly reviewState: SimulationReviewState
  readonly contentFingerprint: string
  readonly citations: readonly SimulationCitationRecord[]
  readonly editedAt: number | null
  readonly reviewedAt: number | null
  readonly publishedAt: number | null
  readonly createdAt: number
}

export interface SimulationGapRecord {
  readonly gapId: string
  readonly jobId: string
  readonly batchId: string
  readonly ordinal: number
  readonly topic: string
  readonly reason: SimulationGapReason
  readonly missingCount: number
  readonly suggestedMaterial: string
  readonly checkedSourceCount: number
  readonly createdAt: number
}

export interface SimulationPublicationRecord {
  readonly publicationId: string
  readonly jobId: string
  readonly operationId: string
  readonly status: 'prepared' | 'completed' | 'cancelled'
  readonly contentFingerprint: string
  readonly itemIds: readonly string[]
  readonly presetQaIds: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt: number | null
}

export interface CreateSimulationJobInput {
  readonly operationId: string
  readonly jobId: string
  readonly projectId: string
  readonly fence: SimulationProjectFence
  readonly targetCount: number
  readonly brief: SimulationInterviewBrief
  readonly largeRunAcknowledgedAt?: number | null
}

export interface TransitionSimulationJobInput {
  readonly operationId: string
  readonly projectId: string
  readonly jobId: string
  readonly expectedStatus: SimulationJobStatus
  readonly expectedGeneration: number
  readonly expectedDataRevision: number
  readonly nextStatus: SimulationJobStatus
  readonly errorCode?: string | null
  readonly largeRunAcknowledgedAt?: number | null
}

export interface SimulationCitationInput {
  readonly chunkId: string
  readonly documentId: string
  readonly sourceId?: string | null
  readonly sourceRevisionId?: string | null
  readonly contentHash: string
  readonly excerpt: string
}

export interface SimulationBatchItemInput {
  readonly question: string
  readonly answer: string
  readonly category?: string | null
  readonly citations: readonly SimulationCitationInput[]
}

export interface SimulationBatchGapInput {
  readonly topic: string
  readonly reason: SimulationGapReason
  readonly missingCount: number
  readonly suggestedMaterial: string
  readonly checkedSourceCount: number
}

export interface CommitSimulationBatchInput {
  readonly operationId: string
  readonly projectId: string
  readonly jobId: string
  readonly expectedGeneration: number
  readonly expectedDataRevision: number
  readonly plannedCount: number
  readonly items: readonly SimulationBatchItemInput[]
  readonly gaps: readonly SimulationBatchGapInput[]
}

export interface SimulationBatchCommitResult {
  readonly batch: SimulationBatchRecord
  readonly job: SimulationJobRecord
  readonly items: readonly SimulationItemRecord[]
  readonly gaps: readonly SimulationGapRecord[]
  readonly inserted: boolean
}

export interface SimulationPageInput {
  readonly projectId: string
  readonly cursor?: string | null
  readonly limit?: number
  readonly expectedDataRevision?: number
}

export interface SimulationJobPage {
  readonly projectId: string
  readonly items: readonly SimulationJobRecord[]
  readonly nextCursor: string | null
  readonly dataRevision: number
}

export interface SimulationResultPageInput extends SimulationPageInput {
  readonly jobId: string
}

export interface SimulationItemPage {
  readonly projectId: string
  readonly jobId: string
  readonly items: readonly SimulationItemRecord[]
  readonly nextCursor: string | null
  readonly dataRevision: number
}

export interface SimulationGapPage {
  readonly projectId: string
  readonly jobId: string
  readonly items: readonly SimulationGapRecord[]
  readonly nextCursor: string | null
  readonly dataRevision: number
}

export interface ReviewSimulationItemsInput {
  readonly operationId: string
  readonly projectId: string
  readonly jobId: string
  readonly expectedDataRevision: number
  readonly decisions: ReadonlyArray<{
    readonly itemId: string
    readonly decision: Extract<SimulationReviewState, 'approved' | 'rejected'>
  }>
}

export interface UpdateSimulationItemInput {
  readonly operationId: string
  readonly projectId: string
  readonly jobId: string
  readonly itemId: string
  readonly expectedDataRevision: number
  readonly question: string
  readonly answer: string
}

export interface UpdateSimulationItemResult {
  readonly job: SimulationJobRecord
  readonly item: SimulationItemRecord
  readonly inserted: boolean
}

export interface SimulationPublicationBundle {
  readonly publication: SimulationPublicationRecord
  readonly job: SimulationJobRecord
  readonly items: readonly SimulationItemRecord[]
  readonly inserted: boolean
}

export interface SimulationPublicationDraftBundle extends SimulationPublicationBundle {
  /** Strict grammar consumable by parseStructuredQaDocument and the existing project QA artifact commit path. */
  readonly canonicalMarkdown: string
  readonly canonicalBodySha256: string
}

export interface PrepareSimulationPublicationInput {
  readonly operationId: string
  readonly projectId: string
  readonly jobId: string
  readonly expectedDataRevision: number
  readonly itemIds: readonly string[]
}

export interface CompleteSimulationPublicationInput {
  readonly operationId: string
  readonly projectId: string
  readonly jobId: string
  readonly publicationId: string
  readonly expectedDataRevision: number
  readonly mappings: ReadonlyArray<{ readonly itemId: string; readonly presetQaId: string }>
}

export interface ResolveSimulationPublicationMappingsInput {
  readonly projectId: string
  readonly items: ReadonlyArray<{
    readonly itemId: string
    readonly question: string
    readonly answer: string
  }>
}

export interface SimulationPublicationMapping {
  readonly itemId: string
  readonly presetQaId: string
}

export interface CancelSimulationPublicationInput {
  readonly operationId: string
  readonly projectId: string
  readonly jobId: string
  readonly publicationId: string
  readonly expectedDataRevision: number
}

export interface ProjectIndexReconcileResult {
  readonly changedSourceIds: readonly string[]
  readonly dataRevision: number
}

export interface MarkProjectManagedOutputModifiedInput {
  readonly projectId: string
  readonly runId: string
  readonly generation: number
  readonly sourceId: string
  readonly observedOutputSha256: string
}

export interface ProjectSourcePageInput {
  readonly projectId: string
  readonly cursor?: string | null
  readonly limit?: number
  readonly filter?: ProjectSourcePageFilter
}

export interface ProjectSourceTaskRecord extends ProjectSourceFileRecord {
  readonly latestRunId: string | null
  readonly currentConversionMode: ConversionMode | null
  readonly lastGoodAvailable: boolean
}

export interface ProjectSourcePage {
  readonly items: readonly ProjectSourceTaskRecord[]
  readonly nextCursor: string | null
  readonly dataRevision: number
  readonly summary: ProjectStatusSummary
}

export interface ProjectDocumentLinkRecord {
  readonly sourceId: string
  readonly artifactId: string
  readonly documentId: string
  readonly active: boolean
  readonly linkedAt: number
}

export interface ProjectManifestEntryRecord {
  readonly sourceId: string
  readonly projectId: string
  readonly relativePath: string
  readonly pathKey: string
  readonly trustKind: ProjectTrustKind
  readonly sizeBytes: number
  readonly mtimeNs: string
  readonly deviceId: string | null
  readonly inode: string | null
  readonly rawSha256: string | null
  readonly detectedType: string
  readonly conversionDisposition: ProjectConversionDisposition
  readonly errorCode: string | null
  readonly state: ProjectSourceState
  readonly activeRawSha256: string | null
  readonly activeCanonicalSha256: string | null
  readonly outputRelativePath: string | null
  readonly outputSizeBytes: number | null
  readonly outputMtimeNs: string | null
  readonly outputDeviceId: string | null
  readonly outputInode: string | null
  readonly missingSinceGeneration: number | null
  readonly lastSeenGeneration: number
}

export interface ProjectQaLinkRecord {
  readonly sourceId: string
  readonly artifactId: string
  readonly presetQaId: string
  readonly active: boolean
  readonly linkedAt: number
}
