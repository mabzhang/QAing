import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { open, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  systemPreferences,
  Tray,
} from 'electron'
import { ApplicationController } from './app/controller'
import { DesktopApplicationFacade } from './app/facade'
import { DesktopProjectApplicationService } from './app/project-service'
import { QaWorkspaceRuntime } from './app/qa-workspace'
import { AudioHelperSupervisor } from './audio/supervisor'
import { requireMacAudioPermission, requestMacAudioPermission } from './audio/permissions'
import { DataStore } from './data/database'
import { IsolatedLocalBgeEmbeddingProvider } from './data/isolated-bge-provider'
import { HybridRetriever } from './data/retrieval'
import { KnowledgeRepository } from './data/repository'
import { EmbeddingIndexer, InMemoryExactVectorIndex } from './data/vector'
import { registerIpcHandlers, type IpcRegistration } from './ipc/register'
import { DesktopLibraryService } from './library/service'
import { IsolatedProjectConverter } from './project/converter-supervisor'
import { DataStoreProjectSyncRepository } from './project/data-repository'
import { ProjectSyncService } from './project/service'
import { DeepSeekStreamingClient } from './rag/deepseek-client'
import { RagOrchestrator } from './rag/orchestrator'
import {
  createQaSimulationApplication,
  DeepSeekSimulationProvider,
  ProjectSimulationPublicationGateway,
} from './simulation'
import {
  NativeAudioRuntime,
  ProductionRagRuntime,
  SeedAsrRuntime,
  SqliteApplicationRepository,
} from './runtime/adapters'
import { MacRuntimeProbe, RuntimeSignals } from './runtime/probe'
import { CredentialVault } from './security/credential-vault'
import { SecureLogger } from './security/secure-logger'
import { createMainWindow } from './window'
import { WindowBehaviorController } from './window-behavior'
import { supportsRequiredMacOs } from './platform'

let disposeApplication: (() => Promise<void>) | null = null
let menuBarTray: Tray | null = null
let allowQuit = false
let disposeTask: Promise<void> | null = null
const MAX_BACKGROUND_INDEX_BATCHES = 313
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) app.quit()

function enforcePlatform(): void {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    dialog.showErrorBox('不支持的设备', 'QAing 当前仅支持 macOS 14+ 的 Apple Silicon（M 系列）设备。')
    app.quit()
    throw new Error('UNSUPPORTED_PLATFORM')
  }
  if (!supportsRequiredMacOs(process.getSystemVersion())) {
    dialog.showErrorBox('系统版本过低', 'QAing 需要 macOS 14 或更高版本。')
    app.quit()
    throw new Error('UNSUPPORTED_MACOS_VERSION')
  }
}

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'qaing-audio-helper')
    : join(app.getAppPath(), 'build', 'native', 'qaing-audio-helper')
}

function menuBarIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icons', 'ZenXMenuBarTemplate.png')
    : join(app.getAppPath(), 'build', 'icons', 'ZenXMenuBarTemplate.png')
}

function createMenuBarTray(): void {
  const image = nativeImage.createFromPath(menuBarIconPath())
  if (image.isEmpty()) throw new Error('ZENX_MENU_BAR_ICON_UNAVAILABLE')
  image.setTemplateImage(true)
  menuBarTray?.destroy()
  menuBarTray = new Tray(image)
  menuBarTray.setToolTip('QAing · ZenX')
  menuBarTray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 QAing', click: () => showExistingWindow() },
    {
      label: '隐藏 QAing',
      click: () => {
        for (const window of BrowserWindow.getAllWindows()) window.hide()
      },
    },
    { type: 'separator' },
    { label: '退出 QAing', click: () => app.quit() },
  ]))
  menuBarTray.on('click', () => showExistingWindow())
}

async function bootstrap(): Promise<void> {
  enforcePlatform()
  app.setActivationPolicy('regular')
  await app.dock?.show()
  if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build', 'icons', 'QAing.png'))
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  const logger = new SecureLogger((line) => process.stdout.write(`${line}\n`))
  const store = new DataStore(join(userData, 'qaing.sqlite3'))
  let mainWindow: BrowserWindow | null = null
  const qaWorkspace = new QaWorkspaceRuntime(store, {
    save: async (suggestedName, chunks) => {
      if (mainWindow === null || mainWindow.isDestroyed()) throw new Error('PROJECT_WINDOW_UNAVAILABLE')
      const selection = await dialog.showSaveDialog(mainWindow, {
        title: '导出当前项目会话工作台',
        defaultPath: suggestedName,
        buttonLabel: '导出',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (selection.canceled || !selection.filePath) return

      // Stream to an app-owned sibling and publish in one rename. If the
      // project revision changes while pages are being read, the runtime
      // throws and no partial export replaces the user's chosen file.
      const temporaryPath = `${selection.filePath}.qaing-${randomUUID()}.tmp`
      let output: Awaited<ReturnType<typeof open>> | null = null
      try {
        output = await open(temporaryPath, 'wx', 0o600)
        for await (const chunk of chunks) {
          const bytes = Buffer.from(chunk, 'utf8')
          let offset = 0
          while (offset < bytes.length) {
            const result = await output.write(bytes, offset, bytes.length - offset, null)
            if (result.bytesWritten < 1) throw new Error('QA_WORKSPACE_EXPORT_SHORT_WRITE')
            offset += result.bytesWritten
          }
        }
        await output.sync()
        await output.close()
        output = null
        await rename(temporaryPath, selection.filePath)
      } catch (error) {
        await output?.close().catch(() => undefined)
        await unlink(temporaryPath).catch(() => undefined)
        throw error
      }
    },
  })
  const vault = new CredentialVault(join(userData, 'secure', 'credentials.json'), safeStorage)
  const signals = new RuntimeSignals()
  const windowBehavior = new WindowBehaviorController(join(userData, 'window-preferences.json'))
  const provider = new IsolatedLocalBgeEmbeddingProvider({
    cacheDir: join(userData, 'models'),
    onProgress: () => signals.emit(),
  })
  const vectorIndex = new InMemoryExactVectorIndex(20_000)
  const indexer = new EmbeddingIndexer({ store, index: vectorIndex, provider })
  const knowledge = new KnowledgeRepository(store, vectorIndex)
  indexer.initialize()
  const retriever = new HybridRetriever({ store, index: vectorIndex, provider })
  const deepSeek = new DeepSeekStreamingClient()
  const ragOrchestrator = new RagOrchestrator({ store, retriever, client: deepSeek })
  const audioSupervisor = new AudioHelperSupervisor({
    helperPath: helperPath(),
    logger: {
      info: (event, fields) => logger.log('info', event, fields),
      warn: (event, fields) => logger.log('warn', event, fields),
    },
  })
  let ipcRegistration: IpcRegistration | null = null
  const permissionGateway = {
    getMediaAccessStatus: (kind: 'microphone' | 'screen') => systemPreferences.getMediaAccessStatus(kind),
    askForMicrophoneAccess: async () => systemPreferences.askForMediaAccess('microphone'),
    enumerateScreensForConsent: async () => {
      await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      })
    },
  } as const
  const audio = new NativeAudioRuntime(audioSupervisor, () => signals.emit(), async (source) => {
    requireMacAudioPermission(source, permissionGateway)
  }, (sample) => ipcRegistration?.publishAudioLevel(sample))
  const asr = new SeedAsrRuntime(vault, logger)
  const rag = new ProductionRagRuntime({ vault, orchestrator: ragOrchestrator, client: deepSeek })
  const repository = new SqliteApplicationRepository({
    store,
    provider,
    indexer,
    knowledge,
    onWorkspaceChanged: (event) => qaWorkspace.notify(event),
  })
  const controller = new ApplicationController({ audio, asr, rag, repository, logger })
  const runtime = new MacRuntimeProbe({
    provider,
    store,
    audio,
    signals,
    windowBehavior,
    requestAudioPermission: async (source) => requestMacAudioPermission(source, permissionGateway),
    restartApplication: async () => {
      setImmediate(() => {
        app.relaunch()
        app.quit()
      })
    },
  })

  const modelController = new AbortController()
  let modelReady = false
  let indexingScheduled = true
  let indexingTask: Promise<void> | null = null
  const projectHolder: { application?: DesktopProjectApplicationService } = {}

  const reconcileProjectIndexes = (): void => {
    for (const project of store.listProjects()) {
      try {
        const reconciled = store.reconcileProjectIndexState(project.id)
        if (reconciled.changedSourceIds.length > 0) projectHolder.application?.handleStoreChanged(project.id)
      } catch (error) {
        logger.log('warn', 'project.index_reconcile_failed', { error })
      }
    }
  }
  const drainPendingIndexes = async (): Promise<void> => {
    for (let batch = 0; batch < MAX_BACKGROUND_INDEX_BATCHES; batch += 1) {
      const result = await indexer.indexPending({ limit: 64, signal: modelController.signal })
      if (result.remaining < 1 || result.indexed < 1) break
    }
    reconcileProjectIndexes()
    signals.emit('library')
  }
  const scheduleIndexing = (): void => {
    indexingScheduled = true
    if (!modelReady || indexingTask !== null || modelController.signal.aborted) return
    const task = (async () => {
      do {
        indexingScheduled = false
        await drainPendingIndexes()
      } while (indexingScheduled && !modelController.signal.aborted)
    })()
    indexingTask = task
    void task.catch((error: unknown) => {
      if (!modelController.signal.aborted) logger.log('warn', 'embedding.index_failed', { error })
    }).finally(() => {
      if (indexingTask === task) indexingTask = null
      if (indexingScheduled && !modelController.signal.aborted) scheduleIndexing()
    })
  }

  const projectRepository = new DataStoreProjectSyncRepository({
    store,
    onKnowledgeCommitted: (projectId) => {
      scheduleIndexing()
      signals.emit('library')
      projectHolder.application?.handleStoreChanged(projectId)
    },
  })
  const projectConverter = new IsolatedProjectConverter()
  const projectSync = new ProjectSyncService({
    repository: projectRepository,
    converter: projectConverter,
    onProgress: (event) => projectHolder.application?.handleProgress(event),
    canAutoApply: () => {
      const state = controller.getState()
      return state.mode === 'qa'
        ? state.qaPhase === 'idle'
        : state.frontPhase === 'idle' || state.frontPhase === 'complete'
    },
  })
  const projectApplication = new DesktopProjectApplicationService({
    store,
    sync: projectSync,
    directories: {
      selectDirectory: async () => {
        if (mainWindow === null || mainWindow.isDestroyed()) throw new Error('PROJECT_WINDOW_UNAVAILABLE')
        const selection = await dialog.showOpenDialog(mainWindow, {
          title: '选择 QAing 项目文件夹',
          message: '将只扫描“原始资料”和“预设QA”，“转换资料库”永不作为源目录。',
          buttonLabel: '选择项目',
          properties: ['openDirectory', 'createDirectory'],
        })
        return selection.canceled ? null : selection.filePaths[0] ?? null
      },
      saveDiagnostics: async (suggestedName, content) => {
        if (mainWindow === null || mainWindow.isDestroyed()) throw new Error('PROJECT_WINDOW_UNAVAILABLE')
        const selection = await dialog.showSaveDialog(mainWindow, {
          title: '导出项目诊断摘要',
          defaultPath: suggestedName.replace(/[/:]/gu, '-'),
          buttonLabel: '导出',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
        if (selection.canceled || !selection.filePath) return
        await writeFile(selection.filePath, content, { encoding: 'utf8', mode: 0o600 })
      },
    },
    onKnowledgeChanged: () => signals.emit('library'),
  })
  projectHolder.application = projectApplication
  await projectApplication.initialize()
  const simulationApplication = createQaSimulationApplication({
    store,
    provider: new DeepSeekSimulationProvider({
      getApiKey: () => vault.get('deepseek'),
      client: deepSeek,
    }),
    publicationGateway: new ProjectSimulationPublicationGateway({
      getProjectRootPath: (projectId) => store.getProject(projectId)?.rootPath ?? null,
      syncProject: (input, signal) => projectSync.sync(input, signal),
      resolveMappings: (input) => store.resolveSimulationPublicationMappings(input),
    }),
  })
  const sessionBlocksProjectApply = (): boolean => {
    const state = controller.getState()
    return state.mode === 'qa'
      ? state.qaPhase !== 'idle'
      : state.frontPhase !== 'idle' && state.frontPhase !== 'complete'
  }
  let projectApplyWasBlocked = sessionBlocksProjectApply()
  const unsubscribeProjectApplyResume = controller.subscribe(() => {
    const blocked = sessionBlocksProjectApply()
    if (!projectApplyWasBlocked && blocked) {
      void simulationApplication.pauseActive().catch((error: unknown) => {
        logger.log('warn', 'simulation.pause_failed', { error })
      })
    }
    if (projectApplyWasBlocked && !blocked) {
      const projectId = store.getActiveProjectId()
      const project = projectId ? store.getProject(projectId) : null
      if (project) {
        void projectSync.resumeAfterSession(project.id)
          .catch((error: unknown) => {
            logger.log('warn', 'project.session_release_recovery_failed', { error })
          })
      }
    }
    projectApplyWasBlocked = blocked
  })

  let facade: DesktopApplicationFacade | null = null
  let unsubscribeFacade: (() => void) | null = null
  const window = createMainWindow((createdWindow) => {
    mainWindow = createdWindow
    const library = new DesktopLibraryService({
      window: createdWindow,
      store,
      indexer,
      knowledge,
      onIndexStateChanged: () => {
        reconcileProjectIndexes()
        signals.emit('library')
      },
    })
    facade = new DesktopApplicationFacade({
      controller,
      vault,
      library,
      runtime,
      workspace: qaWorkspace,
      project: projectApplication,
      simulation: simulationApplication,
    })
    ipcRegistration = registerIpcHandlers(ipcMain, createdWindow.webContents, facade, {
      expectedMainFrameUrl: app.isPackaged
        ? pathToFileURL(join(__dirname, '../renderer/index.html')).href
        : null,
    })
    unsubscribeFacade = facade.subscribe((snapshot) => ipcRegistration?.publishSnapshot(snapshot))
  }, () => {
    audio.abort()
    asr.abort()
  }, { alwaysOnTop: windowBehavior.alwaysOnTop })
  windowBehavior.attach(window)
  createMenuBarTray()

  window.on('closed', () => {
    if (!allowQuit) app.quit()
  })
  // TCC permissions may change while System Settings has focus.
  window.on('focus', () => signals.emit())
  if (!globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (window.isVisible()) window.hide()
    else {
      window.show()
      window.focus()
    }
  })) {
    logger.log('warn', 'shortcut.registration_failed')
  }

  const modelTask = provider.prepare({ signal: modelController.signal })
    .then(async () => {
      modelReady = true
      scheduleIndexing()
      await indexingTask
      for (const draft of store.listRecoverableFrontDrafts()) {
        if (modelController.signal.aborted) break
        try {
          const session = store.getSession(draft.sessionId)
          if (!session || session.mode !== 'front' || session.projectId === null) {
            throw new Error('FRONT_RECOVERY_PROJECT_MISMATCH')
          }
          let markdown = draft.structuredMarkdown
          if (!markdown) {
            await repository.persistFrontTranscript({ sessionId: draft.sessionId, transcript: draft.transcript })
            markdown = await rag.structureTranscript({
              sessionId: draft.sessionId,
              transcript: draft.transcript,
              signal: modelController.signal,
            })
          }
          await repository.indexStructuredFront({
            projectId: session.projectId,
            documentId: draft.id,
            markdown,
          })
          await repository.endSession(draft.sessionId, 'complete')
        } catch (error) {
          try {
            store.markFrontDraftFailed(draft.id, draft.contentHash)
          } catch {
            // A newer snapshot won the race; never mark it with an older failure.
          }
          logger.log('warn', 'front.recovery_failed', { error })
        }
      }
      scheduleIndexing()
    })
    .catch((error: unknown) => {
      logger.log('warn', 'embedding.prepare_failed', { error })
      signals.emit()
    })

  disposeApplication = async () => {
    modelController.abort()
    globalShortcut.unregisterAll()
    menuBarTray?.destroy()
    menuBarTray = null
    unsubscribeFacade?.()
    unsubscribeProjectApplyResume()
    ipcRegistration?.dispose()
    await Promise.allSettled([
      modelTask,
      indexingTask ?? Promise.resolve(),
    ])
    await facade?.dispose()
    if (facade === null) {
      await Promise.all([
        projectApplication.dispose(),
        simulationApplication.dispose(),
      ])
    }
    qaWorkspace.dispose()
    audio.dispose()
    await provider.dispose()
    store.close()
  }
}

if (hasSingleInstanceLock) app.whenReady().then(bootstrap).catch((error: unknown) => {
  const logger = new SecureLogger()
  logger.log('error', 'bootstrap.failed', { error })
  dialog.showErrorBox('QAing 无法启动', '初始化失败，未写入任何凭据。请重新启动应用。')
  app.quit()
})

app.on('second-instance', () => {
  showExistingWindow()
})

app.on('activate', () => {
  showExistingWindow()
})

function showExistingWindow(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    break
  }
}

app.on('before-quit', (event) => {
  if (allowQuit || disposeApplication === null) return
  event.preventDefault()
  disposeTask ??= disposeApplication().finally(() => {
    allowQuit = true
    app.quit()
  })
})

app.on('window-all-closed', () => app.quit())
