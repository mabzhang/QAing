import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type QaingBridge } from '../core/contracts'

async function invoke<TResult>(channel: string, ...args: unknown[]): Promise<TResult> {
  return await ipcRenderer.invoke(channel, ...args) as TResult
}

const bridge: QaingBridge = {
  getSnapshot: async () => invoke(IPC_CHANNELS.getSnapshot),
  dispatch: async (command) => invoke(IPC_CHANNELS.dispatch, command),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]): void => listener(snapshot)
    ipcRenderer.on(IPC_CHANNELS.snapshotChanged, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.snapshotChanged, handler)
  },
  onAudioLevel: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, sample: Parameters<typeof listener>[0]): void => listener(sample)
    ipcRenderer.on(IPC_CHANNELS.audioLevelChanged, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.audioLevelChanged, handler)
  },
  getQaWorkspacePage: async (input) => invoke(IPC_CHANNELS.getQaWorkspacePage, input),
  deleteQaWorkspaceRound: async (projectId, roundId) => invoke(IPC_CHANNELS.deleteQaWorkspaceRound, projectId, roundId),
  clearQaWorkspaceProject: async (projectId) => invoke(IPC_CHANNELS.clearQaWorkspaceProject, projectId),
  exportQaWorkspaceProject: async (projectId) => invoke(IPC_CHANNELS.exportQaWorkspaceProject, projectId),
  onQaWorkspaceChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, update: Parameters<typeof listener>[0]): void => listener(update)
    ipcRenderer.on(IPC_CHANNELS.qaWorkspaceChanged, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.qaWorkspaceChanged, handler)
  },
  configureProvider: async (provider, apiKey) => invoke(IPC_CHANNELS.configureProvider, provider, apiKey),
  clearProvider: async (provider) => invoke(IPC_CHANNELS.clearProvider, provider),
  copyAnswer: async (text) => invoke(IPC_CHANNELS.copyAnswer, text),
  importSourceDocuments: async () => invoke(IPC_CHANNELS.importSourceDocuments),
  importPresetQa: async () => invoke(IPC_CHANNELS.importPresetQa),
  deleteDocument: async (documentId) => invoke(IPC_CHANNELS.deleteDocument, documentId),
  openSystemPermissions: async (kind) => invoke(IPC_CHANNELS.openSystemPermissions, kind),
  requestAudioPermission: async (source) => invoke(IPC_CHANNELS.requestAudioPermission, source),
  restartApplication: async () => invoke(IPC_CHANNELS.restartApplication),
  setAlwaysOnTop: async (enabled) => invoke(IPC_CHANNELS.setAlwaysOnTop, enabled),
  getProjectState: async () => invoke(IPC_CHANNELS.getProjectState),
  selectProjectRoot: async (projectId) => invoke(IPC_CHANNELS.selectProjectRoot, projectId),
  confirmProjectDirectories: async (projectId) => invoke(IPC_CHANNELS.confirmProjectDirectories, projectId),
  cancelProjectPreparation: async (projectId) => invoke(IPC_CHANNELS.cancelProjectPreparation, projectId),
  activateProject: async (projectId) => invoke(IPC_CHANNELS.activateProject, projectId),
  startProjectSync: async (projectId) => invoke(IPC_CHANNELS.startProjectSync, projectId),
  cancelProjectSync: async (runId) => invoke(IPC_CHANNELS.cancelProjectSync, runId),
  retryProjectSync: async (projectId, runId) => invoke(IPC_CHANNELS.retryProjectSync, projectId, runId),
  setProjectSyncPolicy: async (projectId, policy) => invoke(IPC_CHANNELS.setProjectSyncPolicy, projectId, policy),
  getProjectTaskPage: async (input) => invoke(IPC_CHANNELS.getProjectTaskPage, input),
  exportProjectDiagnostics: async (projectId, runId) => invoke(IPC_CHANNELS.exportProjectDiagnostics, projectId, runId),
  onProjectChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, update: Parameters<typeof listener>[0]): void => listener(update)
    ipcRenderer.on(IPC_CHANNELS.projectChanged, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.projectChanged, handler)
  },
  preflightQaSimulation: async (input) => invoke(IPC_CHANNELS.preflightQaSimulation, input),
  startQaSimulation: async (input) => invoke(IPC_CHANNELS.startQaSimulation, input),
  getQaSimulationJob: async (projectId, jobId) => invoke(IPC_CHANNELS.getQaSimulationJob, projectId, jobId),
  getLatestQaSimulationJob: async (projectId) => invoke(IPC_CHANNELS.getLatestQaSimulationJob, projectId),
  getQaSimulationPage: async (input) => invoke(IPC_CHANNELS.getQaSimulationPage, input),
  cancelQaSimulation: async (projectId, jobId) => invoke(IPC_CHANNELS.cancelQaSimulation, projectId, jobId),
  resumeQaSimulation: async (projectId, jobId) => invoke(IPC_CHANNELS.resumeQaSimulation, projectId, jobId),
  updateQaSimulationItem: async (input) => invoke(IPC_CHANNELS.updateQaSimulationItem, input),
  reviewQaSimulationItems: async (input) => invoke(IPC_CHANNELS.reviewQaSimulationItems, input),
  publishQaSimulation: async (input) => invoke(IPC_CHANNELS.publishQaSimulation, input),
  onQaSimulationChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, update: Parameters<typeof listener>[0]): void => listener(update)
    ipcRenderer.on(IPC_CHANNELS.qaSimulationChanged, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.qaSimulationChanged, handler)
  },
}

contextBridge.exposeInMainWorld('qaing', Object.freeze(bridge))
