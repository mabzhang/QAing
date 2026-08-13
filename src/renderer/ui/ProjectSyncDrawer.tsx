import {
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  ChevronDown,
  ChevronUp,
  Cpu,
  Database,
  FileText,
  FolderCog,
  FolderOpen,
  FolderPlus,
  Hand,
  ListFilter,
  Loader2,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  Square,
  Table2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  ProjectConversionMode,
  ProjectSummary,
  ProjectSyncPolicy,
  ProjectTaskFilter,
} from '../../core/contracts'
import type { ProjectUiState, SimulatedQaSlot, UiActionName } from './contracts'
import { DrawerShell } from './DrawerShell'
import { SimulatedQaAssistant } from './SimulatedQaAssistant'
import {
  PROJECT_SYNC_STAGE_LABELS,
  PROJECT_SYNC_STAGE_ORDER,
  PROJECT_TASK_ERROR_HINTS,
  PROJECT_TASK_STATUS_LABELS,
  PROJECT_PROGRESS_ANNOUNCEMENT_INTERVAL_MS,
  projectAnnouncementDelay,
  projectDirectoryPurpose,
  projectSyncDisplay,
  projectSimpleStatusPresentation,
  projectStatusPresentation,
  projectTaskNeedsAttention,
  projectTimeLabel,
  safeProjectName,
  safeProjectPathLabel,
  semanticIndexPresentation,
} from './project-ui'

interface ProjectSyncDrawerProps {
  readonly state: ProjectUiState
  readonly pendingAction: UiActionName | null
  readonly actionError: string | null
  readonly sessionLocked: boolean
  readonly onClose: () => void
  readonly onSelectRoot: () => void
  readonly onActivate: (projectId: string) => void
  readonly onConfirmDirectories: (projectId: string) => void
  readonly onCancelPreparation: (projectId: string) => void
  readonly onStartSync: (projectId: string) => void
  readonly onCancelSync: (runId: string) => void
  readonly onRetryFailed: (projectId: string, runId: string | null) => void
  readonly onRelocate: (projectId: string) => void
  readonly onSetPolicy: (projectId: string, policy: ProjectSyncPolicy) => void
  readonly onSetFilter: (filter: ProjectTaskFilter) => void
  readonly onLoadMore: () => void
  readonly onExportDiagnostics: (projectId: string, runId: string | null) => void
  readonly simulatedQa?: SimulatedQaSlot
}

const POLICY_OPTIONS: readonly {
  readonly value: ProjectSyncPolicy
  readonly label: string
  readonly detail: string
}[] = [
  { value: 'manual', label: '仅手动', detail: '只在点击更新时检查和转换' },
  { value: 'auto_check_confirm', label: '自动检查', detail: '后台只检查；发现变化后等待你应用（默认）' },
  { value: 'auto_check_apply', label: '自动应用', detail: '安全变化自动应用；删除与 QA 冲突仍需确认' },
]

const FILTER_OPTIONS: readonly { readonly value: ProjectTaskFilter; readonly label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'action_required', label: '需操作' },
  { value: 'failed', label: '失败' },
]

const CONVERSION_MODE_LABELS: Readonly<Record<ProjectConversionMode, string>> = {
  local: '本地转换',
  manual: '手动产物',
  llm: 'LLM 转换',
  external: '外部 Agent',
}

function useThrottledAnnouncement(
  value: string,
  intervalMs = PROJECT_PROGRESS_ANNOUNCEMENT_INTERVAL_MS,
): string {
  const [announced, setAnnounced] = useState(value)
  const latestRef = useRef(value)
  const lastAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    latestRef.current = value
    const delay = projectAnnouncementDelay(lastAtRef.current, Date.now(), intervalMs)
    const publish = (): void => {
      timerRef.current = null
      lastAtRef.current = Date.now()
      setAnnounced(latestRef.current)
    }
    if (delay === 0 && timerRef.current === null) publish()
    else if (timerRef.current === null) timerRef.current = setTimeout(publish, delay)
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [intervalMs, value])

  return announced
}

function ProjectSelector({
  projects,
  activeProjectId,
  disabled,
  describedBy,
  onActivate,
  onSelectRoot,
}: {
  readonly projects: readonly ProjectSummary[]
  readonly activeProjectId: string | null
  readonly disabled: boolean
  readonly describedBy?: string
  readonly onActivate: (projectId: string) => void
  readonly onSelectRoot: () => void
}): React.JSX.Element {
  return (
    <div className="project-sync-selector-row">
      <label>
        <span>当前项目</span>
        <select
          value={activeProjectId ?? ''}
          aria-describedby={describedBy}
          disabled={disabled || projects.length === 0}
          onChange={(event) => { if (event.currentTarget.value) onActivate(event.currentTarget.value) }}
        >
          {projects.length === 0 ? <option value="">尚未选择项目</option> : null}
          {projects.map((project) => <option key={project.id} value={project.id}>{safeProjectName(project.displayName)}</option>)}
        </select>
      </label>
      <button type="button" aria-describedby={describedBy} onClick={onSelectRoot} disabled={disabled}>
        <FolderPlus aria-hidden="true" />
        选择文件夹
      </button>
    </div>
  )
}

function SyncStageTracker({ state }: { readonly state: ProjectUiState }): React.JSX.Element {
  const display = projectSyncDisplay(state)
  return (
    <section className={`project-sync-section project-sync-stage project-sync-stage--${display.phase}`} aria-labelledby="project-sync-stage-title">
      <div className="project-sync-section__heading">
        <div><span>Pipeline</span><h3 id="project-sync-stage-title">更新阶段</h3></div>
        <small>{display.label}</small>
      </div>
      <ol className="project-stage-list">
        {PROJECT_SYNC_STAGE_ORDER.map((stage) => {
          const complete = display.completedStages.includes(stage)
          const current = display.currentStage === stage
          const failed = display.failedStage === stage
          return (
            <li key={stage} className={`${complete ? 'is-complete' : ''}${current ? ' is-current' : ''}${failed ? ' is-failed' : ''}`} aria-current={current ? 'step' : undefined}>
              <span>{complete ? <Check aria-hidden="true" /> : current ? <Loader2 aria-hidden="true" className="spin" /> : failed ? <CircleAlert aria-hidden="true" /> : <CircleDot aria-hidden="true" />}</span>
              <strong>{PROJECT_SYNC_STAGE_LABELS[stage]}</strong>
            </li>
          )
        })}
      </ol>
      <div className="project-stage-progress">
        <span>{display.detail}</span>
        {display.progress !== null ? (
            <progress
              max={display.progress.max}
              value={display.progress.value}
            >
              {display.progress.value} / {display.progress.max}
            </progress>
        ) : null}
      </div>
    </section>
  )
}

function SyncSummary({ state }: { readonly state: ProjectUiState }): React.JSX.Element {
  const values = [
    ['新增', state.counts.added],
    ['变更', state.counts.changed],
    ['删除', state.counts.deleted],
    ['待 Agent', state.counts.awaitingAgent],
    ['失败', state.counts.failed],
  ] as const
  return (
    <section className="project-sync-summary" aria-label="项目变化摘要">
      {values.map(([label, value]) => (
        <div key={label} className={label === '失败' && value > 0 ? 'has-danger' : ''}>
          <strong>{value.toLocaleString('zh-CN')}</strong><span>{label}</span>
        </div>
      ))}
    </section>
  )
}

function ProjectTaskList({ state }: { readonly state: ProjectUiState }): React.JSX.Element {
  const tasks = state.taskPage?.items ?? []
  if (state.loading && state.taskPage === null) {
    return <div className="project-task-empty" role="status"><Loader2 aria-hidden="true" className="spin" /><strong>正在读取项目任务</strong></div>
  }
  if (state.errorCode === 'LOAD_FAILED' && state.taskPage === null) {
    return (
      <div className="project-task-empty project-task-empty--error" role="alert">
        <CircleAlert aria-hidden="true" />
        <strong>任务列表暂时无法读取</strong>
        <span>未把未知状态当作空列表；已发布知识保持不变。</span>
      </div>
    )
  }
  if (tasks.length === 0) {
    return (
      <div className="project-task-empty">
        <CheckCircle2 aria-hidden="true" />
        <strong>{state.taskFilter === 'all' ? '暂无文件任务' : '当前筛选没有任务'}</strong>
        <span>{state.taskFilter === 'all' ? '完成项目检查后，变化文件会显示在这里。' : '切换筛选条件查看其他任务。'}</span>
      </div>
    )
  }
  return (
    <div className="project-task-list" role="list">
      {tasks.map((task) => {
        const safeRelativePath = safeProjectPathLabel(task.relativePath)
        const ModeIcon = task.conversionMode === 'external'
          ? Bot
          : task.conversionMode === 'manual'
            ? Hand
            : task.conversionMode === 'local'
              ? Cpu
              : ShieldCheck
        const taskErrorHint = task.conversionMode === 'manual' && task.errorCode === 'OUTPUT_INVALID'
          ? '手动 Markdown 未通过严格格式校验，未替换上次成功版本'
          : task.errorCode === null ? null : PROJECT_TASK_ERROR_HINTS[task.errorCode]
        const taskReady = task.status === 'ready' || task.status === 'published' || task.status === 'manual_ready'
        return (
          <article key={task.id} className={`project-task-row${projectTaskNeedsAttention(task) ? ' needs-attention' : ''}`} role="listitem">
            <span className={`project-task-row__kind project-task-row__kind--${task.kind}`}>
              {task.kind === 'preset_qa' ? <Table2 aria-hidden="true" /> : <FileText aria-hidden="true" />}
            </span>
            <div className="project-task-row__body">
              <strong title={safeRelativePath}>{safeRelativePath}</strong>
              <span><ModeIcon aria-hidden="true" />{CONVERSION_MODE_LABELS[task.conversionMode]} · {PROJECT_TASK_STATUS_LABELS[task.status]}</span>
              {task.status === 'manual_ready' ? <small className="is-success">严格校验通过 · 关键词检索可用</small> : null}
              {taskErrorHint !== null ? <small>{taskErrorHint}</small> : null}
            </div>
            <div className="project-task-row__state">
              <span className={`project-task-state project-task-state--${task.status}`}>
                {taskReady ? <CheckCircle2 aria-hidden="true" /> : task.status === 'failed' || task.status === 'blocked' ? <CircleAlert aria-hidden="true" /> : <CircleDot aria-hidden="true" />}
                {PROJECT_TASK_STATUS_LABELS[task.status]}
              </span>
              {task.lastGoodAvailable ? <small>上次成功版本可用</small> : null}
            </div>
          </article>
        )
      })}
    </div>
  )
}

export function ProjectSyncDrawer({
  state,
  pendingAction,
  actionError,
  sessionLocked,
  onClose,
  onSelectRoot,
  onActivate,
  onConfirmDirectories,
  onCancelPreparation,
  onStartSync,
  onCancelSync,
  onRetryFailed,
  onRelocate,
  onSetPolicy,
  onSetFilter,
  onLoadMore,
  onExportDiagnostics,
  simulatedQa,
}: ProjectSyncDrawerProps): React.JSX.Element {
  const project = state.activeProject
  const directoryConfirmation = state.directoryConfirmation
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
  const busy = pendingAction !== null
  const syncDisplay = projectSyncDisplay(state)
  const announcement = useThrottledAnnouncement([
    status.label,
    syncDisplay.label,
    syncDisplay.detail,
  ].filter(Boolean).join('，'))
  const hasSimpleStatus = project !== null
    && typeof project.simpleStatus === 'object'
    && project.simpleStatus !== null
  const simpleActivityIsRunning = project?.simpleStatus.activity === 'checking'
    || project?.simpleStatus.activity === 'updating'
    || project?.simpleStatus.activity === 'cancelling'
  const legacyActivityIsRunning = state.run?.status === 'running'
    || state.run?.status === 'cancel_requested'
  const activityIsRunning = hasSimpleStatus ? simpleActivityIsRunning : legacyActivityIsRunning
  const waitingForApply = hasSimpleStatus
    ? project.simpleStatus.attention === 'review_changes'
    : syncDisplay.phase === 'waiting_apply'
  const partialFailure = hasSimpleStatus
    ? project.simpleStatus.attention === 'partial_failure'
    : state.counts.failed > 0 || state.run?.status === 'failed'
  const rootNeedsRelocation = state.errorCode === 'PROJECT_ROOT_UNAVAILABLE'
    || state.errorCode === 'PROJECT_ROOT_IDENTITY_CHANGED'
    || (hasSimpleStatus
      ? project.simpleStatus.attention === 'root_access' || project.simpleStatus.attention === 'root_identity'
      : project?.lampStatus === 'root_unavailable')
  const canStart = project !== null && !activityIsRunning
  const detailNeedsAttention = simpleActivityIsRunning
    || (project !== null && project.simpleStatus.attention !== 'none')
    || (!hasSimpleStatus && project !== null && (
      syncDisplay.phase === 'syncing'
      || syncDisplay.phase === 'waiting_apply'
      || syncDisplay.phase === 'failed'
      || state.counts.actionRequired > 0
    ))
    || state.errorCode !== null
  const [detailProjectId, setDetailProjectId] = useState<string | null>(null)
  const [policyProjectId, setPolicyProjectId] = useState<string | null>(null)
  const detailManuallyOpen = project !== null && detailProjectId === project.id
  const policyOpen = project !== null && policyProjectId === project.id
  const detailsOpen = detailNeedsAttention || detailManuallyOpen
  const policyLabel = project === null
    ? null
    : POLICY_OPTIONS.find((option) => option.value === project.syncPolicy)?.label ?? '未知'
  const exactSummary = project !== null
    && Number.isSafeInteger(project.knowledgeSummary.usableDocumentSources)
    && project.knowledgeSummary.usableDocumentSources >= 0
    && Number.isSafeInteger(project.knowledgeSummary.usablePresetQaItems)
    && project.knowledgeSummary.usablePresetQaItems >= 0
    ? project.knowledgeSummary
    : null

  return (
    <DrawerShell
      title="项目同步中心"
      description="核对固定输入区，仅将校验通过的转换产物应用到知识库。"
      icon={FolderCog}
      busy={busy}
      actionError={actionError}
      panelClassName="project-sync-panel"
      onClose={onClose}
    >
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>

      <section className="project-sync-overview" aria-label="项目与可用性" aria-busy={state.loading}>
        <ProjectSelector
          projects={state.projects}
          activeProjectId={state.activeProjectId}
          disabled={busy || sessionLocked}
          {...(sessionLocked ? { describedBy: 'project-session-lock-note' } : {})}
          onActivate={onActivate}
          onSelectRoot={onSelectRoot}
        />
        {sessionLocked ? <p id="project-session-lock-note" className="project-session-lock">会话进行中不能切换项目，也不启动可能发布新知识的更新；当前轮使用已绑定版本。</p> : null}
        <div className={`project-sync-health project-sync-health--${status.tone}`}>
          {initialLoading ? <Loader2 aria-hidden="true" className="spin" /> : status.tone === 'green' ? <CheckCircle2 aria-hidden="true" /> : status.tone === 'red' ? <CircleAlert aria-hidden="true" /> : <CircleDot aria-hidden="true" />}
          <div>
            <strong>资料可用性：{status.label}</strong>
            <span>{status.detail}</span>
            {project !== null ? <small>上次检查：{projectTimeLabel(project.lastCompletedScanAt)}</small> : null}
          </div>
          {showSemanticBadge ? <span className={`project-index-badge project-index-badge--${semantic.tone}`}><Database aria-hidden="true" />{semantic.label}</span> : null}
        </div>
        {project !== null ? (
          <div className="project-sync-essentials" aria-label="项目资料摘要">
            <div><span>资料</span><strong>{exactSummary === null ? '摘要暂不可用' : `${exactSummary.usableDocumentSources.toLocaleString('zh-CN')} 份可用`}</strong></div>
            <div><span>预设 QA</span><strong>{exactSummary === null ? '摘要暂不可用' : `${exactSummary.usablePresetQaItems.toLocaleString('zh-CN')} 条已审阅`}</strong></div>
            <div><span>同步方式</span><strong>{policyLabel}</strong><button type="button" aria-expanded={policyOpen} onClick={() => { setPolicyProjectId((value) => value === project.id ? null : project.id) }} disabled={busy || sessionLocked}>更改</button></div>
          </div>
        ) : null}
      </section>

      {directoryConfirmation !== null ? (
        <section className="project-directory-confirmation" aria-labelledby="project-directory-confirmation-title">
          <FolderPlus aria-hidden="true" />
          <div>
            <strong id="project-directory-confirmation-title">确认创建项目固定目录</strong>
            <span>QAing 不会把相似文件夹静默当作输入根。</span>
            <ul>{directoryConfirmation.directories.map((directory, index) => (
              <li key={`${index}-${directory}`}>
                <strong>{safeProjectPathLabel(directory)}</strong>
                <span>{projectDirectoryPurpose(directory)}</span>
              </li>
            ))}</ul>
            <div>
              <button type="button" aria-describedby={sessionLocked ? 'project-session-lock-note' : undefined} onClick={() => { onConfirmDirectories(directoryConfirmation.projectId) }} disabled={busy || sessionLocked}>
                <FolderPlus aria-hidden="true" />创建并继续
              </button>
              <button type="button" onClick={() => { onCancelPreparation(directoryConfirmation.projectId) }} disabled={busy}>取消</button>
            </div>
          </div>
        </section>
      ) : null}

      {project !== null && (policyOpen || pendingAction === 'set-project-sync-policy') ? (
        <section className="project-sync-policy" aria-labelledby="project-sync-policy-title">
          <div className="project-sync-section__heading">
            <div><span>Policy</span><h3 id="project-sync-policy-title">同步策略</h3></div>
            <small>项目级设置</small>
          </div>
          <div role="radiogroup" aria-label="项目同步策略" aria-busy={pendingAction === 'set-project-sync-policy'} className="project-policy-options">
            {POLICY_OPTIONS.map((option) => (
              <label key={option.value} className={project.syncPolicy === option.value ? 'is-selected' : undefined}>
                <input
                  type="radio"
                  name={`project-sync-policy-${project.id}`}
                  value={option.value}
                  checked={project.syncPolicy === option.value}
                  aria-describedby={sessionLocked ? 'project-session-lock-note' : undefined}
                  onChange={() => { onSetPolicy(project.id, option.value) }}
                  disabled={busy || sessionLocked}
                />
                <span>{project.syncPolicy === option.value ? <Check aria-hidden="true" /> : <CircleDot aria-hidden="true" />}</span>
                <span><strong>{option.label}</strong><small>{option.detail}</small></span>
              </label>
            ))}
          </div>
        </section>
      ) : null}

      {project !== null ? (
        <button type="button" className={`project-sync-detail-toggle${detailNeedsAttention ? ' needs-attention' : ''}`} aria-expanded={detailsOpen} onClick={() => { if (!detailNeedsAttention) setDetailProjectId((value) => value === project.id ? null : project.id) }}>
          <span>{detailNeedsAttention ? '有需要处理的更新详情' : '查看处理详情'}</span>
          {detailsOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
      ) : null}

      {detailsOpen ? <>
        <SyncStageTracker state={state} />
        {state.counts.added + state.counts.changed + state.counts.deleted + state.counts.awaitingAgent + state.counts.failed > 0 ? <SyncSummary state={state} /> : null}

        <section className="project-sync-section project-task-section" aria-labelledby="project-task-title" aria-busy={state.loading || state.loadingMore}>
        <div className="project-task-toolbar">
          <div><span>Files</span><h3 id="project-task-title">文件任务</h3></div>
          <div role="group" aria-label="筛选文件任务">
            <ListFilter aria-hidden="true" />
            {FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={state.taskFilter === option.value}
                className={state.taskFilter === option.value ? 'is-selected' : undefined}
                onClick={() => { onSetFilter(option.value) }}
                disabled={busy || state.loading}
              >{option.label}</button>
            ))}
          </div>
        </div>
        <ProjectTaskList state={state} />
        {state.taskPage?.nextCursor !== null && state.taskPage?.nextCursor !== undefined ? (
          <button type="button" className="project-task-load-more" onClick={onLoadMore} disabled={busy || state.loadingMore}>
            {state.loadingMore ? <Loader2 aria-hidden="true" className="spin" /> : <RotateCcw aria-hidden="true" />}
            {state.loadingMore ? '正在读取…' : '加载更多任务'}
          </button>
        ) : null}
        </section>
      </> : null}

      {project !== null && simulatedQa !== undefined ? (
        <SimulatedQaAssistant
          key={`${project.id}:${project.knowledgeVersion ?? 'unavailable'}`}
          projectId={project.id}
          projectName={safeProjectName(project.displayName)}
          knowledgeVersion={project.knowledgeVersion}
          slot={simulatedQa}
        />
      ) : null}

      <footer className="project-sync-actions">
        {project === null ? (
          <button type="button" className="is-primary" aria-describedby={sessionLocked ? 'project-session-lock-note' : undefined} onClick={onSelectRoot} disabled={busy || sessionLocked}><FolderOpen aria-hidden="true" />选择项目文件夹</button>
        ) : (
          <>
            {rootNeedsRelocation ? (
              <button type="button" className="is-primary" aria-describedby={sessionLocked ? 'project-session-lock-note' : undefined} onClick={() => { onRelocate(project.id) }} disabled={busy || sessionLocked}><FolderOpen aria-hidden="true" />重新定位目录</button>
            ) : canStart ? (
              <button type="button" className="is-primary" aria-describedby={sessionLocked ? 'project-session-lock-note' : undefined} onClick={() => { onStartSync(project.id) }} disabled={busy || sessionLocked}><RefreshCcw aria-hidden="true" />{waitingForApply ? '应用待处理变化' : '立即检查'}</button>
            ) : null}
            {activityIsRunning && (state.run?.status === 'running' || state.run?.status === 'cancel_requested') ? (
              <button type="button" className="is-danger" onClick={() => { if (state.run !== null) onCancelSync(state.run.id) }} disabled={busy || state.run.status === 'cancel_requested'}><Square aria-hidden="true" />{state.run.status === 'cancel_requested' ? '正在取消…' : '取消本次'}</button>
            ) : null}
            {partialFailure ? (
              <button type="button" aria-describedby={sessionLocked ? 'project-session-lock-note' : undefined} onClick={() => { onRetryFailed(project.id, state.run?.id ?? null) }} disabled={busy || sessionLocked}><RefreshCcw aria-hidden="true" />重试失败项</button>
            ) : null}
            {detailsOpen ? <button type="button" onClick={() => { onExportDiagnostics(project.id, state.run?.id ?? null) }} disabled={busy}><ShieldCheck aria-hidden="true" />导出诊断摘要</button> : null}
          </>
        )}
      </footer>
    </DrawerShell>
  )
}
