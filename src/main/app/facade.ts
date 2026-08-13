import type {
  AppCommand,
  AudioPermissionRequestResult,
  DocumentSummary,
  ProviderName,
  ProviderStatus,
  ProjectChangedEvent,
  ProjectPublicState,
  ProjectSelectionResult,
  ProjectSummary,
  ProjectSyncPolicy,
  ProjectSyncRun,
  ProjectTaskPage,
  ProjectTaskPageInput,
  PublishQaSimulationInput,
  QaSimulationChangedEvent,
  QaSimulationJobSummary,
  QaSimulationPage,
  QaSimulationPageInput,
  QaSimulationPreflight,
  QaSimulationPreflightInput,
  QaWorkspaceClearResult,
  QaWorkspaceDeleteResult,
  QaWorkspacePageInput,
  PublicSnapshot,
  PublicSnapshotUpdate,
  RuntimeStatus,
  ReviewQaSimulationItemsInput,
  StartQaSimulationInput,
  UpdateQaSimulationItemInput,
} from '../../core/contracts'
import type { AppState, QaWorkspaceChanged, QaWorkspacePage } from '../../core/types'
import type { CredentialVault } from '../security/credential-vault'
import type { ApplicationController } from './controller'
import type { DesktopFacade } from '../ipc/register'

type ControllerPort = Pick<ApplicationController, 'getState' | 'subscribe' | 'dispatch' | 'dispose'>
type VaultPort = Pick<CredentialVault, 'set' | 'clear' | 'statuses'>

export interface QaWorkspaceService {
  getPage(input: QaWorkspacePageInput): Promise<QaWorkspacePage>
  deleteRound(projectId: string, roundId: string): Promise<QaWorkspaceDeleteResult>
  clearProject(projectId: string): Promise<QaWorkspaceClearResult>
  exportProject(projectId: string): Promise<void>
  subscribe(listener: (event: QaWorkspaceChanged) => void): () => void
}

export interface ProjectApplicationService {
  getState(): Promise<ProjectPublicState>
  selectRoot(projectId?: string): Promise<ProjectSelectionResult>
  confirmDirectories(projectId: string): Promise<ProjectSummary>
  cancelPreparation(projectId: string): Promise<void>
  activate(projectId: string): Promise<ProjectSummary>
  startSync(projectId: string): Promise<ProjectSyncRun>
  cancelSync(runId: string): Promise<void>
  retrySync(projectId: string, runId?: string | null): Promise<ProjectSyncRun>
  setSyncPolicy(projectId: string, policy: ProjectSyncPolicy): Promise<ProjectSummary>
  getTaskPage(input: ProjectTaskPageInput): Promise<ProjectTaskPage>
  exportDiagnostics(projectId: string, runId?: string | null): Promise<void>
  subscribe(listener: (event: ProjectChangedEvent) => void): () => void
  dispose?(): Promise<void>
}

export interface QaSimulationApplicationService {
  preflight(input: QaSimulationPreflightInput): Promise<QaSimulationPreflight>
  start(input: StartQaSimulationInput): Promise<QaSimulationJobSummary>
  getJob(projectId: string, jobId: string): Promise<QaSimulationJobSummary>
  getLatestJob(projectId: string): Promise<QaSimulationJobSummary | null>
  getPage(input: QaSimulationPageInput): Promise<QaSimulationPage>
  cancel(projectId: string, jobId: string): Promise<QaSimulationJobSummary>
  resume(projectId: string, jobId: string): Promise<QaSimulationJobSummary>
  updateItem(input: UpdateQaSimulationItemInput): Promise<QaSimulationJobSummary>
  reviewItems(input: ReviewQaSimulationItemsInput): Promise<QaSimulationJobSummary>
  publish(input: PublishQaSimulationInput): Promise<QaSimulationJobSummary>
  subscribe(listener: (event: QaSimulationChangedEvent) => void): () => void
  dispose?(): Promise<void>
}

const EMPTY_PROJECT_COUNTS = {
  added: 0,
  changed: 0,
  deleted: 0,
  awaitingAgent: 0,
  failed: 0,
  actionRequired: 0,
  completed: 0,
  total: 0,
} as const

const EMPTY_PROJECT_SERVICE: ProjectApplicationService = {
  getState: async () => ({
    projects: [],
    activeProjectId: null,
    run: null,
    counts: EMPTY_PROJECT_COUNTS,
    directoryConfirmation: null,
    dataRevision: 0,
  }),
  selectRoot: async () => ({ status: 'cancelled' }),
  confirmDirectories: async () => { throw new Error('PROJECT_NOT_FOUND') },
  cancelPreparation: async () => undefined,
  activate: async () => { throw new Error('PROJECT_NOT_FOUND') },
  startSync: async () => { throw new Error('PROJECT_NOT_FOUND') },
  cancelSync: async () => undefined,
  retrySync: async () => { throw new Error('PROJECT_NOT_FOUND') },
  setSyncPolicy: async () => { throw new Error('PROJECT_NOT_FOUND') },
  getTaskPage: async () => ({ items: [], nextCursor: null, dataRevision: 0 }),
  exportDiagnostics: async () => undefined,
  subscribe: () => () => undefined,
}

export interface LibraryService {
  listDocuments(): Promise<readonly DocumentSummary[]>
  importSourceDocuments(): Promise<readonly DocumentSummary[]>
  importPresetQa(): Promise<readonly DocumentSummary[]>
  deleteDocument(documentId: string): Promise<void>
  dispose?(): Promise<void>
}

export interface RuntimeProbe {
  getStatus(): Promise<Omit<RuntimeStatus, 'providerStatuses'>>
  openSystemPermissions(kind: 'microphone' | 'screen_audio'): Promise<void>
  requestAudioPermission(source: 'microphone' | 'system'): Promise<AudioPermissionRequestResult>
  restartApplication(): Promise<void>
  setAlwaysOnTop(enabled: boolean): Promise<void>
  onProviderChanged?(provider: ProviderName): Promise<void>
  subscribe?(listener: (scope?: 'runtime' | 'library') => void): () => void
}

type SnapshotListener = (snapshot: PublicSnapshotUpdate) => void
interface SnapshotBuild {
  readonly snapshot: PublicSnapshot
  readonly libraryVersion: number
  readonly runtimeGeneration: number
  readonly providerStatusesGeneration: number
}

/**
 * Keeps the high-frequency renderer snapshot limited to live controls and the
 * visible transcript. Complete answers, sources and committed history are
 * available through the independently paged QA workspace channel instead of
 * being structured-cloned again for every ASR partial.
 */
export function projectPublicAppState(state: AppState): AppState {
  return {
    ...state,
    candidateAnswer: '',
    candidateQuestion: '',
    candidateSources: [],
    candidateRetrievalRoute: null,
    lockedAnswer: '',
    lockedQuestionIdentity: '',
    lockedRetrievalRoute: null,
    sources: [],
    history: [],
  }
}

function sessionOwnsKnowledgeVersion(state: AppState): boolean {
  return state.mode === 'qa'
    ? state.qaPhase !== 'idle'
    : state.frontPhase !== 'idle' && state.frontPhase !== 'complete'
}

export class DesktopApplicationFacade implements DesktopFacade {
  readonly #controller: ControllerPort
  readonly #vault: VaultPort
  readonly #library: LibraryService
  readonly #runtime: RuntimeProbe
  readonly #workspace: QaWorkspaceService
  readonly #project: ProjectApplicationService
  readonly #simulation: QaSimulationApplicationService | null
  readonly #listeners = new Set<SnapshotListener>()
  readonly #unsubscribeController: () => void
  readonly #unsubscribeRuntime: (() => void) | null
  #refreshSequence = 0
  #latestSnapshot: PublicSnapshot | null = null
  #libraryCache: readonly DocumentSummary[] | null = null
  #libraryLoad: Promise<readonly DocumentSummary[]> | null = null
  #runtimeCache: Omit<RuntimeStatus, 'providerStatuses'> | null = null
  #runtimeLoad: Promise<Omit<RuntimeStatus, 'providerStatuses'>> | null = null
  #providerStatusesCache: readonly ProviderStatus[] | null = null
  #providerStatusesLoad: Promise<readonly ProviderStatus[]> | null = null
  #libraryVersion = 0
  #publishedLibraryVersion = -1
  #runtimeGeneration = 0
  #runtimeLoadGeneration = -1
  #libraryLoadGeneration = -1
  #providerStatusesGeneration = 0
  #providerStatusesLoadGeneration = -1
  #latestLibraryVersion = -1
  #latestRuntimeGeneration = -1
  #latestProviderStatusesGeneration = -1
  #disposed = false

  constructor(input: {
    readonly controller: ControllerPort
    readonly vault: VaultPort
    readonly library: LibraryService
    readonly runtime: RuntimeProbe
    readonly workspace?: QaWorkspaceService
    readonly project?: ProjectApplicationService
    readonly simulation?: QaSimulationApplicationService
  }) {
    this.#controller = input.controller
    this.#vault = input.vault
    this.#library = input.library
    this.#runtime = input.runtime
    this.#workspace = input.workspace ?? {
      getPage: async (request) => ({
        projectId: request.projectId,
        totalRounds: 0,
        items: [],
        nextCursor: null,
        dataRevision: 0,
      }),
      deleteRound: async () => ({ deleted: false, dataRevision: 0 }),
      clearProject: async () => ({ deletedRounds: 0, deletedTurns: 0, dataRevision: 0 }),
      exportProject: async () => undefined,
      subscribe: () => () => undefined,
    }
    this.#project = input.project ?? EMPTY_PROJECT_SERVICE
    this.#simulation = input.simulation ?? null
    this.#unsubscribeController = this.#controller.subscribe(() => {
      void this.#refreshAndPublish()
    })
    this.#unsubscribeRuntime = this.#runtime.subscribe?.((scope) => {
      this.#runtimeCache = null
      this.#runtimeGeneration += 1
      if (scope === 'library') {
        this.#invalidateLibrary()
      }
      void this.#refreshAndPublish()
    }) ?? null
  }

  async getSnapshot(): Promise<PublicSnapshot> {
    if (
      this.#latestSnapshot !== null &&
      this.#latestLibraryVersion === this.#libraryVersion &&
      this.#latestRuntimeGeneration === this.#runtimeGeneration &&
      this.#latestProviderStatusesGeneration === this.#providerStatusesGeneration
    ) {
      return this.#latestSnapshot
    }
    return (await this.#currentBuild()).snapshot
  }

  async getQaWorkspacePage(input: QaWorkspacePageInput): Promise<QaWorkspacePage> {
    return this.#workspace.getPage(input)
  }

  async deleteQaWorkspaceRound(projectId: string, roundId: string): Promise<QaWorkspaceDeleteResult> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) {
      return Promise.reject(new Error('QA_WORKSPACE_SESSION_ACTIVE'))
    }
    return this.#workspace.deleteRound(projectId, roundId)
  }

  async clearQaWorkspaceProject(projectId: string): Promise<QaWorkspaceClearResult> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) {
      return Promise.reject(new Error('QA_WORKSPACE_SESSION_ACTIVE'))
    }
    return this.#workspace.clearProject(projectId)
  }

  exportQaWorkspaceProject(projectId: string): Promise<void> {
    return this.#workspace.exportProject(projectId)
  }

  subscribeQaWorkspace(listener: (event: QaWorkspaceChanged) => void): () => void {
    return this.#workspace.subscribe(listener)
  }

  async getProjectState(): Promise<ProjectPublicState> {
    return this.#project.getState()
  }

  async selectProjectRoot(projectId?: string): Promise<ProjectSelectionResult> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) return Promise.reject(new Error('PROJECT_SWITCH_SESSION_ACTIVE'))
    return this.#project.selectRoot(projectId)
  }

  async confirmProjectDirectories(projectId: string): Promise<ProjectSummary> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) return Promise.reject(new Error('PROJECT_SWITCH_SESSION_ACTIVE'))
    return this.#project.confirmDirectories(projectId)
  }

  cancelProjectPreparation(projectId: string): Promise<void> {
    return this.#project.cancelPreparation(projectId)
  }

  async activateProject(projectId: string): Promise<ProjectSummary> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) return Promise.reject(new Error('PROJECT_SWITCH_SESSION_ACTIVE'))
    return this.#project.activate(projectId)
  }

  async startProjectSync(projectId: string): Promise<ProjectSyncRun> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) {
      return Promise.reject(new Error('PROJECT_SWITCH_SESSION_ACTIVE'))
    }
    return this.#project.startSync(projectId)
  }

  cancelProjectSync(runId: string): Promise<void> {
    return this.#project.cancelSync(runId)
  }

  async retryProjectSync(projectId: string, runId?: string | null): Promise<ProjectSyncRun> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) {
      return Promise.reject(new Error('PROJECT_SWITCH_SESSION_ACTIVE'))
    }
    return this.#project.retrySync(projectId, runId)
  }

  async setProjectSyncPolicy(projectId: string, policy: ProjectSyncPolicy): Promise<ProjectSummary> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) {
      return Promise.reject(new Error('PROJECT_SWITCH_SESSION_ACTIVE'))
    }
    return this.#project.setSyncPolicy(projectId, policy)
  }

  getProjectTaskPage(input: ProjectTaskPageInput): Promise<ProjectTaskPage> {
    return this.#project.getTaskPage(input)
  }

  exportProjectDiagnostics(projectId: string, runId?: string | null): Promise<void> {
    return this.#project.exportDiagnostics(projectId, runId)
  }

  subscribeProject(listener: (event: ProjectChangedEvent) => void): () => void {
    return this.#project.subscribe(listener)
  }

  async preflightQaSimulation(input: QaSimulationPreflightInput): Promise<QaSimulationPreflight> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) {
      return Promise.reject(new Error('QA_SIMULATION_SESSION_ACTIVE'))
    }
    return this.#requireSimulation().preflight(input)
  }

  async startQaSimulation(input: StartQaSimulationInput): Promise<QaSimulationJobSummary> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) {
      return Promise.reject(new Error('QA_SIMULATION_SESSION_ACTIVE'))
    }
    return this.#requireSimulation().start(input)
  }

  getQaSimulationJob(projectId: string, jobId: string): Promise<QaSimulationJobSummary> {
    return this.#requireSimulation().getJob(projectId, jobId)
  }

  getLatestQaSimulationJob(projectId: string): Promise<QaSimulationJobSummary | null> {
    return this.#requireSimulation().getLatestJob(projectId)
  }

  getQaSimulationPage(input: QaSimulationPageInput): Promise<QaSimulationPage> {
    return this.#requireSimulation().getPage(input)
  }

  cancelQaSimulation(projectId: string, jobId: string): Promise<QaSimulationJobSummary> {
    return this.#requireSimulation().cancel(projectId, jobId)
  }

  async resumeQaSimulation(projectId: string, jobId: string): Promise<QaSimulationJobSummary> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) {
      return Promise.reject(new Error('QA_SIMULATION_SESSION_ACTIVE'))
    }
    return this.#requireSimulation().resume(projectId, jobId)
  }

  updateQaSimulationItem(input: UpdateQaSimulationItemInput): Promise<QaSimulationJobSummary> {
    return this.#requireSimulation().updateItem(input)
  }

  reviewQaSimulationItems(input: ReviewQaSimulationItemsInput): Promise<QaSimulationJobSummary> {
    return this.#requireSimulation().reviewItems(input)
  }

  async publishQaSimulation(input: PublishQaSimulationInput): Promise<QaSimulationJobSummary> {
    if (sessionOwnsKnowledgeVersion(this.#controller.getState())) {
      return Promise.reject(new Error('QA_SIMULATION_SESSION_ACTIVE'))
    }
    return this.#requireSimulation().publish(input)
  }

  subscribeQaSimulation(listener: (event: QaSimulationChangedEvent) => void): () => void {
    return this.#simulation?.subscribe(listener) ?? (() => undefined)
  }

  subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener)
    const expectedLibraryVersion = this.#libraryVersion
    const expectedRuntimeGeneration = this.#runtimeGeneration
    const expectedProviderStatusesGeneration = this.#providerStatusesGeneration
    void this.#buildSnapshot().then((build) => {
      if (this.#disposed || !this.#listeners.has(listener)) return
      if (
        expectedLibraryVersion !== this.#libraryVersion ||
        expectedRuntimeGeneration !== this.#runtimeGeneration ||
        expectedProviderStatusesGeneration !== this.#providerStatusesGeneration ||
        !this.#isCurrentBuild(build)
      ) {
        void this.#publishCurrentFullTo(listener)
        return
      }
      listener(build.snapshot)
      this.#publishedLibraryVersion = expectedLibraryVersion
    })
    return () => this.#listeners.delete(listener)
  }

  async dispatch(command: AppCommand): Promise<void> {
    await this.#controller.dispatch(command)
    await this.#refreshAndPublish()
  }

  async configureProvider(provider: ProviderName, apiKey: string): Promise<ProviderStatus> {
    const status = await this.#vault.set(provider, apiKey)
    this.#providerStatusesGeneration += 1
    this.#providerStatusesCache = this.#mergeProviderStatus(status)
    await this.#runtime.onProviderChanged?.(provider)
    await this.#refreshAndPublish()
    return status
  }

  async clearProvider(provider: ProviderName): Promise<ProviderStatus> {
    const status = await this.#vault.clear(provider)
    this.#providerStatusesGeneration += 1
    this.#providerStatusesCache = this.#mergeProviderStatus(status)
    await this.#runtime.onProviderChanged?.(provider)
    await this.#refreshAndPublish()
    return status
  }

  async importSourceDocuments(): Promise<readonly DocumentSummary[]> {
    await this.#assertLegacyLibraryWritable()
    const result = await this.#library.importSourceDocuments()
    this.#setLibraryCache(result)
    await this.#refreshAndPublish()
    return result
  }

  async importPresetQa(): Promise<readonly DocumentSummary[]> {
    await this.#assertLegacyLibraryWritable()
    const result = await this.#library.importPresetQa()
    this.#setLibraryCache(result)
    await this.#refreshAndPublish()
    return result
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.#assertLegacyLibraryWritable()
    await this.#library.deleteDocument(documentId)
    this.#invalidateLibrary()
    await this.#refreshAndPublish()
  }

  async openSystemPermissions(kind: 'microphone' | 'screen_audio'): Promise<void> {
    await this.#runtime.openSystemPermissions(kind)
  }

  async requestAudioPermission(source: 'microphone' | 'system'): Promise<AudioPermissionRequestResult> {
    const result = await this.#runtime.requestAudioPermission(source)
    this.#runtimeCache = null
    this.#runtimeGeneration += 1
    await this.#refreshAndPublish()
    return result
  }

  async restartApplication(): Promise<void> {
    await this.#runtime.restartApplication()
  }

  async setAlwaysOnTop(enabled: boolean): Promise<void> {
    await this.#runtime.setAlwaysOnTop(enabled)
    this.#runtimeCache = null
    this.#runtimeGeneration += 1
    await this.#refreshAndPublish()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribeController()
    this.#unsubscribeRuntime?.()
    this.#listeners.clear()
    await this.#controller.dispose()
    await this.#library.dispose?.()
    await this.#project.dispose?.()
    await this.#simulation?.dispose?.()
  }

  async #refreshAndPublish(): Promise<PublicSnapshot> {
    const sequence = ++this.#refreshSequence
    const build = await this.#buildSnapshot()
    const snapshot = build.snapshot
    if (this.#disposed || sequence !== this.#refreshSequence || !this.#isCurrentBuild(build)) {
      return snapshot
    }
    this.#latestSnapshot = snapshot
    this.#latestLibraryVersion = this.#libraryVersion
    this.#latestRuntimeGeneration = this.#runtimeGeneration
    this.#latestProviderStatusesGeneration = this.#providerStatusesGeneration
    const includeLibrary = this.#publishedLibraryVersion !== this.#libraryVersion
    const update: PublicSnapshotUpdate = includeLibrary
      ? snapshot
      : { app: snapshot.app, runtime: snapshot.runtime }
    for (const listener of this.#listeners) listener(update)
    if (includeLibrary && this.#listeners.size > 0) {
      this.#publishedLibraryVersion = this.#libraryVersion
    }
    return snapshot
  }

  async #buildSnapshot(): Promise<SnapshotBuild> {
    const libraryVersion = this.#libraryVersion
    const runtimeGeneration = this.#runtimeGeneration
    const providerStatusesGeneration = this.#providerStatusesGeneration
    const [runtime, providerStatuses, library] = await Promise.all([
      this.#runtimeStatus(),
      this.#providerStatuses(),
      this.#libraryDocuments(),
    ])
    return {
      snapshot: {
        app: projectPublicAppState(this.#controller.getState()),
        runtime: { ...runtime, providerStatuses },
        library,
      },
      libraryVersion,
      runtimeGeneration,
      providerStatusesGeneration,
    }
  }

  async #currentBuild(): Promise<SnapshotBuild> {
    for (;;) {
      const build = await this.#buildSnapshot()
      if (this.#isCurrentBuild(build)) return build
    }
  }

  async #publishCurrentFullTo(listener: SnapshotListener): Promise<void> {
    for (;;) {
      const build = await this.#currentBuild()
      if (this.#disposed || !this.#listeners.has(listener)) return
      // No await occurs between this final generation check and publication.
      if (!this.#isCurrentBuild(build)) continue
      listener(build.snapshot)
      this.#publishedLibraryVersion = build.libraryVersion
      return
    }
  }

  #isCurrentBuild(build: SnapshotBuild): boolean {
    return (
      build.libraryVersion === this.#libraryVersion &&
      build.runtimeGeneration === this.#runtimeGeneration &&
      build.providerStatusesGeneration === this.#providerStatusesGeneration
    )
  }

  async #runtimeStatus(): Promise<Omit<RuntimeStatus, 'providerStatuses'>> {
    if (this.#runtimeCache !== null) return this.#runtimeCache
    const generation = this.#runtimeGeneration
    if (this.#runtimeLoad !== null && this.#runtimeLoadGeneration === generation) return this.#runtimeLoad
    const load = this.#runtime.getStatus().then((status) => {
      if (generation === this.#runtimeGeneration) this.#runtimeCache = status
      return status
    }).finally(() => {
      if (this.#runtimeLoad === load) this.#runtimeLoad = null
    })
    this.#runtimeLoad = load
    this.#runtimeLoadGeneration = generation
    return load
  }

  async #libraryDocuments(): Promise<readonly DocumentSummary[]> {
    if (this.#libraryCache !== null) return this.#libraryCache
    const generation = this.#libraryVersion
    if (this.#libraryLoad !== null && this.#libraryLoadGeneration === generation) return this.#libraryLoad
    const load = this.#library.listDocuments().then((documents) => {
      if (generation === this.#libraryVersion) this.#libraryCache = documents
      return documents
    }).finally(() => {
      if (this.#libraryLoad === load) this.#libraryLoad = null
    })
    this.#libraryLoad = load
    this.#libraryLoadGeneration = generation
    return load
  }

  async #providerStatuses(): Promise<readonly ProviderStatus[]> {
    if (this.#providerStatusesCache !== null) return this.#providerStatusesCache
    const generation = this.#providerStatusesGeneration
    if (this.#providerStatusesLoad !== null && this.#providerStatusesLoadGeneration === generation) {
      return this.#providerStatusesLoad
    }
    const load = this.#providerStatusesSafely().then((statuses) => {
      if (generation === this.#providerStatusesGeneration) this.#providerStatusesCache = statuses
      return statuses
    }).finally(() => {
      if (this.#providerStatusesLoad === load) this.#providerStatusesLoad = null
    })
    this.#providerStatusesLoad = load
    this.#providerStatusesLoadGeneration = generation
    return load
  }

  #setLibraryCache(documents: readonly DocumentSummary[]): void {
    this.#libraryCache = documents
    this.#libraryVersion += 1
    this.#latestSnapshot = null
    this.#latestLibraryVersion = -1
  }

  #invalidateLibrary(): void {
    this.#libraryCache = null
    this.#libraryVersion += 1
    this.#latestSnapshot = null
    this.#latestLibraryVersion = -1
  }

  #mergeProviderStatus(status: ProviderStatus): readonly ProviderStatus[] | null {
    const current = this.#providerStatusesCache
    if (current === null) return null
    return current.map((entry) => entry.provider === status.provider ? status : entry)
  }

  async #providerStatusesSafely(): Promise<readonly ProviderStatus[]> {
    try {
      return await this.#vault.statuses()
    } catch {
      return (['deepseek', 'doubao_asr'] as const).map((provider) => ({
        provider,
        configured: false,
        maskedKey: null,
      }))
    }
  }

  async #assertLegacyLibraryWritable(): Promise<void> {
    const state = await this.#project.getState()
    if (state.activeProjectId !== null) throw new Error('PROJECT_LIBRARY_MANAGED')
  }

  #requireSimulation(): QaSimulationApplicationService {
    if (!this.#simulation) throw new Error('QA_SIMULATION_UNAVAILABLE')
    return this.#simulation
  }
}
