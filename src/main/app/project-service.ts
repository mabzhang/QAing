import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  ProjectChangedEvent,
  ProjectConversionMode,
  ProjectDirectoryConfirmation,
  ProjectKnowledgeReadiness,
  ProjectLampStatus,
  ProjectPublicState,
  ProjectSemanticIndexSummary,
  ProjectSelectionResult,
  ProjectSummary,
  ProjectSimpleActivity,
  ProjectSimpleAttention,
  ProjectSyncCounts as PublicProjectSyncCounts,
  ProjectSyncPolicy,
  ProjectSyncRun as PublicProjectSyncRun,
  ProjectSyncStage,
  ProjectSyncTask,
  ProjectTaskErrorCode,
  ProjectTaskPage,
  ProjectTaskPageInput,
  ProjectTaskStatus,
} from '../../core/contracts'
import type { DataStore } from '../data/database'
import type {
  ProjectSourceState,
  ProjectSourceTaskRecord,
  ProjectStatusSummary,
  ProjectSyncRunRecord,
} from '../data/types'
import { ProjectSyncError } from '../project/errors'
import {
  PROJECT_INPUT_DOCUMENTS_DIRECTORY,
  PROJECT_INPUT_QA_DIRECTORY,
  PROJECT_INTERNAL_DIRECTORY,
  PROJECT_OUTPUT_DIRECTORY,
  PROJECT_OUTPUT_DOCUMENTS_DIRECTORY,
  PROJECT_OUTPUT_QA_DIRECTORY,
  prepareProjectRoot,
} from '../project/layout'
import type {
  ProjectSyncProgress,
  ProjectSyncResult,
  ProjectSyncService,
} from '../project/types'
import { serializeProjectRootIdentity } from '../project/root-identity'
import type { ProjectApplicationService } from './facade'

const PROJECT_TASK_PAGE_LIMIT = 20
const PROJECT_CONFIRMATION_DIRECTORIES = [
  PROJECT_INPUT_DOCUMENTS_DIRECTORY,
  PROJECT_INPUT_QA_DIRECTORY,
  `${PROJECT_OUTPUT_DIRECTORY}/${PROJECT_OUTPUT_DOCUMENTS_DIRECTORY}`,
  `${PROJECT_OUTPUT_DIRECTORY}/${PROJECT_OUTPUT_QA_DIRECTORY}`,
  PROJECT_INTERNAL_DIRECTORY,
] as const

interface PendingPreparation {
  readonly token: string
  readonly rootPath: string
  readonly requestedProjectId: string | null
  readonly displayName: string
}

interface RunStartWaiter {
  readonly resolve: (run: PublicProjectSyncRun) => void
}

interface ProjectDirectoryGateway {
  selectDirectory(): Promise<string | null>
  saveDiagnostics(suggestedName: string, content: string): Promise<void>
}

interface ProjectServiceOptions {
  readonly store: DataStore
  readonly sync: ProjectSyncService
  readonly directories: ProjectDirectoryGateway
  readonly scheduleIndexing?: (projectId: string) => Promise<void> | void
  readonly onKnowledgeChanged?: () => void
  readonly now?: () => number
}

function emptyCounts(): PublicProjectSyncCounts {
  return {
    added: 0,
    changed: 0,
    deleted: 0,
    awaitingAgent: 0,
    failed: 0,
    actionRequired: 0,
    completed: 0,
    total: null,
  }
}

function runStage(phase: ProjectSyncProgress['phase']): ProjectSyncStage {
  switch (phase) {
    case 'recovering':
    case 'scanning': return 'scanning'
    case 'planning': return 'reviewing'
    case 'converting': return 'converting'
    case 'complete': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'failed': return 'failed'
  }
}

function terminalRunStage(run: ProjectSyncRunRecord): ProjectSyncStage {
  switch (run.state) {
    case 'scanning': return 'scanning'
    case 'processing': return 'converting'
    case 'completed':
    case 'completed_with_errors': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'failed': return 'failed'
  }
}

function terminalRunStatus(run: ProjectSyncRunRecord): PublicProjectSyncRun['status'] {
  switch (run.state) {
    case 'scanning':
    case 'processing': return 'running'
    case 'completed':
    case 'completed_with_errors': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'failed': return 'failed'
  }
}

function progressRun(progress: ProjectSyncProgress): PublicProjectSyncRun {
  const total = progress.counts.discovered
  const completed = progress.counts.unchanged + progress.counts.converted + progress.counts.unsupported +
    progress.counts.external + progress.counts.blocked + progress.counts.failed + progress.counts.tombstoned
  return {
    id: progress.runId,
    projectId: progress.projectId,
    status: progress.phase === 'complete'
      ? 'completed'
      : progress.phase === 'cancelled'
        ? 'cancelled'
        : progress.phase === 'failed'
          ? 'failed'
          : 'running',
    stage: runStage(progress.phase),
    completedItems: Math.min(total, completed),
    totalItems: total,
    startedAt: 0,
    completedAt: progress.phase === 'complete' || progress.phase === 'cancelled' || progress.phase === 'failed'
      ? Date.now()
      : null,
  }
}

function storedRun(run: ProjectSyncRunRecord): PublicProjectSyncRun {
  // Progress is intentionally reconstructed from SQLite after restart. Both
  // generated and manually supplied canonical artifacts are terminal work and
  // must not fall back to the misleading "0 / N" presentation once the
  // in-memory progress event has gone away.
  const completed = run.counts.unchanged + run.counts.converted + run.counts.manualReady +
    run.counts.blocked + run.counts.failed + run.counts.tombstoned
  return {
    id: run.runId,
    projectId: run.projectId,
    status: terminalRunStatus(run),
    stage: terminalRunStage(run),
    completedItems: Math.min(run.counts.discovered, completed),
    totalItems: run.counts.discovered,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  }
}

function publicCounts(summary: ProjectStatusSummary, progress: ProjectSyncProgress | null): PublicProjectSyncCounts {
  const run = summary.latestRun
  const discovered = progress?.counts.discovered ?? run?.counts.discovered ?? 0
  const converted = progress?.counts.converted ?? run?.counts.converted ?? 0
  const manualReady = run?.counts.manualReady ?? 0
  const unchanged = progress?.counts.unchanged ?? run?.counts.unchanged ?? 0
  const failed = Math.max(summary.failed, progress?.counts.failed ?? run?.counts.failed ?? 0)
  const awaitingAgent = Math.max(summary.awaitingExternal, progress?.counts.external ?? 0)
  const blocked = progress?.counts.blocked ?? run?.counts.blocked ?? 0
  return {
    added: run?.counts.added ?? 0,
    changed: run?.counts.changed ?? 0,
    deleted: progress?.counts.tombstoned ?? run?.counts.tombstoned ?? 0,
    awaitingAgent,
    failed,
    // Indexing and validated manual artifacts are informational states, not
    // user actions. Count only unresolved source/conversion work here.
    actionRequired: summary.needsConversion + failed + awaitingAgent + blocked,
    completed: Math.min(discovered, unchanged + converted + manualReady),
    total: discovered,
  }
}

function semanticSummary(summary: ProjectStatusSummary): ProjectSemanticIndexSummary {
  const pendingItems = summary.pendingEmbedding
  const failedItems = summary.failedEmbedding
  const readyItems = Math.max(0, summary.readyEmbedding)
  return {
    status: failedItems > 0
      ? (readyItems > 0 ? 'degraded' : 'failed')
      : pendingItems > 0
        ? 'pending'
        : readyItems > 0
          ? 'ready'
          : 'unavailable',
    readyItems,
    pendingItems,
    failedItems,
  }
}

function projectReadiness(summary: ProjectStatusSummary): ProjectKnowledgeReadiness {
  if (!summary.hasUsableKnowledge) return 'none'
  return summary.failedEmbedding === 0 && summary.pendingEmbedding === 0 && summary.readyEmbedding > 0
    ? 'hybrid_ready'
    : 'keyword_ready'
}

function projectActivity(
  summary: ProjectStatusSummary,
  progress: ProjectSyncProgress | null,
): ProjectSimpleActivity {
  if (progress && !['complete', 'failed', 'cancelled'].includes(progress.phase)) {
    if (progress.phase === 'converting') return 'updating'
    return 'checking'
  }
  if (summary.pendingEmbedding > 0 && summary.hasUsableKnowledge) return 'optimizing'
  return 'idle'
}

function projectAttention(
  summary: ProjectStatusSummary,
  progress: ProjectSyncProgress | null,
): ProjectSimpleAttention {
  if (summary.availability === 'unavailable') return 'root_access'
  if (summary.availability === 'identity_changed') return 'root_identity'
  if (summary.failed > 0 || progress?.phase === 'failed' || summary.latestRun?.state === 'failed') {
    return summary.hasUsableKnowledge ? 'partial_failure' : 'integrity'
  }
  if (summary.actionRequiredSources > 0 || summary.awaitingExternal > 0) return 'action_required'
  if (summary.needsConversion > 0) return 'review_changes'
  if (!summary.hasUsableKnowledge) return 'no_knowledge'
  return 'none'
}

function lampStatus(summary: ProjectStatusSummary, progress: ProjectSyncProgress | null): ProjectLampStatus {
  if (summary.availability === 'unavailable') return 'root_unavailable'
  if (summary.availability === 'identity_changed') return 'integrity_failed'
  if (progress && !['complete', 'failed', 'cancelled'].includes(progress.phase)) {
    return progress.phase === 'converting' ? 'syncing' : 'checking'
  }
  if (progress?.phase === 'cancelled' || summary.latestRun?.state === 'cancelled') return 'cancelled'
  if (summary.failed > 0 || progress?.phase === 'failed' || summary.latestRun?.state === 'failed') {
    return summary.hasUsableKnowledge ? 'partial_failure' : 'integrity_failed'
  }
  // Manual is provenance, not project health. Likewise embedding work is a
  // non-blocking optimization once keyword retrieval is usable.
  if (summary.actionRequiredSources > 0 || summary.needsConversion > 0 || summary.awaitingExternal > 0) {
    return 'changes_detected'
  }
  if (!summary.hasUsableKnowledge) return 'no_knowledge'
  return 'synced'
}

function publicErrorCode(errorCode: string | null): ProjectTaskErrorCode | null {
  switch (errorCode) {
    case null: return null
    case 'PROJECT_ROOT_UNAVAILABLE': return 'PROJECT_ROOT_UNAVAILABLE'
    case 'PROJECT_ROOT_IDENTITY_CHANGED': return 'PROJECT_ROOT_IDENTITY_CHANGED'
    case 'INPUT_ESCAPES_ROOT': return 'INPUT_ESCAPES_ROOT'
    case 'INPUT_SYMLINK_BLOCKED': return 'INPUT_SYMLINK_BLOCKED'
    case 'INPUT_CHANGED_DURING_READ': return 'INPUT_CHANGED_DURING_READ'
    case 'INPUT_TOO_LARGE': return 'INPUT_TOO_LARGE'
    case 'CONVERTER_TIMEOUT': return 'CONVERTER_TIMEOUT'
    case 'CONVERTER_CRASHED':
    case 'CONVERTER_UNAVAILABLE': return 'CONVERTER_CRASHED'
    case 'OUTPUT_TOO_LARGE': return 'OUTPUT_TOO_LARGE'
    case 'OUTPUT_INVALID':
    case 'CONVERTER_INVALID_RESPONSE':
    case 'INPUT_ENCODING_INVALID': return 'OUTPUT_INVALID'
    case 'GENERATED_OUTPUT_MODIFIED': return 'GENERATED_OUTPUT_MODIFIED'
    case 'PRESET_QA_CONFLICT': return 'PRESET_QA_CONFLICT'
    case 'DB_COMMIT_FAILED': return 'DB_COMMIT_FAILED'
    case 'DISK_FULL': return 'DISK_FULL'
    case 'INPUT_PATH_COLLISION': return 'RENAME_AMBIGUOUS'
    default: return 'INPUT_UNSUPPORTED'
  }
}

function taskStatus(state: ProjectSourceState, mode: ProjectConversionMode): ProjectTaskStatus {
  switch (state) {
    case 'needs_conversion': return 'needs_conversion'
    case 'converting': return 'converting'
    case 'validating': return 'validating'
    case 'artifact_staged': return mode === 'manual' ? 'manual_ready' : 'staged'
    case 'published_fs': return 'published'
    case 'embedding_pending': return mode === 'manual' ? 'manual_ready' : 'indexing'
    case 'ready': return mode === 'manual' ? 'manual_ready' : 'ready'
    case 'missing_grace': return 'missing_grace'
    case 'tombstoned': return 'removed'
    case 'blocked': return 'blocked'
    case 'conversion_failed':
    case 'commit_failed':
    case 'index_failed': return 'failed'
  }
}

function conversionMode(task: ProjectSourceTaskRecord): ProjectConversionMode {
  if (task.currentConversionMode) return task.currentConversionMode
  return task.conversionDisposition === 'local' ? 'local' : 'external'
}

function publicTask(task: ProjectSourceTaskRecord): ProjectSyncTask {
  const mode = conversionMode(task)
  const status = taskStatus(task.state, mode)
  return {
    id: task.sourceId,
    projectId: task.projectId,
    runId: task.latestRunId,
    relativePath: task.displayRelativePath,
    kind: task.trustKind === 'document' ? 'source_document' : 'preset_qa',
    conversionMode: mode,
    status,
    lastGoodAvailable: task.lastGoodAvailable,
    requiresAction: status === 'failed' || status === 'blocked' || status === 'missing_grace' ||
      (status === 'needs_conversion' && mode === 'external'),
    errorCode: publicErrorCode(task.errorCode),
    updatedAt: task.updatedAt,
  }
}

export class DesktopProjectApplicationService implements ProjectApplicationService {
  readonly #store: DataStore
  readonly #sync: ProjectSyncService
  readonly #directories: ProjectDirectoryGateway
  readonly #scheduleIndexing: ((projectId: string) => Promise<void> | void) | undefined
  readonly #onKnowledgeChanged: (() => void) | undefined
  readonly #now: () => number
  readonly #pending = new Map<string, PendingPreparation>()
  readonly #listeners = new Set<(event: ProjectChangedEvent) => void>()
  readonly #progress = new Map<string, ProjectSyncProgress>()
  readonly #startWaiters = new Map<string, RunStartWaiter>()
  readonly #runTasks = new Map<string, Promise<void>>()
  #disposed = false

  constructor(options: ProjectServiceOptions) {
    this.#store = options.store
    this.#sync = options.sync
    this.#directories = options.directories
    this.#scheduleIndexing = options.scheduleIndexing
    this.#onKnowledgeChanged = options.onKnowledgeChanged
    this.#now = options.now ?? Date.now
  }

  async initialize(): Promise<void> {
    this.#assertUsable()
    this.#store.recoverInterruptedProjectRuns(this.#now())
    for (const project of this.#store.listProjects()) {
      try {
        await this.#sync.watch(project.id, project.syncPolicy)
      } catch (error) {
        this.#recordRootFailure(project.id, error)
      }
    }
    const activeProjectId = this.#store.getActiveProjectId()
    const activeProject = activeProjectId ? this.#store.getProject(activeProjectId) : null
    if (activeProject?.availability === 'available') {
      void this.#startBackgroundSync(activeProject.id, 'startup', activeProject.syncPolicy === 'auto_check_apply')
    }
  }

  async getState(): Promise<ProjectPublicState> {
    this.#assertUsable()
    const activeProjectId = this.#store.getActiveProjectId()
    const summaries = this.#store.listProjects().map((project) => {
      const summary = this.#store.getProjectStatusSummary(project.id)
      return this.#summary(project.displayName, project.syncPolicy, summary, this.#progress.get(project.id) ?? null)
    })
    const activeSummary = activeProjectId ? this.#store.getProjectStatusSummary(activeProjectId) : null
    const progress = activeProjectId ? this.#progress.get(activeProjectId) ?? null : null
    const pending = [...this.#pending.values()].at(-1) ?? null
    return {
      projects: summaries,
      activeProjectId,
      run: progress ? this.#progressRunWithStartedAt(progress) : activeSummary?.latestRun ? storedRun(activeSummary.latestRun) : null,
      counts: activeSummary ? publicCounts(activeSummary, progress) : emptyCounts(),
      directoryConfirmation: pending ? this.#confirmation(pending) : null,
      // The renderer keeps one revision floor while moving between projects.
      // Always expose the catalog-wide monotonic revision rather than mixing
      // per-project counters with the global unselected state.
      dataRevision: this.#store.projectDataRevision(),
    }
  }

  async selectRoot(projectId?: string): Promise<ProjectSelectionResult> {
    this.#assertUsable()
    const rootPath = await this.#directories.selectDirectory()
    if (rootPath === null) return { status: 'cancelled' }
    try {
      const project = projectId
        ? await this.#relocateReadyProject(projectId, rootPath)
        : await this.#sync.prepareRoot({ rootPath, createMissing: false })
      this.#store.setActiveProject(project.id)
      const policy = this.#store.getProject(project.id)?.syncPolicy ?? 'auto_check_confirm'
      await this.#sync.watch(project.id, policy)
      this.#emit(project.id, 'all')
      void this.#startVisibleSync(project.id, 'manual', policy !== 'auto_check_confirm')
      return { status: 'ready', project: this.#publicSummary(project.id) }
    } catch (error) {
      if (!(error instanceof ProjectSyncError) || error.code !== 'PROJECT_LAYOUT_MISSING') throw error
      const token = `pending_${randomUUID().replaceAll('-', '')}`
      const pending: PendingPreparation = {
        token,
        rootPath,
        requestedProjectId: projectId ?? null,
        displayName: basename(rootPath) || '未命名项目',
      }
      this.#pending.clear()
      this.#pending.set(token, pending)
      this.#emit(projectId ?? token, 'summary')
      return { status: 'confirmation_required', confirmation: this.#confirmation(pending) }
    }
  }

  async confirmDirectories(token: string): Promise<ProjectSummary> {
    this.#assertUsable()
    const pending = this.#pending.get(token)
    if (!pending) throw new Error('PROJECT_PREPARATION_NOT_FOUND')
    const project = pending.requestedProjectId
      ? await this.#relocatePreparedProject(pending.requestedProjectId, pending.rootPath)
      : await this.#sync.prepareRoot({ rootPath: pending.rootPath, createMissing: true })
    this.#pending.delete(token)
    this.#store.setActiveProject(project.id)
    const policy = this.#store.getProject(project.id)?.syncPolicy ?? 'auto_check_confirm'
    await this.#sync.watch(project.id, policy)
    this.#emit(project.id, 'all')
    return this.#publicSummary(project.id)
  }

  async cancelPreparation(token: string): Promise<void> {
    this.#pending.delete(token)
  }

  async activate(projectId: string): Promise<ProjectSummary> {
    this.#assertUsable()
    const project = this.#store.getProject(projectId)
    if (!project) throw new Error('PROJECT_NOT_FOUND')
    this.#store.setActiveProject(projectId)
    await this.#sync.watch(projectId, project.syncPolicy)
    this.#emit(projectId, 'all')
    return this.#publicSummary(projectId)
  }

  startSync(projectId: string): Promise<PublicProjectSyncRun> {
    return this.#startVisibleSync(projectId, 'manual', true)
  }

  async cancelSync(runId: string): Promise<void> {
    const progress = [...this.#progress.values()].find((entry) => entry.runId === runId)
    if (progress) {
      this.#progress.set(progress.projectId, { ...progress, phase: 'cancelled' })
      this.#emit(progress.projectId, 'all')
    }
    this.#sync.cancel(runId)
  }

  retrySync(projectId: string): Promise<PublicProjectSyncRun> {
    return this.#startVisibleSync(projectId, 'manual', true)
  }

  async setSyncPolicy(projectId: string, policy: ProjectSyncPolicy): Promise<ProjectSummary> {
    this.#store.setProjectSyncPolicy(projectId, policy)
    await this.#sync.watch(projectId, policy)
    this.#emit(projectId, 'summary')
    return this.#publicSummary(projectId)
  }

  async getTaskPage(input: ProjectTaskPageInput): Promise<ProjectTaskPage> {
    const page = this.#store.getProjectSourcePage({
      projectId: input.projectId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: Math.min(PROJECT_TASK_PAGE_LIMIT, Math.max(1, input.limit ?? PROJECT_TASK_PAGE_LIMIT)),
      filter: input.filter === 'action_required' ? 'attention' : input.filter ?? 'all',
    })
    return {
      items: page.items.map(publicTask),
      nextCursor: page.nextCursor,
      dataRevision: this.#store.projectDataRevision(),
    }
  }

  async exportDiagnostics(projectId: string, runId?: string | null): Promise<void> {
    const project = this.#store.getProject(projectId)
    if (!project) throw new Error('PROJECT_NOT_FOUND')
    const summary = this.#store.getProjectStatusSummary(projectId)
    const run = runId ? this.#store.getProjectSyncRun(runId) : summary.latestRun
    const tasks = this.#store.getProjectSourcePage({ projectId, limit: PROJECT_TASK_PAGE_LIMIT }).items
    const payload = {
      schema: 'qaing-project-diagnostics/v1',
      createdAt: this.#now(),
      project: {
        id: project.id,
        availability: project.availability,
        syncPolicy: project.syncPolicy,
        scanGeneration: project.scanGeneration,
        knowledgeVersion: project.knowledgeVersion,
      },
      summary: {
        totalFiles: summary.totalFiles,
        ready: summary.ready,
        attention: summary.attention,
        failed: summary.failed,
        pendingEmbedding: summary.pendingEmbedding,
      },
      run: run ? {
        id: run.runId,
        generation: run.generation,
        trigger: run.trigger,
        state: run.state,
        counts: run.counts,
        errorCode: run.errorCode,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      } : null,
      tasks: tasks.map((task) => ({
        id: task.sourceId,
        relativePath: task.displayRelativePath,
        trustKind: task.trustKind,
        state: task.state,
        errorCode: task.errorCode,
        lastGoodAvailable: task.lastGoodAvailable,
      })),
    }
    await this.#directories.saveDiagnostics(
      `QAing-${project.displayName}-诊断摘要.json`,
      `${JSON.stringify(payload, null, 2)}\n`,
    )
  }

  subscribe(listener: (event: ProjectChangedEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  handleProgress(progress: ProjectSyncProgress): void {
    if (this.#disposed) return
    this.#progress.set(progress.projectId, progress)
    const waiter = this.#startWaiters.get(progress.projectId)
    if (waiter) {
      this.#startWaiters.delete(progress.projectId)
      waiter.resolve(this.#progressRunWithStartedAt(progress))
    }
    this.#emit(progress.projectId, 'all')
  }

  handleStoreChanged(projectId: string): void {
    if (this.#disposed || !this.#store.getProject(projectId)) return
    this.#emit(projectId, 'all')
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    await this.#sync.dispose()
    await Promise.allSettled(this.#runTasks.values())
  }

  #summary(
    displayName: string,
    syncPolicy: ProjectSyncPolicy,
    summary: ProjectStatusSummary,
    progress: ProjectSyncProgress | null,
  ): ProjectSummary {
    const activity = projectActivity(summary, progress)
    const attention = projectAttention(summary, progress)
    const pendingChanges = Math.max(0, summary.needsConversion)
    const issueCount = Math.max(0, summary.actionRequiredSources, summary.failed)
    return {
      id: summary.projectId,
      displayName,
      lampStatus: lampStatus(summary, progress),
      lastCompletedScanAt: summary.lastScanAt,
      knowledgeVersion: summary.knowledgeVersion > 0 ? summary.knowledgeVersion : null,
      syncPolicy,
      semanticIndex: semanticSummary(summary),
      knowledgeSummary: {
        usableDocumentSources: summary.usableDocumentSources,
        usablePresetQaSources: summary.usablePresetQaSources,
        usablePresetQaItems: summary.usablePresetQaItems,
      },
      simpleStatus: {
        readiness: projectReadiness(summary),
        activity,
        attention,
        pendingChanges,
        issueCount,
        detailsRecommended: attention !== 'none' || activity === 'checking' || activity === 'updating',
      },
    }
  }

  #publicSummary(projectId: string): ProjectSummary {
    const project = this.#store.getProject(projectId)
    if (!project) throw new Error('PROJECT_NOT_FOUND')
    return this.#summary(
      project.displayName,
      project.syncPolicy,
      this.#store.getProjectStatusSummary(projectId),
      this.#progress.get(projectId) ?? null,
    )
  }

  #confirmation(pending: PendingPreparation): ProjectDirectoryConfirmation {
    return {
      projectId: pending.token,
      projectName: pending.displayName,
      directories: PROJECT_CONFIRMATION_DIRECTORIES,
    }
  }

  async #relocateReadyProject(projectId: string, rootPath: string) {
    const descriptor = await prepareProjectRoot({ rootPath, projectId, createMissing: false })
    const record = this.#store.relocateProjectManifest({
      projectId,
      rootPath: descriptor.rootPath,
      rootIdentity: serializeProjectRootIdentity(descriptor.rootIdentity),
    })
    return { ...descriptor, scanGeneration: record.scanGeneration }
  }

  async #relocatePreparedProject(projectId: string, rootPath: string) {
    const descriptor = await prepareProjectRoot({ rootPath, projectId, createMissing: true })
    const record = this.#store.relocateProjectManifest({
      projectId,
      rootPath: descriptor.rootPath,
      rootIdentity: serializeProjectRootIdentity(descriptor.rootIdentity),
    })
    return { ...descriptor, scanGeneration: record.scanGeneration }
  }

  #startVisibleSync(
    projectId: string,
    trigger: 'manual' | 'startup' | 'watcher',
    apply: boolean,
  ): Promise<PublicProjectSyncRun> {
    this.#assertUsable()
    // Always pass the requested strength to the kernel. It coalesces equal
    // work but schedules one stronger apply run behind an in-flight check,
    // so a background check can never swallow an explicit user update.
    let resolveStarted: (run: PublicProjectSyncRun) => void = () => undefined
    const started = new Promise<PublicProjectSyncRun>((resolve) => { resolveStarted = resolve })
    this.#startWaiters.set(projectId, { resolve: resolveStarted })
    const operation = this.#sync.sync({ projectId, trigger, apply })
    const terminal = operation.then((result) => {
      this.handleProgress({ ...result, projectId, runId: result.runId, generation: result.generation })
      void this.#afterKnowledgeCommit(projectId)
      return this.#terminalResult(result)
    })
    const lifecycle = operation.then(
      () => undefined,
      (error: unknown) => {
        this.#recordRootFailure(projectId, error)
        this.#emit(projectId, 'all')
      },
    ).finally(() => {
      this.#startWaiters.delete(projectId)
      this.#runTasks.delete(projectId)
    })
    this.#runTasks.set(projectId, lifecycle)
    return Promise.race([started, terminal])
  }

  async #startBackgroundSync(projectId: string, trigger: 'startup' | 'watcher', apply: boolean): Promise<void> {
    try {
      await this.#startVisibleSync(projectId, trigger, apply)
    } catch {
      // Availability and safe public state are updated by the lifecycle path.
    }
  }

  async #afterKnowledgeCommit(projectId: string): Promise<void> {
    try {
      await this.#scheduleIndexing?.(projectId)
    } catch {
      // FTS and the last-good artifact are already committed. Index scheduling
      // is recoverable and must never become an unhandled rejection.
    }
    try { this.#onKnowledgeChanged?.() } catch { /* notification is best effort */ }
    this.#emit(projectId, 'all')
  }

  #terminalResult(result: ProjectSyncResult): PublicProjectSyncRun {
    const persisted = this.#store.getProjectSyncRun(result.runId)
    if (persisted && !['scanning', 'processing'].includes(persisted.state)) return storedRun(persisted)
    return {
      id: result.runId,
      projectId: result.projectId,
      status: result.phase === 'complete' ? 'completed' : result.phase === 'cancelled' ? 'cancelled' : 'failed',
      stage: result.phase === 'complete' ? 'completed' : result.phase,
      completedItems: result.counts.unchanged + result.counts.converted,
      totalItems: result.counts.discovered,
      startedAt: this.#store.getProjectSyncRun(result.runId)?.startedAt ?? result.completedAt,
      completedAt: result.completedAt,
    }
  }

  #progressRunWithStartedAt(progress: ProjectSyncProgress): PublicProjectSyncRun {
    if (['complete', 'cancelled', 'failed'].includes(progress.phase)) {
      const persisted = this.#store.getProjectSyncRun(progress.runId)
      if (persisted && !['scanning', 'processing'].includes(persisted.state)) return storedRun(persisted)
    }
    const mapped = progressRun(progress)
    return {
      ...mapped,
      startedAt: this.#store.getProjectSyncRun(progress.runId)?.startedAt ?? this.#now(),
      ...(mapped.completedAt === null ? {} : { completedAt: this.#now() }),
    }
  }

  #recordRootFailure(projectId: string, error: unknown): void {
    if (!this.#store.getProject(projectId)) return
    if (error instanceof ProjectSyncError && error.code === 'PROJECT_ROOT_UNAVAILABLE') {
      this.#store.setProjectAvailability(projectId, 'unavailable', error.code, this.#now())
    } else if (error instanceof ProjectSyncError && error.code === 'PROJECT_ROOT_IDENTITY_CHANGED') {
      this.#store.setProjectAvailability(projectId, 'identity_changed', error.code, this.#now())
    }
  }

  #emit(projectId: string, scope: ProjectChangedEvent['scope']): void {
    const revision = this.#store.projectDataRevision()
    const event = { projectId, dataRevision: revision, scope } as const
    for (const listener of this.#listeners) {
      try { listener(event) } catch { /* SQLite is canonical; delivery is best effort. */ }
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error('PROJECT_SERVICE_DISPOSED')
  }
}
