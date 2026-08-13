import { clipboard, type IpcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z } from 'zod'
import {
  IPC_CHANNELS,
  type AppCommand,
  type AudioPermissionRequestResult,
  type AudioLevelSample,
  type DocumentSummary,
  type ProviderName,
  type ProviderStatus,
  type ProjectChangedEvent,
  type ProjectPublicState,
  type ProjectSelectionResult,
  type ProjectSummary,
  type ProjectSyncPolicy,
  type ProjectSyncRun,
  type ProjectTaskPage,
  type ProjectTaskPageInput,
  type PublishQaSimulationInput,
  type QaSimulationChangedEvent,
  type QaSimulationJobSummary,
  type QaSimulationPage,
  type QaSimulationPageInput,
  type QaSimulationPreflight,
  type QaSimulationPreflightInput,
  type QaWorkspaceClearResult,
  type QaWorkspaceDeleteResult,
  type QaWorkspacePageInput,
  type PublicSnapshot,
  type PublicSnapshotUpdate,
  type ReviewQaSimulationItemsInput,
  type StartQaSimulationInput,
  type UpdateQaSimulationItemInput,
} from '../../core/contracts'
import type { QaWorkspaceChanged, QaWorkspacePage } from '../../core/types'
import { MarkdownQaParseError } from '../data/importers'

const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('switch_mode'), mode: z.enum(['front', 'qa']) }).strict(),
  z.object({ type: z.literal('select_audio_source'), source: z.enum(['microphone', 'system']) }).strict(),
  z.object({ type: z.literal('start_session') }).strict(),
  z.object({ type: z.literal('stop_session') }).strict(),
  z.object({ type: z.literal('stop_front') }).strict(),
  z.object({ type: z.literal('end_question') }).strict(),
  z.object({ type: z.literal('end_answer') }).strict(),
  z.object({ type: z.literal('acknowledge_front_complete') }).strict(),
  z.object({ type: z.literal('retry') }).strict(),
  z.object({ type: z.literal('skip_question') }).strict(),
  z.object({ type: z.literal('dismiss_error') }).strict(),
])

const providerSchema = z.enum(['deepseek', 'doubao_asr'])
const apiKeySchema = z.string().trim().min(8).max(4096).refine((value) => !/[\r\n\0]/u.test(value), 'invalid credential')
const documentIdSchema = z.string().min(8).max(160).regex(/^[a-zA-Z0-9:_-]+$/u)
const permissionSchema = z.enum(['microphone', 'screen_audio'])
const audioSourceSchema = z.enum(['microphone', 'system'])
const copyTextSchema = z.string().min(1).max(16_384).refine((value) => !value.includes('\0'), 'invalid copy text')
const alwaysOnTopSchema = z.boolean()
const projectIdSchema = z.string().min(8).max(160).regex(/^[a-zA-Z0-9:_-]+$/u)
const runIdSchema = z.string().min(8).max(160).regex(/^[a-zA-Z0-9:_-]+$/u)
const projectPolicySchema = z.enum(['manual', 'auto_check_confirm', 'auto_check_apply'])
const projectTaskFilterSchema = z.enum(['all', 'action_required', 'failed'])
const projectTaskPageSchema = z.object({
  projectId: projectIdSchema,
  runId: runIdSchema.nullable().optional(),
  filter: projectTaskFilterSchema.optional(),
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u).nullable().optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict()
const workspacePageSchema = z.object({
  projectId: projectIdSchema,
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u).nullable().optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict()

const simulationJobIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u)
const simulationTextSchema = z.string().trim().min(1).max(2_000).refine((value) => !/[\0\r\n]/u.test(value), 'invalid text')
const simulationListSchema = z.array(simulationTextSchema).max(100)
const simulationBriefSchema = z.object({
  intervieweeIdentity: simulationTextSchema,
  audience: simulationTextSchema,
  focusTopics: simulationListSchema.min(1),
  scenario: simulationTextSchema,
  answerStyle: z.enum(['concise', 'standard', 'detailed']),
  excludedTopics: simulationListSchema,
}).strict()
const simulationFenceSchema = z.object({
  projectId: projectIdSchema,
  knowledgeVersion: z.number().int().positive().safe(),
  projectDataRevision: z.number().int().nonnegative().safe(),
  sourceManifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceCount: z.number().int().positive().safe(),
}).strict()
const simulationPreflightSchema = z.object({
  projectId: projectIdSchema,
  targetCount: z.number().int().positive().safe().optional(),
  brief: simulationBriefSchema,
}).strict()
const startSimulationSchema = z.object({
  fence: simulationFenceSchema,
  targetCount: z.number().int().positive().safe(),
  brief: simulationBriefSchema,
  largeBatchAcknowledged: z.boolean().optional(),
}).strict()
const simulationPageSchema = z.object({
  projectId: projectIdSchema,
  jobId: simulationJobIdSchema,
  expectedDataRevision: z.number().int().nonnegative().safe().optional(),
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u).nullable().optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict()
const updateSimulationItemSchema = z.object({
  projectId: projectIdSchema,
  jobId: simulationJobIdSchema,
  itemId: simulationJobIdSchema,
  expectedDataRevision: z.number().int().nonnegative().safe(),
  question: z.string().trim().min(3).max(500).refine((value) => !value.includes('\0'), 'invalid question'),
  answer: z.string().trim().min(1).max(8_000).refine((value) => !value.includes('\0'), 'invalid answer'),
}).strict()
const reviewSimulationItemsSchema = z.object({
  projectId: projectIdSchema,
  jobId: simulationJobIdSchema,
  itemIds: z.array(simulationJobIdSchema).min(1).max(100),
  expectedDataRevision: z.number().int().nonnegative().safe(),
  decision: z.enum(['approve', 'reject']),
}).strict()
const publishSimulationSchema = z.object({
  projectId: projectIdSchema,
  jobId: simulationJobIdSchema,
  expectedDataRevision: z.number().int().nonnegative().safe(),
}).strict()

function parseWorkspacePageInput(value: unknown): QaWorkspacePageInput {
  const parsed = workspacePageSchema.parse(value)
  return {
    projectId: parsed.projectId,
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
  }
}

function parseProjectTaskPageInput(value: unknown): ProjectTaskPageInput {
  const parsed = projectTaskPageSchema.parse(value)
  return {
    projectId: parsed.projectId,
    ...(parsed.runId === undefined ? {} : { runId: parsed.runId }),
    ...(parsed.filter === undefined ? {} : { filter: parsed.filter }),
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
  }
}

function parseSimulationPageInput(value: unknown): QaSimulationPageInput {
  const parsed = simulationPageSchema.parse(value)
  return {
    projectId: parsed.projectId,
    jobId: parsed.jobId,
    ...(parsed.expectedDataRevision === undefined ? {} : { expectedDataRevision: parsed.expectedDataRevision }),
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
  }
}

function parseSimulationPreflightInput(value: unknown): QaSimulationPreflightInput {
  const parsed = simulationPreflightSchema.parse(value)
  return {
    projectId: parsed.projectId,
    brief: parsed.brief,
    ...(parsed.targetCount === undefined ? {} : { targetCount: parsed.targetCount }),
  }
}

function parseStartSimulationInput(value: unknown): StartQaSimulationInput {
  const parsed = startSimulationSchema.parse(value)
  return {
    fence: parsed.fence,
    targetCount: parsed.targetCount,
    brief: parsed.brief,
    ...(parsed.largeBatchAcknowledged === undefined
      ? {}
      : { largeBatchAcknowledged: parsed.largeBatchAcknowledged }),
  }
}

export interface DesktopFacade {
  getSnapshot(): Promise<PublicSnapshot>
  getQaWorkspacePage?(input: QaWorkspacePageInput): Promise<QaWorkspacePage>
  deleteQaWorkspaceRound?(projectId: string, roundId: string): Promise<QaWorkspaceDeleteResult>
  clearQaWorkspaceProject?(projectId: string): Promise<QaWorkspaceClearResult>
  exportQaWorkspaceProject?(projectId: string): Promise<void>
  subscribeQaWorkspace?(listener: (event: QaWorkspaceChanged) => void): () => void
  dispatch(command: AppCommand): Promise<void>
  configureProvider(provider: ProviderName, apiKey: string): Promise<ProviderStatus>
  clearProvider(provider: ProviderName): Promise<ProviderStatus>
  copyAnswer?(text: string): Promise<void>
  importSourceDocuments(): Promise<readonly DocumentSummary[]>
  importPresetQa(): Promise<readonly DocumentSummary[]>
  deleteDocument(documentId: string): Promise<void>
  openSystemPermissions(kind: 'microphone' | 'screen_audio'): Promise<void>
  requestAudioPermission(source: 'microphone' | 'system'): Promise<AudioPermissionRequestResult>
  restartApplication(): Promise<void>
  setAlwaysOnTop(enabled: boolean): Promise<void>
  getProjectState?(): Promise<ProjectPublicState>
  selectProjectRoot?(projectId?: string): Promise<ProjectSelectionResult>
  confirmProjectDirectories?(projectId: string): Promise<ProjectSummary>
  cancelProjectPreparation?(projectId: string): Promise<void>
  activateProject?(projectId: string): Promise<ProjectSummary>
  startProjectSync?(projectId: string): Promise<ProjectSyncRun>
  cancelProjectSync?(runId: string): Promise<void>
  retryProjectSync?(projectId: string, runId?: string | null): Promise<ProjectSyncRun>
  setProjectSyncPolicy?(projectId: string, policy: ProjectSyncPolicy): Promise<ProjectSummary>
  getProjectTaskPage?(input: ProjectTaskPageInput): Promise<ProjectTaskPage>
  exportProjectDiagnostics?(projectId: string, runId?: string | null): Promise<void>
  subscribeProject?(listener: (event: ProjectChangedEvent) => void): () => void
  preflightQaSimulation?(input: QaSimulationPreflightInput): Promise<QaSimulationPreflight>
  startQaSimulation?(input: StartQaSimulationInput): Promise<QaSimulationJobSummary>
  getQaSimulationJob?(projectId: string, jobId: string): Promise<QaSimulationJobSummary>
  getLatestQaSimulationJob?(projectId: string): Promise<QaSimulationJobSummary | null>
  getQaSimulationPage?(input: QaSimulationPageInput): Promise<QaSimulationPage>
  cancelQaSimulation?(projectId: string, jobId: string): Promise<QaSimulationJobSummary>
  resumeQaSimulation?(projectId: string, jobId: string): Promise<QaSimulationJobSummary>
  updateQaSimulationItem?(input: UpdateQaSimulationItemInput): Promise<QaSimulationJobSummary>
  reviewQaSimulationItems?(input: ReviewQaSimulationItemsInput): Promise<QaSimulationJobSummary>
  publishQaSimulation?(input: PublishQaSimulationInput): Promise<QaSimulationJobSummary>
  subscribeQaSimulation?(listener: (event: QaSimulationChangedEvent) => void): () => void
}

export interface IpcRegistration {
  publishSnapshot(snapshot: PublicSnapshotUpdate): void
  publishAudioLevel(sample: AudioLevelSample): void
  publishQaWorkspaceChanged(update: QaWorkspaceChanged): void
  dispose(): void
}

function trusted(event: IpcMainInvokeEvent, renderer: WebContents): void {
  if (event.sender.id !== renderer.id || event.senderFrame !== renderer.mainFrame) {
    throw new Error('IPC request rejected')
  }
}

function publicError(error: unknown): Error {
  if (error instanceof z.ZodError) return new Error('请求参数无效')
  if (error instanceof MarkdownQaParseError) {
    // Only expose the parser's closed error-code union and a bounded line
    // number. Never forward the original message, source text or file path.
    const line = Number.isSafeInteger(error.line) && error.line > 0
      ? Math.min(error.line, 1_000_000)
      : 1
    return new Error(`QAING_QA_FORMAT:${error.code}:${line}`)
  }
  if (error instanceof Error && /^(?:凭据格式无效|系统安全存储不可用|IPC request rejected)$/u.test(error.message)) return error
  if (error instanceof Error && error.message === 'PROJECT_LIBRARY_MANAGED') {
    return new Error('QAING_PROJECT_LIBRARY_MANAGED')
  }
  return new Error('操作未完成，当前内容已保留，请重试')
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  renderer: WebContents,
  facade: DesktopFacade,
): IpcRegistration {
  const unsubscribeWorkspace = facade.subscribeQaWorkspace?.((event) => {
    if (!renderer.isDestroyed()) renderer.send(IPC_CHANNELS.qaWorkspaceChanged, event)
  }) ?? (() => undefined)
  const unsubscribeProject = facade.subscribeProject?.((event) => {
    if (!renderer.isDestroyed()) renderer.send(IPC_CHANNELS.projectChanged, event)
  }) ?? (() => undefined)
  const unsubscribeSimulation = facade.subscribeQaSimulation?.((event) => {
    if (!renderer.isDestroyed()) renderer.send(IPC_CHANNELS.qaSimulationChanged, event)
  }) ?? (() => undefined)
  const register = <TArgs extends unknown[], TResult>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult>,
  ): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args: TArgs) => {
      trusted(event, renderer)
      try {
        return await handler(event, ...args)
      } catch (error) {
        throw publicError(error)
      }
    })
  }

  register(IPC_CHANNELS.getSnapshot, async () => facade.getSnapshot())
  register(IPC_CHANNELS.getQaWorkspacePage, async (_event, input: unknown) => (
    facade.getQaWorkspacePage?.(parseWorkspacePageInput(input))
      ?? Promise.resolve({
        projectId: parseWorkspacePageInput(input).projectId,
        totalRounds: 0,
        items: [],
        nextCursor: null,
        dataRevision: 0,
      })
  ))
  register(IPC_CHANNELS.deleteQaWorkspaceRound, async (_event, projectId: unknown, roundId: unknown) => (
    facade.deleteQaWorkspaceRound?.(projectIdSchema.parse(projectId), documentIdSchema.parse(roundId))
      ?? Promise.resolve({ deleted: false, dataRevision: 0 })
  ))
  register(IPC_CHANNELS.clearQaWorkspaceProject, async (_event, projectId: unknown) => (
    facade.clearQaWorkspaceProject?.(projectIdSchema.parse(projectId))
      ?? Promise.resolve({ deletedRounds: 0, deletedTurns: 0, dataRevision: 0 })
  ))
  register(IPC_CHANNELS.exportQaWorkspaceProject, async (_event, projectId: unknown) => {
    await facade.exportQaWorkspaceProject?.(projectIdSchema.parse(projectId))
  })
  register(IPC_CHANNELS.dispatch, async (_event, command: unknown) => {
    await facade.dispatch(commandSchema.parse(command))
  })
  register(IPC_CHANNELS.configureProvider, async (_event, provider: unknown, apiKey: unknown) => (
    facade.configureProvider(providerSchema.parse(provider), apiKeySchema.parse(apiKey))
  ))
  register(IPC_CHANNELS.clearProvider, async (_event, provider: unknown) => facade.clearProvider(providerSchema.parse(provider)))
  register(IPC_CHANNELS.copyAnswer, async (_event, text: unknown) => {
    const validated = copyTextSchema.parse(text)
    if (facade.copyAnswer) await facade.copyAnswer(validated)
    else clipboard.writeText(validated)
  })
  register(IPC_CHANNELS.importSourceDocuments, async () => facade.importSourceDocuments())
  register(IPC_CHANNELS.importPresetQa, async () => facade.importPresetQa())
  register(IPC_CHANNELS.deleteDocument, async (_event, documentId: unknown) => facade.deleteDocument(documentIdSchema.parse(documentId)))
  register(IPC_CHANNELS.openSystemPermissions, async (_event, kind: unknown) => facade.openSystemPermissions(permissionSchema.parse(kind)))
  register(IPC_CHANNELS.requestAudioPermission, async (_event, source: unknown) => (
    facade.requestAudioPermission(audioSourceSchema.parse(source))
  ))
  register(IPC_CHANNELS.restartApplication, async () => facade.restartApplication())
  register(IPC_CHANNELS.setAlwaysOnTop, async (_event, enabled: unknown) => facade.setAlwaysOnTop(alwaysOnTopSchema.parse(enabled)))
  register(IPC_CHANNELS.getProjectState, async () => (
    facade.getProjectState?.()
      ?? Promise.resolve({
        projects: [],
        activeProjectId: null,
        run: null,
        counts: {
          added: 0,
          changed: 0,
          deleted: 0,
          awaitingAgent: 0,
          failed: 0,
          actionRequired: 0,
          completed: 0,
          total: 0,
        },
        directoryConfirmation: null,
        dataRevision: 0,
      })
  ))
  register(IPC_CHANNELS.selectProjectRoot, async (_event, projectId: unknown) => (
    facade.selectProjectRoot?.(projectId === undefined ? undefined : projectIdSchema.parse(projectId))
      ?? Promise.resolve({ status: 'cancelled' as const })
  ))
  register(IPC_CHANNELS.confirmProjectDirectories, async (_event, projectId: unknown) => {
    if (!facade.confirmProjectDirectories) throw new Error('PROJECT_SERVICE_UNAVAILABLE')
    return facade.confirmProjectDirectories(projectIdSchema.parse(projectId))
  })
  register(IPC_CHANNELS.cancelProjectPreparation, async (_event, projectId: unknown) => {
    await facade.cancelProjectPreparation?.(projectIdSchema.parse(projectId))
  })
  register(IPC_CHANNELS.activateProject, async (_event, projectId: unknown) => {
    if (!facade.activateProject) throw new Error('PROJECT_SERVICE_UNAVAILABLE')
    return facade.activateProject(projectIdSchema.parse(projectId))
  })
  register(IPC_CHANNELS.startProjectSync, async (_event, projectId: unknown) => {
    if (!facade.startProjectSync) throw new Error('PROJECT_SERVICE_UNAVAILABLE')
    return facade.startProjectSync(projectIdSchema.parse(projectId))
  })
  register(IPC_CHANNELS.cancelProjectSync, async (_event, runId: unknown) => {
    await facade.cancelProjectSync?.(runIdSchema.parse(runId))
  })
  register(IPC_CHANNELS.retryProjectSync, async (_event, projectId: unknown, runId: unknown) => {
    if (!facade.retryProjectSync) throw new Error('PROJECT_SERVICE_UNAVAILABLE')
    return facade.retryProjectSync(
      projectIdSchema.parse(projectId),
      runId === undefined || runId === null ? null : runIdSchema.parse(runId),
    )
  })
  register(IPC_CHANNELS.setProjectSyncPolicy, async (_event, projectId: unknown, policy: unknown) => {
    if (!facade.setProjectSyncPolicy) throw new Error('PROJECT_SERVICE_UNAVAILABLE')
    return facade.setProjectSyncPolicy(projectIdSchema.parse(projectId), projectPolicySchema.parse(policy))
  })
  register(IPC_CHANNELS.getProjectTaskPage, async (_event, input: unknown) => (
    facade.getProjectTaskPage?.(parseProjectTaskPageInput(input))
      ?? Promise.resolve({ items: [], nextCursor: null, dataRevision: 0 })
  ))
  register(IPC_CHANNELS.exportProjectDiagnostics, async (_event, projectId: unknown, runId: unknown) => {
    await facade.exportProjectDiagnostics?.(
      projectIdSchema.parse(projectId),
      runId === undefined || runId === null ? null : runIdSchema.parse(runId),
    )
  })
  register(IPC_CHANNELS.preflightQaSimulation, async (_event, input: unknown) => {
    if (!facade.preflightQaSimulation) throw new Error('QA_SIMULATION_UNAVAILABLE')
    return facade.preflightQaSimulation(parseSimulationPreflightInput(input))
  })
  register(IPC_CHANNELS.startQaSimulation, async (_event, input: unknown) => {
    if (!facade.startQaSimulation) throw new Error('QA_SIMULATION_UNAVAILABLE')
    return facade.startQaSimulation(parseStartSimulationInput(input))
  })
  register(IPC_CHANNELS.getQaSimulationJob, async (_event, projectId: unknown, jobId: unknown) => {
    if (!facade.getQaSimulationJob) throw new Error('QA_SIMULATION_UNAVAILABLE')
    return facade.getQaSimulationJob(projectIdSchema.parse(projectId), simulationJobIdSchema.parse(jobId))
  })
  register(IPC_CHANNELS.getLatestQaSimulationJob, async (_event, projectId: unknown) => {
    if (!facade.getLatestQaSimulationJob) throw new Error('QA_SIMULATION_UNAVAILABLE')
    return facade.getLatestQaSimulationJob(projectIdSchema.parse(projectId))
  })
  register(IPC_CHANNELS.getQaSimulationPage, async (_event, input: unknown) => {
    if (!facade.getQaSimulationPage) throw new Error('QA_SIMULATION_UNAVAILABLE')
    return facade.getQaSimulationPage(parseSimulationPageInput(input))
  })
  register(IPC_CHANNELS.cancelQaSimulation, async (_event, projectId: unknown, jobId: unknown) => {
    if (!facade.cancelQaSimulation) throw new Error('QA_SIMULATION_UNAVAILABLE')
    return facade.cancelQaSimulation(projectIdSchema.parse(projectId), simulationJobIdSchema.parse(jobId))
  })
  register(IPC_CHANNELS.resumeQaSimulation, async (_event, projectId: unknown, jobId: unknown) => {
    if (!facade.resumeQaSimulation) throw new Error('QA_SIMULATION_UNAVAILABLE')
    return facade.resumeQaSimulation(projectIdSchema.parse(projectId), simulationJobIdSchema.parse(jobId))
  })
  register(IPC_CHANNELS.updateQaSimulationItem, async (_event, input: unknown) => {
    if (!facade.updateQaSimulationItem) throw new Error('QA_SIMULATION_UNAVAILABLE')
    return facade.updateQaSimulationItem(updateSimulationItemSchema.parse(input))
  })
  register(IPC_CHANNELS.reviewQaSimulationItems, async (_event, input: unknown) => {
    if (!facade.reviewQaSimulationItems) throw new Error('QA_SIMULATION_UNAVAILABLE')
    return facade.reviewQaSimulationItems(reviewSimulationItemsSchema.parse(input))
  })
  register(IPC_CHANNELS.publishQaSimulation, async (_event, input: unknown) => {
    if (!facade.publishQaSimulation) throw new Error('QA_SIMULATION_UNAVAILABLE')
    return facade.publishQaSimulation(publishSimulationSchema.parse(input))
  })

  const channels = Object.values(IPC_CHANNELS).filter((channel) => (
    channel !== IPC_CHANNELS.snapshotChanged &&
    channel !== IPC_CHANNELS.audioLevelChanged &&
    channel !== IPC_CHANNELS.qaWorkspaceChanged &&
    channel !== IPC_CHANNELS.projectChanged &&
    channel !== IPC_CHANNELS.qaSimulationChanged
  ))
  let pendingLevel: AudioLevelSample | null = null
  let levelFlushScheduled = false
  return {
    publishSnapshot(snapshot): void {
      if (!renderer.isDestroyed()) renderer.send(IPC_CHANNELS.snapshotChanged, snapshot)
    },
    publishAudioLevel(sample): void {
      pendingLevel = sample
      if (levelFlushScheduled) return
      levelFlushScheduled = true
      queueMicrotask(() => {
        levelFlushScheduled = false
        const latest = pendingLevel
        pendingLevel = null
        if (latest !== null && !renderer.isDestroyed()) renderer.send(IPC_CHANNELS.audioLevelChanged, latest)
      })
    },
    publishQaWorkspaceChanged(update): void {
      if (!renderer.isDestroyed()) renderer.send(IPC_CHANNELS.qaWorkspaceChanged, update)
    },
    dispose(): void {
      pendingLevel = null
      unsubscribeWorkspace()
      unsubscribeProject()
      unsubscribeSimulation()
      for (const channel of channels) ipcMain.removeHandler(channel)
    },
  }
}
