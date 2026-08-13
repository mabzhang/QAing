import type {
  AudioLevelSample,
  AudioPermissionRequestResult,
  ProjectDirectoryConfirmation,
  QaSimulationFence,
  QaSimulationJobSummary,
  QaSimulationPage,
  QaSimulationPreflight,
  QaSimulationPreflightInput,
  PublishQaSimulationInput,
  ReviewQaSimulationItemsInput,
  StartQaSimulationInput,
  UpdateQaSimulationItemInput,
  ProjectSemanticIndexSummary,
  ProjectSummary,
  ProjectSyncCounts,
  ProjectSyncPolicy,
  ProjectSyncRun,
  ProjectTaskFilter,
  ProjectTaskPage,
  ProjectUiErrorCode,
} from '../../core/contracts'
import type {
  AppMode,
  AppState,
  AudioSourceKind,
  QaWorkspacePage,
  RetrievalResult,
} from '../../core/types'

export type UiActionResult = void | Promise<void>

export type SettingsSection = 'general' | 'permissions' | 'audio' | 'retrieval'

export type ProviderKind = 'deepseek' | 'doubao_asr' | 'embedding'
export type CloudProviderKind = Exclude<ProviderKind, 'embedding'>

export interface ProviderStatus {
  readonly configured: boolean
  readonly maskedKey: string | null
}

export type DocumentKind = 'source_document' | 'preset_qa' | 'front_recording'
export type DocumentIndexStatus = 'ready' | 'pending' | 'failed'

export interface DocumentSummary {
  readonly id: string
  readonly title: string
  readonly kind: DocumentKind
  readonly chunkCount: number
  readonly indexStatus: DocumentIndexStatus
  readonly updatedAt: number
  readonly error: string | null
}

export interface UiAdapter {
  readonly switchMode: (mode: AppMode) => UiActionResult
  readonly selectAudioSource: (source: AudioSourceKind) => UiActionResult
  readonly start: () => UiActionResult
  readonly stopSession: () => UiActionResult
  readonly stopFront: () => UiActionResult
  readonly acknowledgeFrontComplete: () => UiActionResult
  readonly endQuestion: () => UiActionResult
  readonly endAnswer: () => UiActionResult
  readonly skipQuestion: () => UiActionResult
  readonly retry: () => UiActionResult
  readonly dismissError: () => UiActionResult
  readonly copyAnswer: (answer: string) => UiActionResult
  readonly configureProvider: (provider: CloudProviderKind, credential: string) => UiActionResult
  readonly clearProvider: (provider: CloudProviderKind) => UiActionResult
  readonly openPermission: (source: AudioSourceKind) => UiActionResult
  readonly requestAudioPermission: (source: AudioSourceKind) => Promise<AudioPermissionRequestResult>
  readonly restartApplication: () => UiActionResult
  readonly importSourceDocuments: () => UiActionResult
  readonly importPresetQa: () => UiActionResult
  readonly deleteDocument: (documentId: string) => UiActionResult
  readonly setAlwaysOnTop: (enabled: boolean) => UiActionResult
  readonly selectProjectRoot: () => UiActionResult
  readonly activateProject: (projectId: string) => UiActionResult
  readonly confirmProjectDirectories: (projectId: string) => UiActionResult
  readonly cancelProjectPreparation: (projectId: string) => UiActionResult
  readonly startProjectSync: (projectId: string) => UiActionResult
  readonly cancelProjectSync: (runId: string) => UiActionResult
  readonly retryFailedProjectSync: (projectId: string, runId: string | null) => UiActionResult
  readonly relocateProject: (projectId: string) => UiActionResult
  readonly setProjectSyncPolicy: (projectId: string, policy: ProjectSyncPolicy) => UiActionResult
  /** Renderer-only paging control; the integration layer calls getProjectTaskPage with this filter. */
  readonly setProjectTaskFilter: (filter: ProjectTaskFilter) => UiActionResult
  readonly loadMoreProjectTasks: () => UiActionResult
  readonly exportProjectDiagnostics: (projectId: string, runId: string | null) => UiActionResult
}

export type PermissionState =
  | 'checking'
  | 'prompt'
  | 'granted'
  | 'denied'
  | 'unavailable'

export type CaptureHealth =
  | 'idle'
  | 'starting'
  | 'healthy'
  | 'silent'
  | 'reconnecting'
  | 'paused'

export type RetrievalHealth = 'idle' | 'ready' | 'searching' | 'unavailable'

export interface KnowledgeBaseSummary {
  readonly presetQaCount: number
  readonly sourceDocumentCount: number
  readonly pendingIndexJobs: number
}

export interface UiEnvironment {
  readonly permissions: Readonly<Record<AudioSourceKind, PermissionState>>
  readonly captureHealth: CaptureHealth
  readonly alwaysOnTop: boolean
  readonly retrievalMode: RetrievalResult['mode']
  readonly retrievalHealth: RetrievalHealth
  readonly knowledgeBase: KnowledgeBaseSummary
  readonly providerStatuses: Readonly<Record<ProviderKind, ProviderStatus>>
  readonly documents: readonly DocumentSummary[]
}

export interface QaWorkspaceViewState {
  readonly page: QaWorkspacePage | null
  readonly loading: boolean
  readonly loadingMore: boolean
  readonly error: string | null
}

/**
 * Renderer projection of the lightweight project summary plus its separately
 * paged task list. No source body, absolute path, credential, or raw file
 * content is allowed in this view model.
 */
export interface ProjectUiState {
  readonly projects: readonly ProjectSummary[]
  readonly activeProjectId: string | null
  readonly activeProject: ProjectSummary | null
  readonly run: ProjectSyncRun | null
  readonly counts: ProjectSyncCounts
  readonly taskPage: ProjectTaskPage | null
  readonly taskFilter: ProjectTaskFilter
  readonly directoryConfirmation: ProjectDirectoryConfirmation | null
  readonly loading: boolean
  readonly loadingMore: boolean
  readonly errorCode: ProjectUiErrorCode | null
}

/**
 * Optional renderer integration point until the public preload bridge lands.
 * It is deliberately controlled: this shell never calls a model by itself.
 */
export interface SimulatedQaSlot {
  readonly job: QaSimulationJobSummary | null
  readonly page: QaSimulationPage | null
  readonly pageIndex: number
  readonly canPageBackward: boolean
  readonly busy: boolean
  readonly error: string | null
  readonly onPreflight: (input: QaSimulationPreflightInput) => Promise<QaSimulationPreflight>
  readonly onStart: (input: StartQaSimulationInput) => UiActionResult
  readonly onCancel: (projectId: string, jobId: string) => UiActionResult
  readonly onResume: (projectId: string, jobId: string) => UiActionResult
  readonly onPage: (
    projectId: string,
    jobId: string,
    direction: 'previous' | 'next',
    cursor: string | null,
    expectedDataRevision: number,
  ) => UiActionResult
  readonly onEdit: (input: UpdateQaSimulationItemInput) => UiActionResult
  readonly onReview: (input: ReviewQaSimulationItemsInput) => UiActionResult
  readonly onPublish: (input: PublishQaSimulationInput) => UiActionResult
}

export interface ProjectUiSlot {
  readonly state: ProjectUiState
}

export interface AppProps {
  readonly state: AppState
  readonly environment: UiEnvironment
  readonly adapter: UiAdapter
  readonly audioLevels?: readonly AudioLevelSample[]
  readonly qaWorkspace: QaWorkspaceViewState
  readonly onLoadMoreQaWorkspace: () => void
  readonly onRetryQaWorkspace: () => void
  readonly onDeleteQaWorkspaceRound: (projectId: string, roundId: string) => UiActionResult
  readonly onClearQaWorkspaceProject: (projectId: string) => UiActionResult
  readonly onExportQaWorkspaceProject: (projectId: string) => UiActionResult
  /** Optional until the project bridge is connected; absence is a truthful unselected state. */
  readonly project?: ProjectUiSlot
  /** Optional until the reviewed simulated-QA bridge is connected. */
  readonly simulatedQa?: SimulatedQaSlot
}

export type UiActionName =
  | 'switch-mode'
  | 'select-audio'
  | 'start'
  | 'stop-session'
  | 'stop-front'
  | 'acknowledge-front-complete'
  | 'end-question'
  | 'end-answer'
  | 'skip-question'
  | 'retry'
  | 'dismiss-error'
  | 'copy-answer'
  | 'configure-provider'
  | 'clear-provider'
  | 'open-permission'
  | 'request-permission'
  | 'restart-application'
  | 'import-source-documents'
  | 'import-preset-qa'
  | 'delete-document'
  | 'set-always-on-top'
  | 'select-project-root'
  | 'activate-project'
  | 'confirm-project-directories'
  | 'cancel-project-preparation'
  | 'start-project-sync'
  | 'cancel-project-sync'
  | 'retry-project-sync'
  | 'relocate-project'
  | 'set-project-sync-policy'
  | 'set-project-task-filter'
  | 'load-more-project-tasks'
  | 'export-project-diagnostics'
  | 'delete-qa-workspace-round'
  | 'clear-qa-workspace-project'
  | 'export-qa-workspace-project'

export type {
  ProjectSemanticIndexSummary,
  ProjectSummary,
  ProjectSyncPolicy,
  ProjectTaskFilter,
  QaSimulationFence,
}
