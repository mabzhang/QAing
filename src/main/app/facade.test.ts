import { describe, expect, it, vi } from 'vitest'
import { initialAppState } from '../../core/state-machine'
import type {
  AppCommand,
  DocumentSummary,
  ProviderName,
  ProviderStatus,
  RuntimeStatus,
} from '../../core/contracts'
import type { AppState, ConversationTurn, SourceReference } from '../../core/types'
import {
  DesktopApplicationFacade,
  projectPublicAppState,
  type LibraryService,
  type ProjectApplicationService,
  type RuntimeProbe,
} from './facade'

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

function document(id: string): DocumentSummary {
  return {
    id,
    title: id,
    kind: 'source_document',
    status: 'indexed',
    chunkCount: 1,
    createdAt: 1,
    error: null,
  }
}

function runtimeStatus(version = '0.1.0'): Omit<RuntimeStatus, 'providerStatuses'> {
  return {
    platform: 'darwin-arm64',
    appVersion: version,
    retrievalMode: 'hybrid',
    audioPermission: 'granted',
    screenAudioPermission: 'granted',
    helperStatus: 'stopped',
    alwaysOnTop: false,
  }
}

class FakeController {
  #state: AppState = initialAppState
  readonly #listeners = new Set<(state: AppState) => void>()

  getState(): AppState {
    return this.#state
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  async dispatch(command: AppCommand): Promise<void> {
    void command
    this.emit()
  }

  emit(): void {
    this.#state = { ...this.#state, revision: this.#state.revision + 1 }
    for (const listener of this.#listeners) listener(this.#state)
  }

  replaceState(state: AppState): void {
    this.#state = state
    for (const listener of this.#listeners) listener(this.#state)
  }

  async dispose(): Promise<void> {
    this.#listeners.clear()
  }
}

class FakeVault {
  statusCalls = 0
  statusesValue: readonly ProviderStatus[] = [
    { provider: 'deepseek', configured: false, maskedKey: null },
    { provider: 'doubao_asr', configured: false, maskedKey: null },
  ]

  async set(provider: ProviderName, value: string): Promise<ProviderStatus> {
    void value
    const status = { provider, configured: true, maskedKey: 'abc••••1234' } as const
    this.statusesValue = this.statusesValue.map((entry) => entry.provider === provider ? status : entry)
    return status
  }

  async clear(provider: ProviderName): Promise<ProviderStatus> {
    const status = { provider, configured: false, maskedKey: null }
    this.statusesValue = this.statusesValue.map((entry) => entry.provider === provider ? status : entry)
    return status
  }

  async statuses(): Promise<readonly ProviderStatus[]> {
    this.statusCalls += 1
    return this.statusesValue
  }
}

class FakeLibrary implements LibraryService {
  listCalls = 0
  importSourceCalls = 0
  importQaCalls = 0
  deleteCalls = 0
  documents: readonly DocumentSummary[] = [document('initial-doc')]

  async listDocuments(): Promise<readonly DocumentSummary[]> {
    this.listCalls += 1
    return this.documents
  }

  async importSourceDocuments(): Promise<readonly DocumentSummary[]> {
    this.importSourceCalls += 1
    return this.documents
  }

  async importPresetQa(): Promise<readonly DocumentSummary[]> {
    this.importQaCalls += 1
    return this.documents
  }

  async deleteDocument(documentId: string): Promise<void> {
    void documentId
    this.deleteCalls += 1
    return undefined
  }
}

class FakeRuntime implements RuntimeProbe {
  calls = 0
  permissionRequests: Array<'microphone' | 'system'> = []
  restartCalls = 0
  status = runtimeStatus()
  readonly #listeners = new Set<(scope?: 'runtime' | 'library') => void>()

  async getStatus(): Promise<Omit<RuntimeStatus, 'providerStatuses'>> {
    this.calls += 1
    return this.status
  }

  async openSystemPermissions(): Promise<void> {
    return undefined
  }

  async requestAudioPermission(source: 'microphone' | 'system'): Promise<{ readonly status: 'granted' }> {
    this.permissionRequests.push(source)
    return { status: 'granted' }
  }

  async restartApplication(): Promise<void> {
    this.restartCalls += 1
  }

  async setAlwaysOnTop(enabled: boolean): Promise<void> {
    this.status = { ...this.status, alwaysOnTop: enabled }
  }

  subscribe(listener: (scope?: 'runtime' | 'library') => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  emit(scope: 'runtime' | 'library' = 'runtime'): void {
    for (const listener of this.#listeners) listener(scope)
  }
}

class FakeProject implements ProjectApplicationService {
  readonly listeners = new Set<(event: { projectId: string; dataRevision: number; scope: 'summary' | 'tasks' | 'all' }) => void>()
  stateCalls = 0
  disposeCalls = 0
  selectCalls = 0
  activateCalls = 0
  startCalls = 0
  retryCalls = 0
  policyCalls = 0
  activeProjectId: string | null = null

  async getState() {
    this.stateCalls += 1
    return {
      projects: [],
      activeProjectId: this.activeProjectId,
      run: null,
      counts: { added: 0, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 0, completed: 0, total: 0 },
      directoryConfirmation: null,
      dataRevision: 0,
    } as const
  }

  async selectRoot() { this.selectCalls += 1; return { status: 'cancelled' as const } }
  async confirmDirectories(): Promise<never> { throw new Error('unused') }
  async cancelPreparation(): Promise<void> { return undefined }
  async activate(): Promise<never> { this.activateCalls += 1; throw new Error('unused') }
  async startSync(): Promise<never> { this.startCalls += 1; throw new Error('unused') }
  async cancelSync(): Promise<void> { return undefined }
  async retrySync(): Promise<never> { this.retryCalls += 1; throw new Error('unused') }
  async setSyncPolicy(): Promise<never> { this.policyCalls += 1; throw new Error('unused') }
  async getTaskPage() { return { items: [], nextCursor: null, dataRevision: 0 } as const }
  async exportDiagnostics(): Promise<void> { return undefined }
  subscribe(listener: (event: { projectId: string; dataRevision: number; scope: 'summary' | 'tasks' | 'all' }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async dispose(): Promise<void> { this.disposeCalls += 1 }
}

function fixture(): {
  readonly facade: DesktopApplicationFacade
  readonly controller: FakeController
  readonly vault: FakeVault
  readonly library: FakeLibrary
  readonly runtime: FakeRuntime
} {
  const controller = new FakeController()
  const vault = new FakeVault()
  const library = new FakeLibrary()
  const runtime = new FakeRuntime()
  return {
    facade: new DesktopApplicationFacade({ controller, vault, library, runtime }),
    controller,
    vault,
    library,
    runtime,
  }
}

describe('DesktopApplicationFacade snapshot caching', () => {
  it('keeps answer and history bodies out of high-frequency public snapshots', async () => {
    const sourceMarker = 'PRIVATE_SOURCE_EXCERPT_MARKER'
    const answerMarker = 'PRIVATE_COMPLETE_ANSWER_MARKER'
    const historyMarker = 'PRIVATE_HISTORY_ANSWER_MARKER'
    const source: SourceReference = {
      id: 'source-1',
      documentId: 'document-1',
      title: 'private source title',
      kind: 'source_document',
      excerpt: sourceMarker,
      score: 1,
    }
    const turn: ConversationTurn = {
      id: 'turn-1',
      question: 'private committed question',
      answer: historyMarker,
      sourceIds: ['source-1'],
      answerOrigin: 'final',
      createdAt: 1,
    }
    const internal = {
      ...initialAppState,
      sessionId: 'session-1',
      finalSegments: ['当前可见转写'],
      partialSegment: '仍在更新',
      candidateAnswer: answerMarker,
      candidateQuestion: 'private candidate question',
      candidateSources: [source],
      candidateRetrievalRoute: 'source_document',
      lockedAnswer: answerMarker,
      lockedQuestionIdentity: 'private locked question',
      lockedRetrievalRoute: 'source_document',
      sources: [source],
      history: [turn],
    } satisfies AppState

    const projected = projectPublicAppState(internal)
    const serialized = JSON.stringify(projected)
    expect(projected.finalSegments).toEqual(['当前可见转写'])
    expect(projected.partialSegment).toBe('仍在更新')
    expect(projected.candidateAnswer).toBe('')
    expect(projected.lockedAnswer).toBe('')
    expect(projected.candidateSources).toEqual([])
    expect(projected.sources).toEqual([])
    expect(projected.history).toEqual([])
    expect(serialized).not.toContain(answerMarker)
    expect(serialized).not.toContain(historyMarker)
    expect(serialized).not.toContain(sourceMarker)

    const { facade, controller } = fixture()
    controller.replaceState(internal)
    const snapshot = await facade.getSnapshot()
    expect(JSON.stringify(snapshot.app)).not.toMatch(/PRIVATE_(?:SOURCE|COMPLETE|HISTORY)_/u)
    await facade.dispose()
  })

  it('keeps the permission request user-initiated and refreshes runtime state before returning', async () => {
    const { facade, runtime } = fixture()
    const initialCalls = runtime.calls

    await expect(facade.requestAudioPermission('microphone')).resolves.toEqual({ status: 'granted' })
    expect(runtime.permissionRequests).toEqual(['microphone'])
    expect(runtime.calls).toBeGreaterThan(initialCalls)

    await facade.restartApplication()
    expect(runtime.restartCalls).toBe(1)
    await facade.dispose()
  })

  it('keeps the library, vault, and runtime off the high-frequency transcript path', async () => {
    const { facade, controller, vault, library, runtime } = fixture()
    const updates: Array<{ readonly hasLibrary: boolean; readonly revision: number }> = []
    const unsubscribe = facade.subscribe((snapshot) => {
      updates.push({ hasLibrary: snapshot.library !== undefined, revision: snapshot.app.revision })
    })
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0))

    for (let index = 0; index < 1_000; index += 1) controller.emit()
    await vi.waitFor(() => expect(updates.at(-1)?.revision).toBe(1_000))

    expect(library.listCalls).toBe(1)
    expect(vault.statusCalls).toBe(1)
    expect(runtime.calls).toBe(1)
    expect(updates.filter((update) => update.revision > 0).every((update) => !update.hasLibrary)).toBe(true)

    unsubscribe()
    await facade.dispose()
  })

  it('does not let stale in-flight runtime or library loads overwrite invalidated data', async () => {
    const firstRuntime = deferred<Omit<RuntimeStatus, 'providerStatuses'>>()
    const secondRuntime = deferred<Omit<RuntimeStatus, 'providerStatuses'>>()
    const firstLibrary = deferred<readonly DocumentSummary[]>()
    const secondLibrary = deferred<readonly DocumentSummary[]>()
    const controller = new FakeController()
    const vault = new FakeVault()
    const runtime = new FakeRuntime()
    const library = new FakeLibrary()
    const getStatusSpy = vi.fn()
      .mockReturnValueOnce(firstRuntime.promise)
      .mockReturnValueOnce(secondRuntime.promise)
    runtime.getStatus = getStatusSpy
    const listDocumentsSpy = vi.fn()
      .mockReturnValueOnce(firstLibrary.promise)
      .mockReturnValueOnce(secondLibrary.promise)
    library.listDocuments = listDocumentsSpy

    const facade = new DesktopApplicationFacade({ controller, vault, library, runtime })
    runtime.emit('library')
    secondRuntime.resolve(runtimeStatus('new'))
    secondLibrary.resolve([document('new-doc')])
    firstRuntime.resolve(runtimeStatus('old'))
    firstLibrary.resolve([document('old-doc')])

    await vi.waitFor(async () => {
      const snapshot = await facade.getSnapshot()
      expect(snapshot.runtime.appVersion).toBe('new')
      expect(snapshot.library.map((entry) => entry.id)).toEqual(['new-doc'])
    })
    expect(getStatusSpy).toHaveBeenCalledTimes(2)
    expect(listDocumentsSpy).toHaveBeenCalledTimes(2)
    await facade.dispose()
  })

  it('publishes a full library after mutation even when an older snapshot was cached', async () => {
    const { facade, library } = fixture()
    expect((await facade.getSnapshot()).library[0]?.id).toBe('initial-doc')
    library.documents = [document('replacement-doc')]
    const imported = await facade.importSourceDocuments()
    expect(imported[0]?.id).toBe('replacement-doc')

    const updates: Array<Parameters<Parameters<DesktopApplicationFacade['subscribe']>[0]>[0]> = []
    const unsubscribe = facade.subscribe((snapshot) => updates.push(snapshot))
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0))
    expect(updates[0]?.library?.[0]?.id).toBe('replacement-doc')

    unsubscribe()
    await facade.dispose()
  })

  it('blocks legacy import and deletion while a project owns the knowledge catalog', async () => {
    const controller = new FakeController()
    const vault = new FakeVault()
    const library = new FakeLibrary()
    const runtime = new FakeRuntime()
    const project = new FakeProject()
    project.activeProjectId = 'project-active'
    const facade = new DesktopApplicationFacade({ controller, vault, library, runtime, project })

    await expect(facade.importSourceDocuments()).rejects.toThrow('PROJECT_LIBRARY_MANAGED')
    await expect(facade.importPresetQa()).rejects.toThrow('PROJECT_LIBRARY_MANAGED')
    await expect(facade.deleteDocument('initial-doc')).rejects.toThrow('PROJECT_LIBRARY_MANAGED')
    expect(library.importSourceCalls).toBe(0)
    expect(library.importQaCalls).toBe(0)
    expect(library.deleteCalls).toBe(0)
    await facade.dispose()
  })

  it('never publishes an old subscription snapshot after a newer library generation', async () => {
    const oldLibrary = deferred<readonly DocumentSummary[]>()
    const controller = new FakeController()
    const vault = new FakeVault()
    const runtime = new FakeRuntime()
    const library = new FakeLibrary()
    const listDocumentsSpy = vi.fn()
      .mockReturnValueOnce(oldLibrary.promise)
      .mockResolvedValue([document('new-doc')])
    library.listDocuments = listDocumentsSpy
    const facade = new DesktopApplicationFacade({ controller, vault, library, runtime })
    const seenLibraries: string[][] = []
    const unsubscribe = facade.subscribe((snapshot) => {
      if (snapshot.library) seenLibraries.push(snapshot.library.map((entry) => entry.id))
    })

    runtime.emit('library')
    await vi.waitFor(() => expect(seenLibraries).toContainEqual(['new-doc']))
    oldLibrary.resolve([document('old-doc')])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(seenLibraries.at(-1)).toEqual(['new-doc'])
    expect(seenLibraries).not.toContainEqual(['old-doc'])
    unsubscribe()
    await facade.dispose()
  })

  it('keeps project state on its independent low-frequency channel and awaits disposal', async () => {
    const controller = new FakeController()
    const vault = new FakeVault()
    const library = new FakeLibrary()
    const runtime = new FakeRuntime()
    const project = new FakeProject()
    const facade = new DesktopApplicationFacade({ controller, vault, library, runtime, project })

    await expect(facade.getProjectState()).resolves.toMatchObject({ activeProjectId: null, dataRevision: 0 })
    expect(project.stateCalls).toBe(1)
    const seen: number[] = []
    const unsubscribe = facade.subscribeProject((event) => seen.push(event.dataRevision))
    for (const listener of project.listeners) listener({ projectId: 'project_12345678', dataRevision: 3, scope: 'tasks' })
    expect(seen).toEqual([3])
    unsubscribe()
    expect(project.listeners.size).toBe(0)

    await facade.dispose()
    expect(project.disposeCalls).toBe(1)
  })

  it('rejects every knowledge-version mutation while a live session owns its project snapshot', async () => {
    const controller = new FakeController()
    const vault = new FakeVault()
    const library = new FakeLibrary()
    const runtime = new FakeRuntime()
    const project = new FakeProject()
    const facade = new DesktopApplicationFacade({ controller, vault, library, runtime, project })
    controller.replaceState({
      ...initialAppState,
      mode: 'qa',
      qaPhase: 'listening',
      sessionId: 'session-1',
    })

    await expect(facade.selectProjectRoot()).rejects.toThrow('PROJECT_SWITCH_SESSION_ACTIVE')
    await expect(facade.activateProject('project_12345678')).rejects.toThrow('PROJECT_SWITCH_SESSION_ACTIVE')
    await expect(facade.startProjectSync('project_12345678')).rejects.toThrow('PROJECT_SWITCH_SESSION_ACTIVE')
    await expect(facade.retryProjectSync('project_12345678')).rejects.toThrow('PROJECT_SWITCH_SESSION_ACTIVE')
    await expect(facade.setProjectSyncPolicy('project_12345678', 'manual')).rejects.toThrow('PROJECT_SWITCH_SESSION_ACTIVE')
    await expect(facade.deleteQaWorkspaceRound('project_12345678', 'round_12345678'))
      .rejects.toThrow('QA_WORKSPACE_SESSION_ACTIVE')
    await expect(facade.clearQaWorkspaceProject('project_12345678'))
      .rejects.toThrow('QA_WORKSPACE_SESSION_ACTIVE')
    expect(project.selectCalls).toBe(0)
    expect(project.activateCalls).toBe(0)
    expect(project.startCalls).toBe(0)
    expect(project.retryCalls).toBe(0)
    expect(project.policyCalls).toBe(0)
    await facade.dispose()
  })
})
