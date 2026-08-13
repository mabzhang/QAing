import type {
  AppMode,
  AppState,
  AudioSourceKind,
  QaWorkspaceChanged,
  QaWorkspacePage,
} from './types'

export type ProviderName = 'deepseek' | 'doubao_asr'

export type AppCommand =
  | { readonly type: 'switch_mode'; readonly mode: AppMode }
  | { readonly type: 'select_audio_source'; readonly source: AudioSourceKind }
  | { readonly type: 'start_session' }
  | { readonly type: 'stop_session' }
  | { readonly type: 'stop_front' }
  | { readonly type: 'end_question' }
  | { readonly type: 'end_answer' }
  | { readonly type: 'acknowledge_front_complete' }
  | { readonly type: 'retry' }
  | { readonly type: 'skip_question' }
  | { readonly type: 'dismiss_error' }

export type AudioPermissionRequestCode =
  | 'MICROPHONE_PERMISSION_REQUIRED'
  | 'MICROPHONE_PERMISSION_RESTART_REQUIRED'
  | 'MICROPHONE_PERMISSION_PREFLIGHT_FAILED'
  | 'SCREEN_PERMISSION_REQUIRED'
  | 'SCREEN_PERMISSION_RESTART_REQUIRED'
  | 'SCREEN_PERMISSION_PREFLIGHT_FAILED'

export type AudioPermissionRequestResult =
  | { readonly status: 'granted' }
  | {
    readonly status: 'required' | 'restart_required' | 'preflight_failed'
    readonly code: AudioPermissionRequestCode
  }

export interface ProviderStatus {
  readonly provider: ProviderName
  readonly configured: boolean
  readonly maskedKey: string | null
}

export interface RuntimeStatus {
  readonly platform: 'darwin-arm64'
  readonly appVersion: string
  readonly retrievalMode: 'hybrid' | 'keyword_fallback' | 'index_loading'
  readonly audioPermission: 'unknown' | 'granted' | 'denied' | 'restricted' | 'not_determined'
  readonly screenAudioPermission: 'unknown' | 'granted' | 'denied' | 'not_determined'
  readonly helperStatus: 'stopped' | 'starting' | 'ready' | 'silent' | 'recovering' | 'failed'
  readonly alwaysOnTop: boolean
  readonly providerStatuses: readonly ProviderStatus[]
}

/** A privacy-safe meter sample. Raw PCM never crosses into the renderer. */
export interface AudioLevelSample {
  readonly sessionId: string
  readonly source: AudioSourceKind
  readonly sequence: number
  readonly timestampMs: number
  readonly level: number
}

export interface QaWorkspacePageInput {
  readonly projectId: string
  readonly cursor?: string | null
  readonly limit?: number
}

export interface QaWorkspaceDeleteResult {
  readonly deleted: boolean
  readonly dataRevision: number
}

export interface QaWorkspaceClearResult {
  readonly deletedRounds: number
  readonly deletedTurns: number
  readonly dataRevision: number
}

export type ProjectSyncPolicy = 'manual' | 'auto_check_confirm' | 'auto_check_apply'

export type ProjectLampStatus =
  | 'unselected'
  | 'synced'
  | 'checking'
  | 'changes_detected'
  | 'manual_ready'
  | 'syncing'
  | 'partial_failure'
  | 'root_unavailable'
  | 'no_knowledge'
  | 'integrity_failed'
  | 'cancelled'

export type ProjectSemanticIndexStatus = 'unavailable' | 'ready' | 'pending' | 'degraded' | 'failed'
export type ProjectSyncStage =
  | 'idle'
  | 'scanning'
  | 'reviewing'
  | 'converting'
  | 'indexing'
  | 'applying'
  | 'completed'
  | 'cancelled'
  | 'failed'
export type ProjectSyncRunStatus = 'running' | 'cancel_requested' | 'completed' | 'cancelled' | 'failed'
export type ProjectTaskFilter = 'all' | 'action_required' | 'failed'
export type ProjectTaskKind = 'source_document' | 'preset_qa'
export type ProjectConversionMode = 'local' | 'manual' | 'llm' | 'external'
export type ProjectTaskStatus =
  | 'discovered'
  | 'stability_wait'
  | 'hashing'
  | 'unchanged'
  | 'needs_conversion'
  | 'converting'
  | 'awaiting_llm_consent'
  | 'awaiting_external_agent'
  | 'validating'
  | 'staged'
  | 'published'
  | 'indexing'
  | 'ready'
  | 'manual_ready'
  | 'missing_grace'
  | 'removed'
  | 'blocked'
  | 'failed'
  | 'cancelled'

export type ProjectTaskErrorCode =
  | 'PROJECT_ROOT_UNAVAILABLE'
  | 'PROJECT_ROOT_IDENTITY_CHANGED'
  | 'INPUT_ESCAPES_ROOT'
  | 'INPUT_SYMLINK_BLOCKED'
  | 'INPUT_CHANGED_DURING_READ'
  | 'INPUT_UNSUPPORTED'
  | 'INPUT_TOO_LARGE'
  | 'INPUT_ENCRYPTED'
  | 'CONVERTER_TIMEOUT'
  | 'CONVERTER_CRASHED'
  | 'OUTPUT_INVALID'
  | 'OUTPUT_TOO_LARGE'
  | 'GENERATED_OUTPUT_MODIFIED'
  | 'PRESET_QA_CONFLICT'
  | 'DB_COMMIT_FAILED'
  | 'DISK_FULL'
  | 'RENAME_AMBIGUOUS'

export type ProjectUiErrorCode =
  | 'PROJECT_ROOT_UNAVAILABLE'
  | 'PROJECT_ROOT_IDENTITY_CHANGED'
  | 'NO_KNOWLEDGE'
  | 'INTEGRITY_FAILED'
  | 'LOAD_FAILED'

export interface ProjectSemanticIndexSummary {
  readonly status: ProjectSemanticIndexStatus
  readonly readyItems: number
  readonly pendingItems: number
  readonly failedItems: number
}

/**
 * The small, user-facing projection of the durable project sync state.
 * Internal recovery/conversion stages stay in SQLite; the renderer should use
 * this projection for the default experience instead of inferring health from
 * a task page or an embedding backlog.
 */
export type ProjectKnowledgeReadiness = 'none' | 'keyword_ready' | 'hybrid_ready'
export type ProjectSimpleActivity = 'idle' | 'checking' | 'updating' | 'optimizing' | 'cancelling'
export type ProjectSimpleAttention =
  | 'none'
  | 'review_changes'
  | 'action_required'
  | 'partial_failure'
  | 'root_access'
  | 'root_identity'
  | 'integrity'
  | 'no_knowledge'

export interface ProjectKnowledgeSummary {
  /** Active document/file sources, including project-scoped front records. */
  readonly usableDocumentSources: number
  /** Active preset-QA source files. */
  readonly usablePresetQaSources: number
  /** Reviewed preset-QA items that may participate in the direct-answer path. */
  readonly usablePresetQaItems: number
}

export interface ProjectSimpleStatus {
  readonly readiness: ProjectKnowledgeReadiness
  readonly activity: ProjectSimpleActivity
  readonly attention: ProjectSimpleAttention
  readonly pendingChanges: number
  readonly issueCount: number
  readonly detailsRecommended: boolean
}

export interface ProjectSummary {
  readonly id: string
  readonly displayName: string
  readonly lampStatus: ProjectLampStatus
  readonly lastCompletedScanAt: number | null
  readonly knowledgeVersion: number | null
  readonly syncPolicy: ProjectSyncPolicy
  readonly semanticIndex: ProjectSemanticIndexSummary
  readonly knowledgeSummary: ProjectKnowledgeSummary
  readonly simpleStatus: ProjectSimpleStatus
}

export interface ProjectSyncCounts {
  readonly added: number
  readonly changed: number
  readonly deleted: number
  readonly awaitingAgent: number
  readonly failed: number
  readonly actionRequired: number
  readonly completed: number
  readonly total: number | null
}

export interface ProjectSyncRun {
  readonly id: string
  readonly projectId: string
  readonly status: ProjectSyncRunStatus
  readonly stage: ProjectSyncStage
  readonly completedItems: number
  readonly totalItems: number | null
  readonly startedAt: number
  readonly completedAt: number | null
}

export interface ProjectSyncTask {
  readonly id: string
  readonly projectId: string
  readonly runId: string | null
  readonly relativePath: string
  readonly kind: ProjectTaskKind
  readonly conversionMode: ProjectConversionMode
  readonly status: ProjectTaskStatus
  readonly lastGoodAvailable: boolean
  readonly requiresAction: boolean
  readonly errorCode: ProjectTaskErrorCode | null
  readonly updatedAt: number
}

export interface ProjectTaskPage {
  readonly items: readonly ProjectSyncTask[]
  readonly nextCursor: string | null
  readonly dataRevision: number
}

export interface ProjectDirectoryConfirmation {
  readonly projectId: string
  readonly projectName: string
  readonly directories: readonly string[]
}

export interface ProjectPublicState {
  readonly projects: readonly ProjectSummary[]
  readonly activeProjectId: string | null
  readonly run: ProjectSyncRun | null
  readonly counts: ProjectSyncCounts
  readonly directoryConfirmation: ProjectDirectoryConfirmation | null
  readonly dataRevision: number
}

export interface ProjectChangedEvent {
  readonly projectId: string
  readonly dataRevision: number
  readonly scope: 'summary' | 'tasks' | 'all'
}

export type ProjectSelectionResult =
  | { readonly status: 'cancelled' }
  | { readonly status: 'ready'; readonly project: ProjectSummary }
  | { readonly status: 'confirmation_required'; readonly confirmation: ProjectDirectoryConfirmation }

export interface ProjectTaskPageInput {
  readonly projectId: string
  readonly runId?: string | null
  readonly filter?: ProjectTaskFilter
  readonly cursor?: string | null
  readonly limit?: number
}

export type QaSimulationWarningCode = 'LARGE_BATCH_TIME' | 'EVIDENCE_DILUTION'
export type QaSimulationJobState =
  | 'planning'
  | 'generating'
  | 'validating'
  | 'review_required'
  | 'publishing'
  | 'completed'
  | 'completed_with_gaps'
  | 'paused'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted'
  | 'stale'
  | 'failed'
export type QaSimulationItemStatus =
  | 'generated_draft'
  | 'machine_validated'
  | 'human_approved'
  | 'rejected'
  | 'published_preset'
export type QaSimulationGapReason =
  | 'NO_RELEVANT_EVIDENCE'
  | 'INSUFFICIENT_DETAIL'
  | 'CONFLICTING_SOURCES'
  | 'UNSUPPORTED_OR_UNCONVERTED_SOURCE'
  | 'DUPLICATE_COVERAGE_ONLY'
  | 'STALE_SOURCE'

export interface QaSimulationBrief {
  /** The person who will answer, expressed as a role rather than a real name. */
  readonly intervieweeIdentity: string
  /** The person or group likely to ask the questions. */
  readonly audience: string
  readonly focusTopics: readonly string[]
  readonly scenario: string
  readonly answerStyle: 'concise' | 'standard' | 'detailed'
  readonly excludedTopics: readonly string[]
}

export interface QaSimulationFence {
  readonly projectId: string
  readonly knowledgeVersion: number
  readonly projectDataRevision: number
  readonly sourceManifestHash: string
  readonly sourceCount: number
}

export interface QaSimulationPreflightInput {
  readonly projectId: string
  /** Defaults to 30 in the UI/application service when omitted. */
  readonly targetCount?: number
  readonly brief: QaSimulationBrief
}

export interface QaSimulationPreflight {
  readonly fence: QaSimulationFence
  readonly targetCount: number
  readonly warnings: readonly QaSimulationWarningCode[]
  readonly confirmationRequired: boolean
  readonly estimatedBatches: number
  readonly evidenceSourceCount: number
}

export interface StartQaSimulationInput {
  readonly fence: QaSimulationFence
  readonly targetCount: number
  readonly brief: QaSimulationBrief
  readonly largeBatchAcknowledged?: boolean
}

export interface QaSimulationJobSummary {
  readonly id: string
  readonly projectId: string
  readonly generation: number
  readonly knowledgeVersion: number
  readonly state: QaSimulationJobState
  readonly targetCount: number
  readonly completedBatches: number
  readonly totalBatches: number
  readonly reliableCount: number
  readonly gapCount: number
  /** Human-approved drafts across the entire job, not just the visible page. */
  readonly approvedCount: number
  readonly dataRevision: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt: number | null
  readonly errorCode: string | null
}

export interface QaSimulationCitation {
  readonly sourceId: string | null
  readonly sourceRevisionId: string | null
  readonly documentId: string
  readonly chunkId: string
  readonly title: string
  readonly excerpt: string
  readonly contentHash: string
}

export interface QaSimulationItem {
  readonly id: string
  readonly ordinal: number
  readonly topic: string
  readonly question: string
  readonly answer: string
  readonly status: QaSimulationItemStatus
  readonly validationCodes: readonly string[]
  readonly citations: readonly QaSimulationCitation[]
  readonly editedAt: number | null
  readonly approvedAt: number | null
}

export interface QaSimulationGap {
  readonly id: string
  readonly ordinal: number
  readonly topic: string
  readonly reason: QaSimulationGapReason
  readonly suggestedMaterial: string
}

export interface QaSimulationPageInput {
  readonly projectId: string
  readonly jobId: string
  readonly expectedDataRevision?: number
  readonly cursor?: string | null
  readonly limit?: number
}

export interface QaSimulationPage {
  readonly projectId: string
  readonly jobId: string
  readonly generation: number
  readonly knowledgeVersion: number
  readonly dataRevision: number
  readonly totalItems: number
  readonly items: readonly QaSimulationItem[]
  readonly gaps: readonly QaSimulationGap[]
  readonly nextCursor: string | null
}

export interface UpdateQaSimulationItemInput {
  readonly projectId: string
  readonly jobId: string
  readonly itemId: string
  readonly expectedDataRevision: number
  readonly question: string
  readonly answer: string
}

export interface ReviewQaSimulationItemsInput {
  readonly projectId: string
  readonly jobId: string
  readonly itemIds: readonly string[]
  readonly expectedDataRevision: number
  readonly decision: 'approve' | 'reject'
}

export interface PublishQaSimulationInput {
  readonly projectId: string
  readonly jobId: string
  readonly expectedDataRevision: number
}

export interface QaSimulationChangedEvent {
  readonly projectId: string
  readonly jobId: string
  readonly generation: number
  readonly knowledgeVersion: number
  readonly dataRevision: number
}

export interface DocumentSummary {
  readonly id: string
  readonly title: string
  readonly kind: 'preset_qa' | 'source_document' | 'front_recording'
  readonly status: 'pending' | 'indexed' | 'failed'
  readonly chunkCount: number
  readonly createdAt: number
  readonly error: string | null
}

export interface PublicSnapshot {
  readonly app: AppState
  readonly runtime: RuntimeStatus
  readonly library: readonly DocumentSummary[]
}

/**
 * High-frequency controller updates deliberately omit the unchanged library.
 * The renderer merges these patches into the last full snapshot, avoiding a
 * structured-clone of the knowledge catalogue for every ASR partial.
 */
export interface PublicSnapshotUpdate {
  readonly app: AppState
  readonly runtime: RuntimeStatus
  readonly library?: readonly DocumentSummary[]
}

export interface QaingBridge {
  getSnapshot(): Promise<PublicSnapshot>
  dispatch(command: AppCommand): Promise<void>
  onSnapshot(listener: (snapshot: PublicSnapshotUpdate) => void): () => void
  onAudioLevel(listener: (sample: AudioLevelSample) => void): () => void
  getQaWorkspacePage(input: QaWorkspacePageInput): Promise<QaWorkspacePage>
  deleteQaWorkspaceRound(projectId: string, roundId: string): Promise<QaWorkspaceDeleteResult>
  clearQaWorkspaceProject(projectId: string): Promise<QaWorkspaceClearResult>
  exportQaWorkspaceProject(projectId: string): Promise<void>
  onQaWorkspaceChanged(listener: (event: QaWorkspaceChanged) => void): () => void
  configureProvider(provider: ProviderName, apiKey: string): Promise<ProviderStatus>
  clearProvider(provider: ProviderName): Promise<ProviderStatus>
  copyAnswer(text: string): Promise<void>
  importSourceDocuments(): Promise<readonly DocumentSummary[]>
  importPresetQa(): Promise<readonly DocumentSummary[]>
  deleteDocument(documentId: string): Promise<void>
  openSystemPermissions(kind: 'microphone' | 'screen_audio'): Promise<void>
  requestAudioPermission(source: AudioSourceKind): Promise<AudioPermissionRequestResult>
  restartApplication(): Promise<void>
  setAlwaysOnTop(enabled: boolean): Promise<void>
  getProjectState(): Promise<ProjectPublicState>
  selectProjectRoot(projectId?: string): Promise<ProjectSelectionResult>
  confirmProjectDirectories(projectId: string): Promise<ProjectSummary>
  cancelProjectPreparation(projectId: string): Promise<void>
  activateProject(projectId: string): Promise<ProjectSummary>
  startProjectSync(projectId: string): Promise<ProjectSyncRun>
  cancelProjectSync(runId: string): Promise<void>
  retryProjectSync(projectId: string, runId?: string | null): Promise<ProjectSyncRun>
  setProjectSyncPolicy(projectId: string, policy: ProjectSyncPolicy): Promise<ProjectSummary>
  getProjectTaskPage(input: ProjectTaskPageInput): Promise<ProjectTaskPage>
  exportProjectDiagnostics(projectId: string, runId?: string | null): Promise<void>
  onProjectChanged(listener: (event: ProjectChangedEvent) => void): () => void
  preflightQaSimulation(input: QaSimulationPreflightInput): Promise<QaSimulationPreflight>
  startQaSimulation(input: StartQaSimulationInput): Promise<QaSimulationJobSummary>
  getQaSimulationJob(projectId: string, jobId: string): Promise<QaSimulationJobSummary>
  getLatestQaSimulationJob(projectId: string): Promise<QaSimulationJobSummary | null>
  getQaSimulationPage(input: QaSimulationPageInput): Promise<QaSimulationPage>
  cancelQaSimulation(projectId: string, jobId: string): Promise<QaSimulationJobSummary>
  resumeQaSimulation(projectId: string, jobId: string): Promise<QaSimulationJobSummary>
  updateQaSimulationItem(input: UpdateQaSimulationItemInput): Promise<QaSimulationJobSummary>
  reviewQaSimulationItems(input: ReviewQaSimulationItemsInput): Promise<QaSimulationJobSummary>
  publishQaSimulation(input: PublishQaSimulationInput): Promise<QaSimulationJobSummary>
  onQaSimulationChanged(listener: (event: QaSimulationChangedEvent) => void): () => void
}

export const IPC_CHANNELS = {
  getSnapshot: 'qaing:snapshot:get',
  snapshotChanged: 'qaing:snapshot:changed',
  audioLevelChanged: 'qaing:audio:level',
  getQaWorkspacePage: 'qaing:workspace:get-page',
  deleteQaWorkspaceRound: 'qaing:workspace:delete-round',
  clearQaWorkspaceProject: 'qaing:workspace:clear-project',
  exportQaWorkspaceProject: 'qaing:workspace:export-project',
  qaWorkspaceChanged: 'qaing:workspace:changed',
  dispatch: 'qaing:command:dispatch',
  configureProvider: 'qaing:provider:configure',
  clearProvider: 'qaing:provider:clear',
  copyAnswer: 'qaing:answer:copy',
  importSourceDocuments: 'qaing:library:import-sources',
  importPresetQa: 'qaing:library:import-qa',
  deleteDocument: 'qaing:library:delete',
  openSystemPermissions: 'qaing:permissions:open',
  requestAudioPermission: 'qaing:permissions:request',
  restartApplication: 'qaing:application:restart',
  setAlwaysOnTop: 'qaing:window:always-on-top',
  getProjectState: 'qaing:project:get-state',
  selectProjectRoot: 'qaing:project:select-root',
  confirmProjectDirectories: 'qaing:project:confirm-directories',
  cancelProjectPreparation: 'qaing:project:cancel-preparation',
  activateProject: 'qaing:project:activate',
  startProjectSync: 'qaing:project:sync-start',
  cancelProjectSync: 'qaing:project:sync-cancel',
  retryProjectSync: 'qaing:project:sync-retry',
  setProjectSyncPolicy: 'qaing:project:set-policy',
  getProjectTaskPage: 'qaing:project:get-task-page',
  exportProjectDiagnostics: 'qaing:project:export-diagnostics',
  projectChanged: 'qaing:project:changed',
  preflightQaSimulation: 'qaing:simulation:preflight',
  startQaSimulation: 'qaing:simulation:start',
  getQaSimulationJob: 'qaing:simulation:get-job',
  getLatestQaSimulationJob: 'qaing:simulation:get-latest-job',
  getQaSimulationPage: 'qaing:simulation:get-page',
  cancelQaSimulation: 'qaing:simulation:cancel',
  resumeQaSimulation: 'qaing:simulation:resume',
  updateQaSimulationItem: 'qaing:simulation:update-item',
  reviewQaSimulationItems: 'qaing:simulation:review-items',
  publishQaSimulation: 'qaing:simulation:publish',
  qaSimulationChanged: 'qaing:simulation:changed',
} as const
