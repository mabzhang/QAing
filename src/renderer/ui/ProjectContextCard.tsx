import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Database,
  FolderKanban,
  FolderOpen,
  Loader2,
  RefreshCcw,
} from 'lucide-react'
import type { ProjectLampStatus, ProjectSummary, ProjectUiErrorCode } from '../../core/contracts'
import type { ProjectUiState, UiActionName } from './contracts'
import {
  projectSimpleStatusPresentation,
  projectStatusPresentation,
  projectTimeLabel,
  safeProjectName,
  semanticIndexPresentation,
  type ProjectStatusTone,
} from './project-ui'

interface ProjectContextCardProps {
  readonly state: ProjectUiState
  readonly pendingAction: UiActionName | null
  readonly sessionLocked: boolean
  readonly onOpen: () => void
  readonly onSelectRoot: () => void
  readonly onActivate: (projectId: string) => void
  readonly onStartSync: (projectId: string) => void
  readonly onRelocate: (projectId: string) => void
}

function ProjectLampIcon({
  tone,
  lampStatus,
  loading,
}: {
  readonly tone: ProjectStatusTone
  readonly lampStatus: ProjectLampStatus | null
  readonly loading: boolean
}): React.JSX.Element {
  if (loading) return <Loader2 aria-hidden="true" className="spin" />
  switch (tone) {
    case 'green': return <CheckCircle2 aria-hidden="true" />
    case 'yellow': return lampStatus === 'checking' || lampStatus === 'syncing'
      ? <Loader2 aria-hidden="true" className="spin" />
      : <CircleDot aria-hidden="true" />
    case 'red': return <CircleAlert aria-hidden="true" />
    case 'gray': return <CircleDot aria-hidden="true" />
  }
}

function primaryProjectAction(
  project: ProjectSummary | null,
  errorCode: ProjectUiErrorCode | null,
  confirmationPending: boolean,
): 'select' | 'relocate' | 'sync' | 'open' {
  if (confirmationPending || errorCode === 'LOAD_FAILED') return 'open'
  if (errorCode === 'PROJECT_ROOT_UNAVAILABLE' || errorCode === 'PROJECT_ROOT_IDENTITY_CHANGED') return 'relocate'
  if (project === null) return 'select'
  if (project.simpleStatus.attention === 'root_access' || project.simpleStatus.attention === 'root_identity') return 'relocate'
  return 'sync'
}

export function ProjectContextCard({
  state,
  pendingAction,
  sessionLocked,
  onOpen,
  onSelectRoot,
  onActivate,
  onStartSync,
  onRelocate,
}: ProjectContextCardProps): React.JSX.Element {
  const project = state.activeProject
  const initialLoading = state.loading && project === null && state.errorCode === null
  const status = project !== null && project.simpleStatus !== null
    ? projectSimpleStatusPresentation(project, state.errorCode, state.loading)
    : projectStatusPresentation(project, state.errorCode, state.loading)
  const semantic = initialLoading
    ? { tone: 'pending' as const, label: '语义索引状态读取中' }
    : semanticIndexPresentation(project?.semanticIndex.status ?? 'unavailable')
  const showSemanticBadge = initialLoading
    || project === null
    || project.simpleStatus.activity === 'optimizing'
    || project.semanticIndex.status === 'pending'
    || project.semanticIndex.status === 'degraded'
    || project.semanticIndex.status === 'failed'
  const action = primaryProjectAction(project, state.errorCode, state.directoryConfirmation !== null)
  const busy = pendingAction !== null
  const actionPending = pendingAction === 'select-project-root'
    || pendingAction === 'start-project-sync'
    || pendingAction === 'relocate-project'
  const canChangeProject = !sessionLocked && !busy
  const actionBlockedBySession = sessionLocked && action !== 'open'
  const updateInProgress = project?.simpleStatus.activity === 'checking'
    || project?.simpleStatus.activity === 'updating'
    || project?.simpleStatus.activity === 'cancelling'
  const waitingForApply = project?.simpleStatus.attention === 'review_changes'

  return (
    <section className="project-context-card" aria-labelledby="project-context-title" aria-busy={state.loading}>
      <header className="project-context-card__header">
        <span className="project-context-card__icon"><FolderKanban aria-hidden="true" /></span>
        <div>
          <small>Project knowledge</small>
          <strong id="project-context-title">项目资料库</strong>
        </div>
        <button
          type="button"
          className="icon-button icon-button--small"
          aria-label="打开项目同步中心"
          onClick={onOpen}
          disabled={busy}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </header>

      <label className="project-context-selector">
        <span>当前项目</span>
        <select
          value={state.activeProjectId ?? ''}
          aria-describedby={sessionLocked ? 'project-switch-lock-note' : undefined}
          disabled={!canChangeProject || state.projects.length === 0}
          onChange={(event) => {
            const projectId = event.currentTarget.value
            if (projectId) onActivate(projectId)
          }}
        >
          {state.projects.length === 0 ? <option value="">尚未选择项目</option> : null}
          {state.projects.map((item) => <option key={item.id} value={item.id}>{safeProjectName(item.displayName)}</option>)}
        </select>
      </label>

      <div className={`project-lamp project-lamp--${status.tone}`} role="status" aria-label={`项目可用性：${status.label}`}>
        <ProjectLampIcon tone={status.tone} lampStatus={project?.lampStatus ?? null} loading={initialLoading} />
        <div>
          <strong>{status.label}</strong>
          <span>{status.detail}</span>
          {project !== null ? (
            <small>上次检查：{projectTimeLabel(project.lastCompletedScanAt)}</small>
          ) : null}
        </div>
      </div>

      {showSemanticBadge ? <span className={`project-index-badge project-index-badge--${semantic.tone}`}>
        <Database aria-hidden="true" />
        {semantic.label}
        {project !== null && project.semanticIndex.pendingItems > 0
          ? <small>{project.semanticIndex.pendingItems.toLocaleString('zh-CN')} 待处理</small>
          : null}
      </span> : null}

      <button
        type="button"
        className="project-context-primary"
        aria-describedby={sessionLocked && action !== 'open' ? 'project-switch-lock-note' : undefined}
        disabled={busy || actionBlockedBySession || (action === 'sync' && (project === null || updateInProgress))}
        onClick={() => {
          if (action === 'select') onSelectRoot()
          else if (action === 'open') onOpen()
          else if (action === 'relocate' && project !== null) onRelocate(project.id)
          else if (project !== null) onStartSync(project.id)
        }}
      >
        {actionPending
          ? <Loader2 aria-hidden="true" className="spin" />
          : action === 'select'
            ? <FolderOpen aria-hidden="true" />
            : action === 'open'
              ? <ChevronRight aria-hidden="true" />
            : action === 'relocate'
              ? <FolderOpen aria-hidden="true" />
              : <RefreshCcw aria-hidden="true" />}
        {actionPending
          ? '正在处理…'
          : action === 'select'
            ? '选择项目文件夹'
            : action === 'open'
              ? state.directoryConfirmation !== null ? '确认项目目录' : '打开同步中心'
            : action === 'relocate'
              ? '重新定位目录'
              : updateInProgress
                ? project?.simpleStatus.activity === 'cancelling' ? '正在取消更新' : '更新正在进行'
                : waitingForApply ? '应用待处理变化' : '立即检查'}
      </button>

      {sessionLocked ? (
        <p id="project-switch-lock-note" className="project-context-lock">
          会话进行中不切换项目，也不启动可能发布新知识的更新；当前轮继续使用已绑定版本。
        </p>
      ) : null}
    </section>
  )
}
