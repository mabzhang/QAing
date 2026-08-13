import { describe, expect, it } from 'vitest'
import type {
  AppCommand,
  PublicSnapshot,
  QaingBridge,
} from '../../core/contracts'
import { initialAppState } from '../../core/state-machine'
import {
  createUiAdapter,
  isQaingBridge,
  mapSnapshotToEnvironment,
  mergeSnapshotUpdate,
} from './bridge-adapter'

function snapshotWith(
  patch: Partial<PublicSnapshot['runtime']> = {},
): PublicSnapshot {
  return {
    app: {
      ...initialAppState,
      qaPhase: 'listening',
      sessionId: 'session-1',
      revision: 2,
    },
    runtime: {
      platform: 'darwin-arm64',
      appVersion: '0.1.0',
      retrievalMode: 'hybrid',
      audioPermission: 'restricted',
      screenAudioPermission: 'granted',
      helperStatus: 'recovering',
      alwaysOnTop: false,
      providerStatuses: [
        { provider: 'deepseek', configured: true, maskedKey: '••••deep' },
      ],
      ...patch,
    },
    library: [
      {
        id: 'qa-1',
        title: '预设问答.xlsx',
        kind: 'preset_qa',
        status: 'indexed',
        chunkCount: 12,
        createdAt: 1_786_500_000_000,
        error: null,
      },
      {
        id: 'front-1',
        title: '路演记录',
        kind: 'front_recording',
        status: 'pending',
        chunkCount: 3,
        createdAt: 1_786_500_100_000,
        error: null,
      },
    ],
  }
}

describe('renderer bridge adapter', () => {
  it('rejects absent or incomplete preload bridges before the renderer calls them', () => {
    expect(isQaingBridge(undefined)).toBe(false)
    expect(isQaingBridge({ getSnapshot: () => Promise.resolve(snapshotWith()) })).toBe(false)
  })

  it('merges lightweight snapshot patches only after a full library baseline exists', () => {
    const base = snapshotWith()
    const patchedApp = { ...base.app, revision: base.app.revision + 1 }
    const patchedRuntime = { ...base.runtime, helperStatus: 'silent' as const }
    const patch = { app: patchedApp, runtime: patchedRuntime }

    expect(mergeSnapshotUpdate(null, patch)).toBeNull()

    const merged = mergeSnapshotUpdate(base, patch)
    expect(merged).toEqual({
      app: patchedApp,
      runtime: patchedRuntime,
      library: base.library,
    })
    expect(merged?.library).toBe(base.library)

    const replacement = mergeSnapshotUpdate(base, {
      app: patchedApp,
      runtime: patchedRuntime,
      library: [],
    })
    expect(replacement?.library).toEqual([])
  })

  it('maps every runtime boundary without exposing provider secrets', () => {
    const environment = mapSnapshotToEnvironment(snapshotWith())
    expect(environment.permissions).toEqual({ microphone: 'unavailable', system: 'granted' })
    expect(environment.captureHealth).toBe('reconnecting')
    expect(environment.alwaysOnTop).toBe(false)
    expect(environment.retrievalHealth).toBe('searching')
    expect(environment.providerStatuses).toEqual({
      deepseek: { configured: true, maskedKey: '••••deep' },
      doubao_asr: { configured: false, maskedKey: null },
      embedding: { configured: true, maskedKey: null },
    })
    expect(environment.knowledgeBase).toEqual({
      presetQaCount: 1,
      sourceDocumentCount: 1,
      pendingIndexJobs: 1,
    })
    expect(environment.documents[1]).toMatchObject({
      id: 'front-1',
      kind: 'front_recording',
      indexStatus: 'pending',
      error: null,
    })

    const fallback = mapSnapshotToEnvironment(snapshotWith({ retrievalMode: 'keyword_fallback' }))
    expect(fallback.retrievalMode).toBe('keyword_fallback')
    expect(fallback.retrievalHealth).toBe('unavailable')
    expect(fallback.providerStatuses.embedding.configured).toBe(false)

    const silent = mapSnapshotToEnvironment(snapshotWith({ helperStatus: 'silent' }))
    expect(silent.captureHealth).toBe('silent')

    const unknownPermissions = mapSnapshotToEnvironment(snapshotWith({
      audioPermission: 'unknown',
      screenAudioPermission: 'unknown',
    }))
    expect(unknownPermissions.permissions).toEqual({ microphone: 'prompt', system: 'prompt' })
  })

  it('routes all mutations through the white-listed bridge contract', async () => {
    const commands: AppCommand[] = []
    const providerCalls: string[] = []
    const permissionCalls: string[] = []
    const libraryCalls: string[] = []
    const copied: string[] = []
    const projectCalls: string[] = []
    const bridge: QaingBridge = {
      getSnapshot: () => Promise.resolve(snapshotWith()),
      dispatch: (command) => {
        commands.push(command)
        return Promise.resolve()
      },
      onSnapshot: () => () => undefined,
      onAudioLevel: () => () => undefined,
      getQaWorkspacePage: () => Promise.resolve({ projectId: null, totalRounds: 0, items: [], nextCursor: null, dataRevision: 0 }),
      deleteQaWorkspaceRound: () => Promise.resolve({ deleted: false, dataRevision: 0 }),
      clearQaWorkspaceProject: () => Promise.resolve({ deletedRounds: 0, deletedTurns: 0, dataRevision: 0 }),
      exportQaWorkspaceProject: () => Promise.resolve(),
      onQaWorkspaceChanged: () => () => undefined,
      configureProvider: (provider, apiKey) => {
        providerCalls.push(`configure:${provider}:${apiKey}`)
        return Promise.resolve({ provider, configured: true, maskedKey: '••••' })
      },
      clearProvider: (provider) => {
        providerCalls.push(`clear:${provider}`)
        return Promise.resolve({ provider, configured: false, maskedKey: null })
      },
      copyAnswer: (answer) => {
        copied.push(answer)
        return Promise.resolve()
      },
      importSourceDocuments: () => {
        libraryCalls.push('import-source')
        return Promise.resolve(snapshotWith().library)
      },
      importPresetQa: () => {
        libraryCalls.push('import-qa')
        return Promise.resolve(snapshotWith().library)
      },
      deleteDocument: (documentId) => {
        libraryCalls.push(`delete:${documentId}`)
        return Promise.resolve()
      },
      openSystemPermissions: (permission) => {
        permissionCalls.push(permission)
        return Promise.resolve()
      },
      requestAudioPermission: (source) => {
        permissionCalls.push(`request:${source}`)
        return Promise.resolve({ status: 'granted' })
      },
      restartApplication: () => {
        permissionCalls.push('restart')
        return Promise.resolve()
      },
      setAlwaysOnTop: (enabled) => {
        libraryCalls.push(`always-on-top:${String(enabled)}`)
        return Promise.resolve()
      },
      getProjectState: () => Promise.resolve({
        projects: [],
        activeProjectId: null,
        run: null,
        counts: { added: 0, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 0, completed: 0, total: 0 },
        directoryConfirmation: null,
        dataRevision: 0,
      }),
      selectProjectRoot: (projectId) => {
        projectCalls.push(`select:${projectId ?? 'new'}`)
        return Promise.resolve({ status: 'cancelled' })
      },
      confirmProjectDirectories: (projectId) => {
        projectCalls.push(`confirm:${projectId}`)
        return Promise.reject(new Error('unused'))
      },
      cancelProjectPreparation: (projectId) => {
        projectCalls.push(`cancel-prepare:${projectId}`)
        return Promise.resolve()
      },
      activateProject: (projectId) => {
        projectCalls.push(`activate:${projectId}`)
        return Promise.reject(new Error('unused'))
      },
      startProjectSync: (projectId) => {
        projectCalls.push(`start:${projectId}`)
        return Promise.reject(new Error('unused'))
      },
      cancelProjectSync: (runId) => {
        projectCalls.push(`cancel:${runId}`)
        return Promise.resolve()
      },
      retryProjectSync: (projectId, runId) => {
        projectCalls.push(`retry:${projectId}:${runId ?? 'none'}`)
        return Promise.reject(new Error('unused'))
      },
      setProjectSyncPolicy: (projectId, policy) => {
        projectCalls.push(`policy:${projectId}:${policy}`)
        return Promise.reject(new Error('unused'))
      },
      getProjectTaskPage: () => Promise.resolve({ items: [], nextCursor: null, dataRevision: 0 }),
      exportProjectDiagnostics: (projectId, runId) => {
        projectCalls.push(`diagnostics:${projectId}:${runId ?? 'none'}`)
        return Promise.resolve()
      },
      onProjectChanged: () => () => undefined,
      preflightQaSimulation: () => Promise.reject(new Error('unused')),
      startQaSimulation: () => Promise.reject(new Error('unused')),
      getQaSimulationJob: () => Promise.reject(new Error('unused')),
      getLatestQaSimulationJob: () => Promise.resolve(null),
      getQaSimulationPage: () => Promise.reject(new Error('unused')),
      cancelQaSimulation: () => Promise.reject(new Error('unused')),
      resumeQaSimulation: () => Promise.reject(new Error('unused')),
      updateQaSimulationItem: () => Promise.reject(new Error('unused')),
      reviewQaSimulationItems: () => Promise.reject(new Error('unused')),
      publishQaSimulation: () => Promise.reject(new Error('unused')),
      onQaSimulationChanged: () => () => undefined,
    }
    const adapter = createUiAdapter(bridge)

    expect(isQaingBridge(bridge)).toBe(true)

    await adapter.switchMode('front')
    await adapter.selectAudioSource('microphone')
    await adapter.start()
    await adapter.stopSession()
    await adapter.stopFront()
    await adapter.acknowledgeFrontComplete()
    await adapter.endQuestion()
    await adapter.endAnswer()
    await adapter.skipQuestion()
    await adapter.retry()
    await adapter.dismissError()
    await adapter.copyAnswer('确定答案')
    await adapter.configureProvider('deepseek', 'secret-once')
    await adapter.clearProvider('doubao_asr')
    await adapter.openPermission('microphone')
    await adapter.openPermission('system')
    await expect(adapter.requestAudioPermission('microphone')).resolves.toEqual({ status: 'granted' })
    await adapter.restartApplication()
    await adapter.importSourceDocuments()
    await adapter.importPresetQa()
    await adapter.deleteDocument('doc-1')
    await adapter.setAlwaysOnTop(true)
    await adapter.selectProjectRoot()
    await adapter.cancelProjectPreparation('project_12345678')
    await adapter.cancelProjectSync('run_12345678')
    await adapter.relocateProject('project_12345678')
    await adapter.exportProjectDiagnostics('project_12345678', null)
    await expect(adapter.setProjectTaskFilter('failed')).rejects.toThrow('PROJECT_TASK_PAGING_NOT_BOUND')
    await expect(adapter.loadMoreProjectTasks()).rejects.toThrow('PROJECT_TASK_PAGING_NOT_BOUND')

    expect(commands).toEqual([
      { type: 'switch_mode', mode: 'front' },
      { type: 'select_audio_source', source: 'microphone' },
      { type: 'start_session' },
      { type: 'stop_session' },
      { type: 'stop_front' },
      { type: 'acknowledge_front_complete' },
      { type: 'end_question' },
      { type: 'end_answer' },
      { type: 'skip_question' },
      { type: 'retry' },
      { type: 'dismiss_error' },
    ])
    expect(copied).toEqual(['确定答案'])
    expect(providerCalls).toEqual([
      'configure:deepseek:secret-once',
      'clear:doubao_asr',
    ])
    expect(permissionCalls).toEqual(['microphone', 'screen_audio', 'request:microphone', 'restart'])
    expect(libraryCalls).toEqual(['import-source', 'import-qa', 'delete:doc-1', 'always-on-top:true'])
    expect(projectCalls).toEqual([
      'select:new',
      'cancel-prepare:project_12345678',
      'cancel:run_12345678',
      'select:project_12345678',
      'diagnostics:project_12345678:none',
    ])
  })
})
