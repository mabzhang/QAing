import type {
  ProjectLampStatus,
  ProjectSemanticIndexStatus,
  ProjectSummary,
  ProjectSyncRun,
  ProjectSyncStage,
  ProjectSyncTask,
  ProjectTaskErrorCode,
  ProjectTaskStatus,
  ProjectUiErrorCode,
} from '../../core/contracts'
import type { ProjectUiState } from './contracts'

export type ProjectStatusTone = 'gray' | 'green' | 'yellow' | 'red'

export const PROJECT_PROGRESS_ANNOUNCEMENT_INTERVAL_MS = 500
export const MAX_PROJECT_PATH_LABEL_CHARACTERS = 240

export type ProjectSyncDisplayPhase =
  | 'idle'
  | 'checked_changes'
  | 'waiting_apply'
  | 'syncing'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface ProjectSyncDisplay {
  readonly phase: ProjectSyncDisplayPhase
  readonly label: string
  readonly detail: string
  readonly completedStages: readonly ProjectSyncStage[]
  readonly currentStage: ProjectSyncStage | null
  readonly failedStage: ProjectSyncStage | null
  readonly progress: { readonly value: number; readonly max: number } | null
}

export function projectAnnouncementDelay(
  lastPublishedAt: number,
  now: number,
  intervalMs = PROJECT_PROGRESS_ANNOUNCEMENT_INTERVAL_MS,
): number {
  if (!Number.isFinite(lastPublishedAt) || !Number.isFinite(now)) return intervalMs
  return Math.max(0, intervalMs - Math.max(0, now - lastPublishedAt))
}

const ABSOLUTE_OR_TRAVERSAL_PATH = /^(?:[/\\]|~[/\\]|[A-Za-z]:[/\\])|(?:^|[/\\])\.\.(?:[/\\]|$)/u

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (
      codePoint < 32
      || codePoint === 127
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)
    )
  })
}

export function safeProjectPathLabel(value: string): string {
  const normalized = value.normalize('NFC').trim()
  if (!normalized || ABSOLUTE_OR_TRAVERSAL_PATH.test(normalized) || hasControlCharacter(normalized)) {
    return '路径已隐藏'
  }
  if (normalized.length <= MAX_PROJECT_PATH_LABEL_CHARACTERS) return normalized
  return `${normalized.slice(0, MAX_PROJECT_PATH_LABEL_CHARACTERS - 1)}…`
}

export function safeProjectName(value: string): string {
  const normalized = safeProjectPathLabel(value)
  return normalized === '路径已隐藏' ? '项目名称已隐藏' : normalized
}

export interface ProjectStatusPresentation {
  readonly tone: ProjectStatusTone
  readonly label: string
  readonly detail: string
}

const PROJECT_LAMP_PRESENTATIONS: Readonly<Record<ProjectLampStatus, ProjectStatusPresentation>> = {
  unselected: { tone: 'gray', label: '尚未选择项目', detail: '选择项目根后才会核对固定输入目录。' },
  synced: { tone: 'green', label: '已同步', detail: '当前稳定知识版本可用。' },
  checking: { tone: 'yellow', label: '正在检查项目变化', detail: '旧知识版本保持可用。' },
  changes_detected: { tone: 'yellow', label: '发现待处理变化', detail: '核对后再安全应用到知识库。' },
  manual_ready: { tone: 'yellow', label: '手动转换已就绪', detail: '已严格校验并提交，关键词检索可用。' },
  syncing: { tone: 'yellow', label: '正在更新知识库', detail: '未完成的新版不会替换 last-good。' },
  partial_failure: { tone: 'yellow', label: '部分项目未完成', detail: '已应用可用内容，失败项继续使用上次版本。' },
  root_unavailable: { tone: 'red', label: '项目目录不可访问', detail: '未把目录不可达误判为文件删除。' },
  no_knowledge: { tone: 'red', label: '没有可用知识版本', detail: '完成至少一次安全应用后才能使用项目知识。' },
  integrity_failed: { tone: 'red', label: '一致性校验失败', detail: '更新未应用，last-good 保持不变。' },
  cancelled: { tone: 'yellow', label: '本次更新已取消', detail: '已原子发布的内容保留。' },
}

const PROJECT_UI_ERRORS: Readonly<Record<ProjectUiErrorCode, ProjectStatusPresentation>> = {
  PROJECT_ROOT_UNAVAILABLE: PROJECT_LAMP_PRESENTATIONS.root_unavailable,
  PROJECT_ROOT_IDENTITY_CHANGED: {
    tone: 'red', label: '项目根身份已变化', detail: '请确认这是移动后的同一项目，或重新选择。',
  },
  NO_KNOWLEDGE: PROJECT_LAMP_PRESENTATIONS.no_knowledge,
  INTEGRITY_FAILED: PROJECT_LAMP_PRESENTATIONS.integrity_failed,
  LOAD_FAILED: {
    tone: 'red', label: '项目状态暂时无法读取', detail: '当前已发布知识不受影响，可稍后重试。',
  },
}

export function projectStatusPresentation(
  project: ProjectSummary | null,
  errorCode: ProjectUiErrorCode | null,
  loading = false,
): ProjectStatusPresentation {
  if (errorCode !== null) return PROJECT_UI_ERRORS[errorCode]
  if (loading && project === null) {
    return { tone: 'gray', label: '正在读取项目状态', detail: '当前已发布知识保持不变。' }
  }
  return PROJECT_LAMP_PRESENTATIONS[project?.lampStatus ?? 'unselected']
}

/**
 * Default-project UX must be driven by the durable lightweight projection,
 * never reconstructed from a restored run, a paged task list, or embedding
 * counters. The legacy lamp presentation remains available for diagnostics.
 */
export function projectSimpleStatusPresentation(
  project: ProjectSummary | null,
  errorCode: ProjectUiErrorCode | null,
  loading = false,
): ProjectStatusPresentation {
  if (errorCode !== null || project === null) return projectStatusPresentation(project, errorCode, loading)
  const status = project.simpleStatus
  switch (status.attention) {
    case 'root_access': return PROJECT_LAMP_PRESENTATIONS.root_unavailable
    case 'root_identity': return PROJECT_UI_ERRORS.PROJECT_ROOT_IDENTITY_CHANGED
    case 'integrity': return PROJECT_LAMP_PRESENTATIONS.integrity_failed
    case 'no_knowledge': return PROJECT_LAMP_PRESENTATIONS.no_knowledge
    case 'partial_failure': return {
      tone: 'yellow',
      label: '部分项目未完成',
      detail: `${status.issueCount.toLocaleString('zh-CN')} 项需要处理，已发布知识继续可用。`,
    }
    case 'action_required': return {
      tone: 'yellow',
      label: '有项目需要处理',
      detail: `${status.issueCount.toLocaleString('zh-CN')} 项需要确认，现有知识保持可用。`,
    }
    case 'review_changes': return {
      tone: 'yellow',
      label: '发现待处理变化',
      detail: `${status.pendingChanges.toLocaleString('zh-CN')} 项变化待核对和应用。`,
    }
    case 'none': break
  }
  switch (status.activity) {
    case 'checking': return PROJECT_LAMP_PRESENTATIONS.checking
    case 'updating': return PROJECT_LAMP_PRESENTATIONS.syncing
    case 'cancelling': return PROJECT_LAMP_PRESENTATIONS.cancelled
    case 'optimizing': return status.readiness === 'none'
      ? PROJECT_LAMP_PRESENTATIONS.no_knowledge
      : { tone: 'green', label: '已同步', detail: '当前知识可用，语义索引正在后台补齐。' }
    case 'idle': break
  }
  if (status.readiness === 'hybrid_ready') return PROJECT_LAMP_PRESENTATIONS.synced
  if (status.readiness === 'keyword_ready') return {
    tone: 'green',
    label: '资料库可用',
    detail: '关键词检索可用，语义增强中。',
  }
  return PROJECT_LAMP_PRESENTATIONS.no_knowledge
}

export interface SemanticIndexPresentation {
  readonly tone: 'neutral' | 'ready' | 'pending' | 'warning' | 'danger'
  readonly label: string
}

const SEMANTIC_INDEX_LABELS: Readonly<Record<ProjectSemanticIndexStatus, SemanticIndexPresentation>> = {
  unavailable: { tone: 'neutral', label: '语义索引未就绪' },
  ready: { tone: 'ready', label: '语义索引已就绪' },
  pending: { tone: 'pending', label: '语义索引补齐中' },
  degraded: { tone: 'warning', label: '语义索引降级' },
  failed: { tone: 'danger', label: '语义索引失败' },
}

export function semanticIndexPresentation(status: ProjectSemanticIndexStatus): SemanticIndexPresentation {
  return SEMANTIC_INDEX_LABELS[status]
}

export const PROJECT_SYNC_STAGE_ORDER: readonly ProjectSyncStage[] = [
  'scanning',
  'reviewing',
  'converting',
  'indexing',
  'applying',
]

export const PROJECT_SYNC_STAGE_LABELS: Readonly<Record<ProjectSyncStage, string>> = {
  idle: '等待检查',
  scanning: '扫描',
  reviewing: '核对',
  converting: '转换',
  indexing: '索引',
  applying: '安全应用',
  completed: '已完成',
  cancelled: '已取消',
  failed: '未完成',
}

const PROJECT_PENDING_APPLY_STATUSES = new Set<ProjectTaskStatus>([
  'discovered',
  'stability_wait',
  'hashing',
  'needs_conversion',
  'awaiting_llm_consent',
  'awaiting_external_agent',
  'validating',
  'staged',
  'missing_grace',
  'blocked',
])

const PROJECT_FAILURE_LAMPS = new Set<ProjectLampStatus>([
  'partial_failure',
  'root_unavailable',
  'integrity_failed',
])

function safeProjectCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function safeRunTotal(run: ProjectSyncRun | null): number | null {
  return run?.totalItems !== null
    && run?.totalItems !== undefined
    && Number.isSafeInteger(run.totalItems)
    && run.totalItems >= 0
    ? run.totalItems
    : null
}

function completedStagesBefore(stage: ProjectSyncStage): readonly ProjectSyncStage[] {
  const index = PROJECT_SYNC_STAGE_ORDER.indexOf(stage)
  return index <= 0 ? [] : PROJECT_SYNC_STAGE_ORDER.slice(0, index)
}

function projectFailureStage(state: ProjectUiState): ProjectSyncStage {
  const tasks = state.taskPage?.items ?? []
  if (tasks.some((task) => task.errorCode === 'DB_COMMIT_FAILED' || task.errorCode === 'DISK_FULL')) return 'applying'
  if (state.activeProject?.semanticIndex.status === 'failed') return 'indexing'
  if (state.errorCode === 'PROJECT_ROOT_UNAVAILABLE' || state.errorCode === 'PROJECT_ROOT_IDENTITY_CHANGED') return 'scanning'
  return 'converting'
}

/**
 * Turns the storage/run projection into a truthful UI journey. A check-only
 * run is terminal in storage, but it has not converted or applied the pending
 * files; therefore it must never paint the entire pipeline green.
 */
export function projectSyncDisplay(state: ProjectUiState): ProjectSyncDisplay {
  const run = state.run
  const project = state.activeProject
  const tasks = state.taskPage?.items ?? []
  const total = safeRunTotal(run) ?? (
    state.counts.total !== null && Number.isSafeInteger(state.counts.total) && state.counts.total >= 0
      ? state.counts.total
      : null
  )
  const completed = safeProjectCount(state.counts.completed)
  const failed = Math.max(
    safeProjectCount(state.counts.failed),
    tasks.filter((task) => task.status === 'failed' || task.status === 'blocked').length,
  )
  const pendingTasks = tasks.filter((task) => PROJECT_PENDING_APPLY_STATUSES.has(task.status)).length
  const changed = safeProjectCount(state.counts.added)
    + safeProjectCount(state.counts.changed)
    + safeProjectCount(state.counts.deleted)
  const terminalStableProject = run?.status === 'completed'
    && (project?.lampStatus === 'synced' || project?.lampStatus === 'manual_ready')
  const pending = Math.max(
    pendingTasks,
    safeProjectCount(state.counts.actionRequired),
    total === null || terminalStableProject ? 0 : Math.max(0, total - completed - failed),
  )

  if (run?.status === 'running' || run?.status === 'cancel_requested') {
    const currentStage = PROJECT_SYNC_STAGE_ORDER.includes(run.stage) ? run.stage : 'scanning'
    const runningCompleted = safeProjectCount(run.completedItems)
    return {
      phase: 'syncing',
      label: run.status === 'cancel_requested' ? '正在安全取消' : `正在${PROJECT_SYNC_STAGE_LABELS[currentStage]}`,
      detail: run.status === 'cancel_requested'
        ? `已处理 ${runningCompleted.toLocaleString('zh-CN')} 项，已发布的内容保留。`
        : '上次稳定知识版本在新版完整提交前继续可用。',
      completedStages: completedStagesBefore(currentStage),
      currentStage,
      failedStage: null,
      progress: total !== null && total > 0
        ? { value: Math.min(runningCompleted, total), max: total }
        : null,
    }
  }

  if (run?.status === 'cancelled' || project?.lampStatus === 'cancelled') {
    return {
      phase: 'cancelled',
      label: '本次更新已取消',
      detail: `已安全处理 ${completed.toLocaleString('zh-CN')} 项，已原子发布的内容保留。`,
      completedStages: [],
      currentStage: null,
      failedStage: null,
      progress: null,
    }
  }

  if (
    run?.status === 'failed'
    || failed > 0
    || (project !== null && PROJECT_FAILURE_LAMPS.has(project.lampStatus))
  ) {
    const failedStage = projectFailureStage(state)
    const hasLastGood = tasks.some((task) => task.lastGoodAvailable) || project?.knowledgeVersion !== null
    return {
      phase: 'failed',
      label: project?.lampStatus === 'partial_failure' ? '部分项目未完成' : '本次更新未完成',
      detail: failed > 0
        ? `${failed.toLocaleString('zh-CN')} 项处理失败；${hasLastGood ? '上次成功版本仍可用。' : '未发布不完整的新版。'}`
        : hasLastGood
          ? '更新在发布前终止，上次成功版本仍可用。'
          : '更新在发布前终止，未发布不完整的新版。',
      completedStages: completedStagesBefore(failedStage),
      currentStage: null,
      failedStage,
      progress: null,
    }
  }

  const waitingForApply = project?.lampStatus === 'changes_detected' || pending > 0
  if (waitingForApply) {
    return {
      phase: 'waiting_apply',
      label: '检查完成，等待应用',
      detail: `${pending.toLocaleString('zh-CN')} 项变化待处理；尚未替换当前知识版本。`,
      completedStages: ['scanning', 'reviewing'],
      currentStage: null,
      failedStage: null,
      progress: null,
    }
  }

  const manuallyValidated = project?.lampStatus === 'manual_ready'
  if (run?.status === 'completed' && changed === 0 && !manuallyValidated) {
    return {
      phase: 'checked_changes',
      label: '项目检查完成',
      detail: '未发现需要应用的变化，当前知识版本保持不变。',
      completedStages: ['scanning', 'reviewing'],
      currentStage: null,
      failedStage: null,
      progress: null,
    }
  }

  if (run?.status === 'completed' || manuallyValidated) {
    const applied = total ?? Math.max(completed, changed)
    return {
      phase: 'completed',
      label: manuallyValidated ? '手动转换已就绪' : '知识库更新完成',
      detail: manuallyValidated
        ? '手动 Markdown 已严格校验并提交，关键词检索可用；语义索引状态单独显示。'
        : applied > 0
          ? `${applied.toLocaleString('zh-CN')} 项已安全处理，新知识版本已发布。`
          : '未发现需要更新的项目。',
      completedStages: PROJECT_SYNC_STAGE_ORDER,
      currentStage: null,
      failedStage: null,
      progress: applied > 0 ? { value: applied, max: applied } : null,
    }
  }

  return {
    phase: 'idle',
    label: '等待检查',
    detail: '选择“检查并更新知识库”后开始。',
    completedStages: [],
    currentStage: null,
    failedStage: null,
    progress: null,
  }
}

export const PROJECT_TASK_STATUS_LABELS: Readonly<Record<ProjectTaskStatus, string>> = {
  discovered: '已发现',
  stability_wait: '等待文件稳定',
  hashing: '内容核对中',
  unchanged: '未变化',
  needs_conversion: '待转换',
  converting: '转换中',
  awaiting_llm_consent: '等待 LLM 授权',
  awaiting_external_agent: '等待外部 Agent',
  validating: '正在校验',
  staged: '已安全暂存',
  published: '关键词可用',
  indexing: '语义索引中',
  ready: '已就绪',
  manual_ready: '手动转换已就绪',
  missing_grace: '等待再次确认缺失',
  removed: '已移除',
  blocked: '需要处理',
  failed: '处理失败',
  cancelled: '已取消',
}

export const PROJECT_TASK_ERROR_HINTS: Readonly<Record<ProjectTaskErrorCode, string>> = {
  PROJECT_ROOT_UNAVAILABLE: '项目根目录不可访问',
  PROJECT_ROOT_IDENTITY_CHANGED: '项目根身份已变化',
  INPUT_ESCAPES_ROOT: '输入越出授权项目根',
  INPUT_SYMLINK_BLOCKED: '符号链接输入已阻断',
  INPUT_CHANGED_DURING_READ: '读取期间文件发生变化',
  INPUT_UNSUPPORTED: '当前格式尚不支持',
  INPUT_TOO_LARGE: '文件超过单文件限制',
  INPUT_ENCRYPTED: '文件需要先解密副本',
  CONVERTER_TIMEOUT: '转换器超时',
  CONVERTER_CRASHED: '转换器异常退出',
  OUTPUT_INVALID: '转换产物未通过严格校验',
  OUTPUT_TOO_LARGE: '转换产物超过限制',
  GENERATED_OUTPUT_MODIFIED: '生成产物已被手动修改',
  PRESET_QA_CONFLICT: '预设 QA 存在同问异答冲突',
  DB_COMMIT_FAILED: '知识版本提交失败',
  DISK_FULL: '本机可用空间不足',
  RENAME_AMBIGUOUS: '重命名对应关系不唯一',
}

export function projectTaskNeedsAttention(task: ProjectSyncTask): boolean {
  if (task.status === 'manual_ready' || task.status === 'removed') return false
  return task.requiresAction || task.status === 'failed' || task.status === 'blocked'
}

export function projectRunProgressLabel(
  status: 'running' | 'cancel_requested' | 'completed' | 'cancelled' | 'failed',
  completedItems: number,
  totalItems: number | null,
): string {
  const completed = Number.isSafeInteger(completedItems) && completedItems >= 0 ? completedItems : 0
  const totalKnown = Number.isSafeInteger(totalItems) && (totalItems ?? -1) >= 0
  if (status === 'cancelled') return `已取消，本次已完成 ${completed.toLocaleString('zh-CN')} 项`
  if (status === 'cancel_requested') return `正在取消，已完成 ${completed.toLocaleString('zh-CN')} 项`
  if (!totalKnown) return '正在安全处理，当前阶段未提供可验证总量。'
  return `已完成 ${completed.toLocaleString('zh-CN')} / ${(totalItems ?? 0).toLocaleString('zh-CN')}`
}

export function projectDirectoryPurpose(directory: string): string {
  const normalized = directory.normalize('NFC').replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
  switch (normalized) {
    case '原始资料': return '放置项目原始资料输入'
    case '预设QA': return '放置可严格校验的预设问答'
    case '转换资料库/资料': return '保存校验通过的标准资料产物'
    case '转换资料库/预设QA': return '保存校验通过的标准问答产物'
    case '.qaing': return '保存项目身份与安全清单'
    default: return '项目协议所需的固定目录'
  }
}

export function projectTimeLabel(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '尚未完成检查'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '检查时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}
