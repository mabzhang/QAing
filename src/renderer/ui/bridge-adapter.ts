import type {
  DocumentSummary as BridgeDocumentSummary,
  PublicSnapshot,
  PublicSnapshotUpdate,
  QaingBridge,
} from '../../core/contracts'
import type { AppState, AudioSourceKind } from '../../core/types'
import type {
  CaptureHealth,
  DocumentIndexStatus,
  DocumentSummary,
  PermissionState,
  ProviderKind,
  ProviderStatus,
  RetrievalHealth,
  UiAdapter,
  UiEnvironment,
} from './contracts'

const QAING_BRIDGE_METHODS = [
  'getSnapshot',
  'dispatch',
  'onSnapshot',
  'onAudioLevel',
  'getQaWorkspacePage',
  'deleteQaWorkspaceRound',
  'clearQaWorkspaceProject',
  'exportQaWorkspaceProject',
  'onQaWorkspaceChanged',
  'configureProvider',
  'clearProvider',
  'copyAnswer',
  'importSourceDocuments',
  'importPresetQa',
  'deleteDocument',
  'openSystemPermissions',
  'requestAudioPermission',
  'restartApplication',
  'setAlwaysOnTop',
  'getProjectState',
  'selectProjectRoot',
  'confirmProjectDirectories',
  'cancelProjectPreparation',
  'activateProject',
  'startProjectSync',
  'cancelProjectSync',
  'retryProjectSync',
  'setProjectSyncPolicy',
  'getProjectTaskPage',
  'exportProjectDiagnostics',
  'onProjectChanged',
  'preflightQaSimulation',
  'startQaSimulation',
  'getQaSimulationJob',
  'getLatestQaSimulationJob',
  'getQaSimulationPage',
  'cancelQaSimulation',
  'resumeQaSimulation',
  'updateQaSimulationItem',
  'reviewQaSimulationItems',
  'publishQaSimulation',
  'onQaSimulationChanged',
] as const satisfies readonly (keyof QaingBridge)[]

export function isQaingBridge(candidate: unknown): candidate is QaingBridge {
  if (typeof candidate !== 'object' || candidate === null) return false
  const record = candidate as Record<string, unknown>
  return QAING_BRIDGE_METHODS.every((method) => typeof record[method] === 'function')
}

export function mergeSnapshotUpdate(
  current: PublicSnapshot | null,
  update: PublicSnapshotUpdate,
): PublicSnapshot | null {
  if (update.library !== undefined) {
    return {
      app: update.app,
      runtime: update.runtime,
      library: update.library,
    }
  }
  if (current === null) return null
  return {
    app: update.app,
    runtime: update.runtime,
    library: current.library,
  }
}

function mapMicrophonePermission(
  permission: PublicSnapshot['runtime']['audioPermission'],
): PermissionState {
  switch (permission) {
    case 'granted': return 'granted'
    case 'denied': return 'denied'
    case 'restricted': return 'unavailable'
    case 'not_determined': return 'prompt'
    case 'unknown': return 'prompt'
  }
}

function mapSystemPermission(
  permission: PublicSnapshot['runtime']['screenAudioPermission'],
): PermissionState {
  switch (permission) {
    case 'granted': return 'granted'
    case 'denied': return 'denied'
    case 'not_determined': return 'prompt'
    case 'unknown': return 'prompt'
  }
}

function sessionIsCapturing(state: AppState): boolean {
  return state.mode === 'qa'
    ? state.qaPhase === 'listening'
    : state.frontPhase === 'recording'
}

function mapCaptureHealth(snapshot: PublicSnapshot): CaptureHealth {
  switch (snapshot.runtime.helperStatus) {
    case 'stopped': return 'idle'
    case 'starting': return 'starting'
    case 'recovering': return 'reconnecting'
    case 'failed': return 'paused'
    case 'silent': return 'silent'
    case 'ready': return sessionIsCapturing(snapshot.app) ? 'healthy' : 'idle'
  }
}

function mapRetrievalHealth(snapshot: PublicSnapshot): RetrievalHealth {
  if (snapshot.runtime.retrievalMode === 'index_loading') return 'searching'
  if (snapshot.runtime.retrievalMode === 'keyword_fallback') return 'unavailable'
  const qaSearching = snapshot.app.mode === 'qa' && (
    snapshot.app.qaPhase === 'listening' || snapshot.app.qaPhase === 'finalizing'
  ) && snapshot.app.revision > 0
  return qaSearching ? 'searching' : 'ready'
}

function emptyProviderStatuses(
  retrievalMode: PublicSnapshot['runtime']['retrievalMode'],
): Record<ProviderKind, ProviderStatus> {
  return {
    deepseek: { configured: false, maskedKey: null },
    doubao_asr: { configured: false, maskedKey: null },
    embedding: {
      configured: retrievalMode === 'hybrid',
      maskedKey: null,
    },
  }
}

function mapProviderStatuses(snapshot: PublicSnapshot): Readonly<Record<ProviderKind, ProviderStatus>> {
  const statuses = emptyProviderStatuses(snapshot.runtime.retrievalMode)
  for (const status of snapshot.runtime.providerStatuses) {
    statuses[status.provider] = {
      configured: status.configured,
      maskedKey: status.maskedKey,
    }
  }
  return statuses
}

function mapDocumentStatus(status: BridgeDocumentSummary['status']): DocumentIndexStatus {
  switch (status) {
    case 'indexed': return 'ready'
    case 'pending': return 'pending'
    case 'failed': return 'failed'
  }
}

function mapDocument(document: BridgeDocumentSummary): DocumentSummary {
  return {
    id: document.id,
    title: document.title,
    kind: document.kind,
    chunkCount: document.chunkCount,
    indexStatus: mapDocumentStatus(document.status),
    updatedAt: document.createdAt,
    error: document.error,
  }
}

export function mapSnapshotToEnvironment(snapshot: PublicSnapshot): UiEnvironment {
  const documents = snapshot.library.map(mapDocument)
  return {
    permissions: {
      microphone: mapMicrophonePermission(snapshot.runtime.audioPermission),
      system: mapSystemPermission(snapshot.runtime.screenAudioPermission),
    },
    captureHealth: mapCaptureHealth(snapshot),
    alwaysOnTop: snapshot.runtime.alwaysOnTop,
    retrievalMode: snapshot.runtime.retrievalMode === 'keyword_fallback'
      ? 'keyword_fallback'
      : 'hybrid',
    retrievalHealth: mapRetrievalHealth(snapshot),
    knowledgeBase: {
      presetQaCount: documents.filter((document) => document.kind === 'preset_qa').length,
      sourceDocumentCount: documents.filter((document) => document.kind !== 'preset_qa').length,
      pendingIndexJobs: documents.filter((document) => document.indexStatus === 'pending').length,
    },
    providerStatuses: mapProviderStatuses(snapshot),
    documents,
  }
}

function permissionKind(source: AudioSourceKind): 'microphone' | 'screen_audio' {
  return source === 'microphone' ? 'microphone' : 'screen_audio'
}

export function createUiAdapter(bridge: QaingBridge): UiAdapter {
  return {
    switchMode: async (mode) => bridge.dispatch({ type: 'switch_mode', mode }),
    selectAudioSource: async (source) => bridge.dispatch({ type: 'select_audio_source', source }),
    start: async () => bridge.dispatch({ type: 'start_session' }),
    stopSession: async () => bridge.dispatch({ type: 'stop_session' }),
    stopFront: async () => bridge.dispatch({ type: 'stop_front' }),
    acknowledgeFrontComplete: async () => bridge.dispatch({ type: 'acknowledge_front_complete' }),
    endQuestion: async () => bridge.dispatch({ type: 'end_question' }),
    endAnswer: async () => bridge.dispatch({ type: 'end_answer' }),
    skipQuestion: async () => bridge.dispatch({ type: 'skip_question' }),
    retry: async () => bridge.dispatch({ type: 'retry' }),
    dismissError: async () => bridge.dispatch({ type: 'dismiss_error' }),
    copyAnswer: async (answer) => bridge.copyAnswer(answer),
    configureProvider: async (provider, credential) => {
      await bridge.configureProvider(provider, credential)
    },
    clearProvider: async (provider) => {
      await bridge.clearProvider(provider)
    },
    openPermission: async (source) => bridge.openSystemPermissions(permissionKind(source)),
    requestAudioPermission: async (source) => bridge.requestAudioPermission(source),
    restartApplication: async () => bridge.restartApplication(),
    importSourceDocuments: async () => { await bridge.importSourceDocuments() },
    importPresetQa: async () => { await bridge.importPresetQa() },
    deleteDocument: async (documentId) => bridge.deleteDocument(documentId),
    setAlwaysOnTop: async (enabled) => bridge.setAlwaysOnTop(enabled),
    selectProjectRoot: async () => { await bridge.selectProjectRoot() },
    activateProject: async (projectId) => { await bridge.activateProject(projectId) },
    confirmProjectDirectories: async (projectId) => { await bridge.confirmProjectDirectories(projectId) },
    cancelProjectPreparation: async (projectId) => { await bridge.cancelProjectPreparation(projectId) },
    startProjectSync: async (projectId) => { await bridge.startProjectSync(projectId) },
    cancelProjectSync: async (runId) => { await bridge.cancelProjectSync(runId) },
    retryFailedProjectSync: async (projectId, runId) => { await bridge.retryProjectSync(projectId, runId) },
    relocateProject: async (projectId) => { await bridge.selectProjectRoot(projectId) },
    setProjectSyncPolicy: async (projectId, policy) => { await bridge.setProjectSyncPolicy(projectId, policy) },
    // Project task paging is renderer state. RendererRoot must replace these
    // callbacks with generation-fenced implementations when it supplies the
    // project slot to App. Fail visibly if integration is incomplete instead
    // of pretending that a filter/page request succeeded.
    setProjectTaskFilter: async () => { throw new Error('PROJECT_TASK_PAGING_NOT_BOUND') },
    loadMoreProjectTasks: async () => { throw new Error('PROJECT_TASK_PAGING_NOT_BOUND') },
    exportProjectDiagnostics: async (projectId, runId) => { await bridge.exportProjectDiagnostics(projectId, runId) },
  }
}
