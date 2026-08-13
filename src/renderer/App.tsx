import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Database,
  FileText,
  Headphones,
  Library,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  Mic,
  PanelRightOpen,
  Play,
  Radio,
  RefreshCcw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Volume2,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { questionText } from '../core/state-machine'
import type { AudioPermissionRequestResult } from '../core/contracts'
import type { AppMode, AppState, AudioSourceKind } from '../core/types'
import zenxWordmark from './assets/ZenX-wordmark-transparent.png'
import type {
  AppProps,
  CloudProviderKind,
  PermissionState,
  SettingsSection,
  UiActionName,
  UiActionResult,
  UiEnvironment,
  ProjectUiState,
  ProjectSyncPolicy,
  ProjectTaskFilter,
} from './ui/contracts'
import { AudioLevelWaveform } from './ui/AudioLevelWaveform'
import { ConversationWorkbench } from './ui/ConversationWorkbench'
import { KnowledgeDrawer } from './ui/KnowledgeDrawer'
import { workbenchSheetIsVisible, type ActiveDrawer } from './ui/overlay-policy'
import { ProjectContextCard } from './ui/ProjectContextCard'
import { ProjectSyncDrawer } from './ui/ProjectSyncDrawer'
import { SettingsDrawer } from './ui/SettingsDrawer'
import { WorkbenchResizeHandle } from './ui/WorkbenchResizeHandle'
import {
  WORKBENCH_COLLAPSED_WIDTH,
  WORKBENCH_DEFAULT_WIDTH,
  WORKBENCH_STORAGE_KEY,
  clampWorkbenchPreference,
  effectiveWorkbenchMaxWidth,
  effectiveWorkbenchWidth,
  workbenchLayoutMode,
} from './ui/workbench-resize'
import {
  AUDIO_SOURCE_LABELS,
  PERMISSION_LABELS,
  actionFailureMessage,
  areSessionControlsLocked,
  hasActiveSession,
  phasePresentation,
  primaryActionPresentation,
  requiredCloudProvidersConfigured,
  selectedPermission,
  type PhasePresentation,
} from './ui/view-model'
import './ui/styles.css'

interface ActionHandlers {
  readonly onSwitchMode: (mode: AppMode) => void
  readonly onSelectAudioSource: (source: AudioSourceKind) => void
  readonly onStart: () => void
  readonly onStopSession: () => void
  readonly onStopFront: () => void
  readonly onAcknowledgeFrontComplete: () => void
  readonly onEndQuestion: () => void
  readonly onEndAnswer: () => void
  readonly onSkipQuestion: () => void
  readonly onRetry: () => void
  readonly onDismissError: () => void
  readonly onOpenSettings: (section: SettingsSection) => void
  readonly onOpenKnowledgeBase: () => void
  readonly onCopyAnswer: (answer: string) => void
  readonly onConfigureProvider: (provider: CloudProviderKind, credential: string) => void
  readonly onClearProvider: (provider: CloudProviderKind) => void
  readonly onOpenPermission: (source: AudioSourceKind) => void
  readonly onRequestAudioPermission: (source: AudioSourceKind) => void
  readonly onRestartApplication: () => void
  readonly onImportSourceDocuments: () => void
  readonly onImportPresetQa: () => void
  readonly onDeleteDocument: (documentId: string) => void
  readonly onSetAlwaysOnTop: (enabled: boolean) => void
  readonly onOpenProjectCenter: () => void
  readonly onSelectProjectRoot: () => void
  readonly onActivateProject: (projectId: string) => void
  readonly onConfirmProjectDirectories: (projectId: string) => void
  readonly onCancelProjectPreparation: (projectId: string) => void
  readonly onStartProjectSync: (projectId: string) => void
  readonly onCancelProjectSync: (runId: string) => void
  readonly onRetryProjectSync: (projectId: string, runId: string | null) => void
  readonly onRelocateProject: (projectId: string) => void
  readonly onSetProjectSyncPolicy: (projectId: string, policy: ProjectSyncPolicy) => void
  readonly onSetProjectTaskFilter: (filter: ProjectTaskFilter) => void
  readonly onLoadMoreProjectTasks: () => void
  readonly onExportProjectDiagnostics: (projectId: string, runId: string | null) => void
  readonly onDeleteQaWorkspaceRound: (projectId: string, roundId: string) => Promise<void>
  readonly onClearQaWorkspaceProject: (projectId: string) => Promise<void>
  readonly onExportQaWorkspaceProject: (projectId: string) => Promise<void>
}

interface DashboardProps extends ActionHandlers {
  readonly state: AppState
  readonly environment: UiEnvironment
  readonly pendingAction: UiActionName | null
  readonly localError: string | null
  readonly audioLevels: NonNullable<AppProps['audioLevels']>
  readonly qaWorkspace: AppProps['qaWorkspace']
  readonly onLoadMoreQaWorkspace: AppProps['onLoadMoreQaWorkspace']
  readonly onRetryQaWorkspace: AppProps['onRetryQaWorkspace']
  readonly project: ProjectUiState
  readonly externalDrawerOpen: boolean
}

const MODE_OPTIONS: readonly {
  mode: AppMode
  label: string
  description: string
  icon: LucideIcon
}[] = [
  {
    mode: 'qa',
    label: 'QA 模式',
    description: '边听边预判，手动锁定最终答案',
    icon: MessageSquareText,
  },
  {
    mode: 'front',
    label: '前置模式',
    description: '完整记录演讲，结束后结构化入库',
    icon: FileText,
  },
]

const AUDIO_OPTIONS: readonly {
  source: AudioSourceKind
  label: string
  description: string
  icon: LucideIcon
}[] = [
  {
    source: 'system',
    label: '系统音频',
    description: '会议、播放器或线上路演',
    icon: Volume2,
  },
  {
    source: 'microphone',
    label: '麦克风',
    description: '现场提问、演讲或面对面交流',
    icon: Mic,
  },
]

const ACTION_PENDING_LABELS: Readonly<Partial<Record<UiActionName, string>>> = {
  start: '正在连接…',
  'stop-session': '正在停止…',
  'stop-front': '正在保存…',
  'acknowledge-front-complete': '正在返回…',
  'end-question': '正在锁定…',
  'end-answer': '正在保存…',
  'skip-question': '正在跳过…',
  retry: '正在重试…',
  'configure-provider': '正在安全保存…',
  'clear-provider': '正在清除…',
  'open-permission': '正在打开系统设置…',
  'request-permission': '正在申请权限…',
  'restart-application': '正在完全退出并重开…',
  'import-source-documents': '正在导入资料…',
  'import-preset-qa': '正在导入 QA…',
  'delete-document': '正在删除…',
  'set-always-on-top': '正在更新窗口…',
  'select-project-root': '正在选择项目…',
  'activate-project': '正在切换项目…',
  'confirm-project-directories': '正在创建固定目录…',
  'cancel-project-preparation': '正在取消准备…',
  'start-project-sync': '正在启动更新…',
  'cancel-project-sync': '正在取消更新…',
  'retry-project-sync': '正在重试失败项…',
  'relocate-project': '正在重新定位…',
  'set-project-sync-policy': '正在更新同步策略…',
  'set-project-task-filter': '正在筛选任务…',
  'load-more-project-tasks': '正在读取更多任务…',
  'export-project-diagnostics': '正在导出安全诊断摘要…',
  'delete-qa-workspace-round': '正在删除本轮…',
  'clear-qa-workspace-project': '正在清空当前项目工作台…',
  'export-qa-workspace-project': '正在导出当前项目工作台…',
}

const EMPTY_PROJECT_UI_STATE: ProjectUiState = {
  projects: [],
  activeProjectId: null,
  activeProject: null,
  run: null,
  counts: {
    added: 0,
    changed: 0,
    deleted: 0,
    awaitingAgent: 0,
    failed: 0,
    actionRequired: 0,
    completed: 0,
    total: null,
  },
  taskPage: null,
  taskFilter: 'all',
  directoryConfirmation: null,
  loading: false,
  loadingMore: false,
  errorCode: null,
}

function countLabel(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(
    Math.max(0, value),
  )
}

function initialViewportWidth(): number {
  if (typeof window === 'undefined') return 1_180
  return Math.max(0, window.innerWidth)
}

function initialWorkbenchWidth(): number {
  if (typeof window === 'undefined') return WORKBENCH_DEFAULT_WIDTH
  try {
    const stored = Number(window.localStorage.getItem(WORKBENCH_STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0
      ? clampWorkbenchPreference(stored)
      : WORKBENCH_DEFAULT_WIDTH
  } catch {
    return WORKBENCH_DEFAULT_WIDTH
  }
}

function persistWorkbenchWidth(width: number): void {
  try {
    window.localStorage.setItem(WORKBENCH_STORAGE_KEY, String(clampWorkbenchPreference(width)))
  } catch {
    // A blocked or full local store must never break the live session UI.
  }
}

function StatusIcon({ tone, busy }: Pick<PhasePresentation, 'tone' | 'busy'>): React.JSX.Element {
  if (busy) return <Loader2 aria-hidden="true" className="spin" />
  switch (tone) {
    case 'active':
      return <Radio aria-hidden="true" />
    case 'success':
      return <CheckCircle2 aria-hidden="true" />
    case 'warning':
    case 'danger':
      return <CircleAlert aria-hidden="true" />
    case 'neutral':
      return <CircleDot aria-hidden="true" />
  }
}

function RetrievalBadge({ environment }: { readonly environment: UiEnvironment }): React.JSX.Element {
  if (environment.retrievalMode === 'keyword_fallback') {
    return (
      <span className="retrieval-badge retrieval-badge--fallback">
        <WifiOff aria-hidden="true" />
        关键词检索降级
      </span>
    )
  }
  if (environment.retrievalHealth === 'searching') {
    return (
      <span className="retrieval-badge retrieval-badge--searching">
        <Loader2 aria-hidden="true" className="spin" />
        正在检索
      </span>
    )
  }
  if (environment.retrievalHealth === 'unavailable') {
    return (
      <span className="retrieval-badge retrieval-badge--unavailable">
        <CircleAlert aria-hidden="true" />
        检索不可用
      </span>
    )
  }
  return (
    <span className="retrieval-badge retrieval-badge--hybrid">
      <Sparkles aria-hidden="true" />
      混合语义检索
    </span>
  )
}

function PermissionMark({ permission }: { readonly permission: PermissionState }): React.JSX.Element {
  const icon = permission === 'granted'
    ? <CheckCircle2 aria-hidden="true" />
    : permission === 'checking'
      ? <Loader2 aria-hidden="true" className="spin" />
      : <CircleAlert aria-hidden="true" />
  return (
    <span className={`permission-mark permission-mark--${permission}`}>
      {icon}
      {PERMISSION_LABELS[permission]}
    </span>
  )
}

function Header({
  state,
  environment,
  pendingAction,
  onOpenKnowledgeBase,
  onOpenSettings,
  onOpenWorkbench,
  workspaceRoundCount,
}: Pick<DashboardProps, 'state' | 'environment' | 'pendingAction' | 'onOpenKnowledgeBase' | 'onOpenSettings'> & {
  readonly onOpenWorkbench: () => void
  readonly workspaceRoundCount: number
}): React.JSX.Element {
  return (
    <header className="app-header">
      <div className="brand-block">
        <img className="brand-wordmark" src={zenxWordmark} alt="" aria-hidden="true" />
        <div>
          <strong>QAing</strong>
          <span>知定堂即时 Q&amp;A 台</span>
        </div>
      </div>

      <div className="header-session" aria-live="polite">
        <span className={`header-session__dot header-session__dot--${state.mode}`} />
        <span>{state.mode === 'qa' ? '实时问答' : '前置记录'}</span>
        {state.sessionId !== null ? <small>会话进行中</small> : <small>本机待机</small>}
      </div>

      <div className="header-actions">
        <RetrievalBadge environment={environment} />
        {state.mode === 'qa' ? (
          <button
            type="button"
            className="icon-button icon-button--labeled workbench-sheet-trigger"
            onClick={onOpenWorkbench}
            aria-label={`打开会话工作台，已加载 ${workspaceRoundCount} 轮`}
          >
            <PanelRightOpen aria-hidden="true" />
            <span>工作台</span>
            {workspaceRoundCount > 0 ? <small>{workspaceRoundCount}</small> : null}
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button icon-button--labeled"
          onClick={onOpenKnowledgeBase}
          disabled={pendingAction !== null}
        >
          <Library aria-hidden="true" />
          <span>资料库</span>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="打开设置"
          title="设置"
          onClick={() => { onOpenSettings('general') }}
          disabled={pendingAction !== null}
        >
          <Settings aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}

function NoticeStack({
  state,
  environment,
  localError,
  pendingAction,
  onRetry,
  onDismissError,
  onOpenSettings,
}: Pick<
  DashboardProps,
  | 'state'
  | 'environment'
  | 'localError'
  | 'pendingAction'
  | 'onRetry'
  | 'onDismissError'
  | 'onOpenSettings'
>): React.JSX.Element | null {
  const currentPermission = selectedPermission(state, environment)
  const errorMessage = state.error ?? localError
  const hasKeywordFallback = environment.retrievalMode === 'keyword_fallback'
  const hasCaptureWarning = environment.captureHealth === 'silent' || environment.captureHealth === 'paused'
  const hasPermissionWarning = currentPermission === 'prompt'
    || currentPermission === 'denied'
    || currentPermission === 'unavailable'
  const hasProviderWarning = !requiredCloudProvidersConfigured(environment)
  if (
    errorMessage === null &&
    !hasKeywordFallback &&
    !hasCaptureWarning &&
    !hasPermissionWarning &&
    !hasProviderWarning
  ) return null

  return (
    <div className="notice-stack" aria-label="系统提示">
      {errorMessage !== null ? (
        <div className="system-notice system-notice--danger" role="alert">
          <CircleAlert aria-hidden="true" />
          <div>
            <strong>本次操作需要处理</strong>
            <span>{errorMessage}</span>
          </div>
          {state.error === null ? (
            <button
              type="button"
              className="notice-dismiss"
              aria-label="关闭错误提示"
              onClick={onDismissError}
              disabled={pendingAction !== null}
            >
              <X aria-hidden="true" />
            </button>
          ) : state.errorOperation !== 'final' ? (
            <FailedSessionExit
              mode={state.mode}
              pending={pendingAction !== null}
              onExit={onDismissError}
            />
          ) : null}
        </div>
      ) : null}

      {hasProviderWarning ? (
        <div className="system-notice system-notice--warning" role="status">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>云端服务尚未完成配置</strong>
            <span>开始前需安全配置 DeepSeek 与豆包 ASR；密钥不会在界面回显。</span>
          </div>
          <button type="button" onClick={() => { onOpenSettings('general') }} disabled={pendingAction !== null}>
            前往配置
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {hasPermissionWarning ? (
        <div className="system-notice system-notice--warning" role="status">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>{AUDIO_SOURCE_LABELS[state.audioSource]}{currentPermission === 'prompt' ? '等待授权' : '权限不可用'}</strong>
            <span>{currentPermission === 'prompt'
              ? '请先在权限向导中发起一次受控申请。'
              : '请在 macOS 系统设置中允许 QAing 访问，再返回应用。'}</span>
          </div>
          <button type="button" onClick={() => { onOpenSettings('permissions') }} disabled={pendingAction !== null}>
            {currentPermission === 'prompt' ? '完成权限向导' : '打开权限设置'}
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {environment.captureHealth === 'silent' ? (
        <div className="system-notice system-notice--warning" role="status">
          <Headphones aria-hidden="true" />
          <div>
            <strong>持续未检测到声音</strong>
            <span>转写会保持当前内容，请检查音源、输出设备或访问权限。</span>
          </div>
          <button type="button" onClick={() => { onOpenSettings('audio') }} disabled={pendingAction !== null}>
            检查音频设置
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {environment.captureHealth === 'paused' ? (
        <div className="system-notice system-notice--danger" role="status">
          <WifiOff aria-hidden="true" />
          <div>
            <strong>转写已暂停</strong>
            <span>已确认转写不会丢失。检查网络后可恢复转写。</span>
          </div>
          <button type="button" onClick={onRetry} disabled={pendingAction !== null}>
            <RefreshCcw aria-hidden="true" />
            恢复转写
          </button>
        </div>
      ) : null}

      {hasKeywordFallback ? (
        <div className="system-notice system-notice--info" role="status">
          <Search aria-hidden="true" />
          <div>
            <strong>当前为关键词检索降级</strong>
            <span>语义模型暂不可用，结果可能不完整。答案仍只能基于已命中资料。</span>
          </div>
          <button type="button" onClick={() => { onOpenSettings('retrieval') }} disabled={pendingAction !== null}>
            查看检索状态
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

function FailedSessionExit({
  mode,
  pending,
  onExit,
}: {
  readonly mode: AppMode
  readonly pending: boolean
  readonly onExit: () => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  if (confirming) {
    return (
      <div className="system-notice__actions system-notice__actions--confirm" role="group" aria-label="确认结束失败会话">
        <button type="button" className="notice-abandon" onClick={onExit} disabled={pending}>
          确认结束
        </button>
        <button type="button" onClick={() => { setConfirming(false) }} disabled={pending}>保留现场</button>
      </div>
    )
  }
  return (
    <button
      type="button"
      className="notice-abandon"
      onClick={() => { setConfirming(true) }}
      disabled={pending}
    >
      {mode === 'qa' ? '结束会话' : '返回待机'}
    </button>
  )
}

function ControlSidebar({
  state,
  environment,
  project,
  pendingAction,
  onSwitchMode,
  onSelectAudioSource,
  onOpenKnowledgeBase,
  onOpenSettings,
  onOpenProjectCenter,
  onSelectProjectRoot,
  onActivateProject,
  onStartProjectSync,
  onRelocateProject,
}: Pick<
  DashboardProps,
  | 'state'
  | 'environment'
  | 'project'
  | 'pendingAction'
  | 'onSwitchMode'
  | 'onSelectAudioSource'
  | 'onOpenKnowledgeBase'
  | 'onOpenSettings'
  | 'onOpenProjectCenter'
  | 'onSelectProjectRoot'
  | 'onActivateProject'
  | 'onStartProjectSync'
  | 'onRelocateProject'
>): React.JSX.Element {
  const controlsLocked = areSessionControlsLocked(state)
  const interactionLocked = controlsLocked || pendingAction !== null
  const projectManaged = project.activeProjectId !== null
  const activeProject = project.activeProject

  return (
    <aside className="control-sidebar" aria-label="会话控制">
      <section className="control-section">
        <div className="section-heading">
          <div>
            <span>工作模式</span>
            <strong>选择当前任务</strong>
          </div>
          {controlsLocked ? <LockKeyhole aria-label="会话中已锁定" /> : null}
        </div>
        <div className="mode-options" role="group" aria-label="工作模式">
          {MODE_OPTIONS.map((option) => {
            const Icon = option.icon
            const selected = state.mode === option.mode
            return (
              <button
                type="button"
                key={option.mode}
                className={`choice-card choice-card--mode${selected ? ' is-selected' : ''}`}
                aria-pressed={selected}
                onClick={() => { onSwitchMode(option.mode) }}
                disabled={interactionLocked}
              >
                <span className="choice-card__icon"><Icon aria-hidden="true" /></span>
                <span className="choice-card__copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <span className="choice-card__radio" aria-hidden="true" />
              </button>
            )
          })}
        </div>
      </section>

      <section className="control-section">
        <div className="section-heading">
          <div>
            <span>活动音源</span>
            <strong>每个会话只使用一个</strong>
          </div>
          {controlsLocked ? <LockKeyhole aria-label="会话中已锁定" /> : null}
        </div>
        <div className="audio-options" role="group" aria-label="音源选择">
          {AUDIO_OPTIONS.map((option) => {
            const Icon = option.icon
            const selected = state.audioSource === option.source
            const permission = environment.permissions[option.source]
            return (
              <button
                type="button"
                key={option.source}
                className={`choice-card choice-card--audio${selected ? ' is-selected' : ''}`}
                aria-pressed={selected}
                onClick={() => { onSelectAudioSource(option.source) }}
                disabled={interactionLocked}
              >
                <span className="choice-card__icon"><Icon aria-hidden="true" /></span>
                <span className="choice-card__copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                  <PermissionMark permission={permission} />
                </span>
                <span className="choice-card__radio" aria-hidden="true" />
              </button>
            )
          })}
        </div>
        {controlsLocked ? (
          <p className="control-lock-note">
            <LockKeyhole aria-hidden="true" />
            会话进行中不会静默切换模式或音源。
          </p>
        ) : null}
      </section>

      <ProjectContextCard
        state={project}
        pendingAction={pendingAction}
        sessionLocked={controlsLocked}
        onOpen={onOpenProjectCenter}
        onSelectRoot={onSelectProjectRoot}
        onActivate={onActivateProject}
        onStartSync={onStartProjectSync}
        onRelocate={onRelocateProject}
      />

      <section className="library-summary">
        <div className="library-summary__header">
          <span className="choice-card__icon"><Database aria-hidden="true" /></span>
          <div>
            <small>{projectManaged ? '当前项目转换资料库' : '本地双层资料库'}</small>
            <strong>{projectManaged ? '只读项目检索基座' : '检索基座'}</strong>
          </div>
          <button
            type="button"
            className="icon-button icon-button--small"
            aria-label={projectManaged ? '查看当前项目转换资料库' : '打开资料库'}
            onClick={onOpenKnowledgeBase}
            disabled={pendingAction !== null}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <div className="library-metrics">
          {projectManaged ? (
            <>
              <div><strong>{activeProject === null || activeProject.knowledgeVersion === null ? '—' : `K${activeProject.knowledgeVersion}`}</strong><span>知识版本</span></div>
              <div><strong>{activeProject === null ? '—' : countLabel(activeProject.semanticIndex.readyItems)}</strong><span>语义已就绪</span></div>
              <div><strong>{activeProject === null ? '—' : countLabel(activeProject.semanticIndex.pendingItems + activeProject.semanticIndex.failedItems)}</strong><span>待处理</span></div>
            </>
          ) : (
            <>
              <div><strong>{countLabel(environment.knowledgeBase.presetQaCount)}</strong><span>预设 QA</span></div>
              <div><strong>{countLabel(environment.knowledgeBase.sourceDocumentCount)}</strong><span>原始资料</span></div>
              <div><strong>{countLabel(environment.knowledgeBase.pendingIndexJobs)}</strong><span>待索引</span></div>
            </>
          )}
        </div>
        {projectManaged ? <p className="library-summary__managed-note">资料变更只通过项目同步中心</p> : null}
        <button
          type="button"
          className="text-button"
          onClick={() => { if (projectManaged) onOpenProjectCenter(); else onOpenSettings('retrieval') }}
          disabled={pendingAction !== null}
        >
          {projectManaged ? <RefreshCcw aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
          {projectManaged ? '打开项目同步中心' : '检索与索引设置'}
        </button>
      </section>
    </aside>
  )
}

function SessionHero({
  presentation,
  state,
  environment,
  audioLevels,
}: Pick<DashboardProps, 'state' | 'environment' | 'audioLevels'> & {
  readonly presentation: PhasePresentation
}): React.JSX.Element {
  const captureActive = state.mode === 'qa' ? state.qaPhase === 'listening' : state.frontPhase === 'recording'
  return (
    <section className={`session-hero session-hero--${presentation.tone}`} aria-labelledby="session-status-title">
      <div className="session-hero__status">
        <span className="status-orbit" aria-hidden="true">
          <StatusIcon tone={presentation.tone} busy={presentation.busy} />
        </span>
        <div>
          <span>{presentation.eyebrow}</span>
          <h1 id="session-status-title">{presentation.label}</h1>
          <p>{presentation.detail}</p>
        </div>
      </div>
      <div className="session-hero__aside">
        {captureActive ? (
          <AudioLevelWaveform
            levels={audioLevels}
            source={state.audioSource}
            captureHealth={environment.captureHealth}
            compact
          />
        ) : null}
        <dl className="session-meta" aria-label="当前会话信息">
          <div>
            <dt>音源</dt>
            <dd>{AUDIO_SOURCE_LABELS[state.audioSource]}</dd>
          </div>
          <div>
            <dt>转写版本</dt>
            <dd>R{state.revision}</dd>
          </div>
          <div>
            <dt>生成代次</dt>
            <dd>G{state.generationId}</dd>
          </div>
        </dl>
      </div>
    </section>
  )
}

function TranscriptPanel({
  state,
  environment,
}: Pick<DashboardProps, 'state' | 'environment'>): React.JSX.Element {
  const transcript = questionText(state)
  const isCaptureActive = state.mode === 'qa' ? state.qaPhase === 'listening' : state.frontPhase === 'recording'
  const isLive = isCaptureActive && (environment.captureHealth === 'healthy' || environment.captureHealth === 'silent')
  const isIdle = state.mode === 'qa' ? state.qaPhase === 'idle' : state.frontPhase === 'idle'
  const captureBadge = environment.captureHealth === 'starting'
    ? '连接中'
    : environment.captureHealth === 'reconnecting'
      ? '恢复中'
      : environment.captureHealth === 'paused'
        ? '已暂停'
        : null
  const title = state.mode === 'qa' ? '实时提问' : '实时记录'
  const emptyTitle = isIdle
    ? state.mode === 'qa' ? '尚未开始监听' : '尚未开始记录'
    : state.mode === 'qa' ? '正在等待问题' : '正在等待演讲内容'
  const emptyDescription = isIdle
    ? '选择单一音源并检查权限后，点击下方开始按钮。'
    : state.mode === 'qa'
      ? '提问内容会持续转写，由你点击「提问结束」后锁定。'
      : '已确认文字会持续保存，原始音频不会长期留存。'

  return (
    <section className="workspace-panel transcript-panel" aria-labelledby="transcript-title">
      <header className="panel-header">
        <div>
          <span className="panel-icon"><Radio aria-hidden="true" /></span>
          <div>
            <h2 id="transcript-title">{title}</h2>
            <p>{isLive ? '已确认文字 + 实时修订' : isIdle ? '等待创建本地会话' : '本轮锁定文本'}</p>
          </div>
        </div>
        {isLive ? (
          <span className="live-indicator"><span aria-hidden="true" /> LIVE</span>
        ) : captureBadge !== null ? (
          <span className={`capture-indicator capture-indicator--${environment.captureHealth}`} role="status">
            {environment.captureHealth === 'paused' ? <CircleAlert aria-hidden="true" /> : <Loader2 aria-hidden="true" className="spin" />}
            {captureBadge}
          </span>
        ) : transcript ? (
          <span className="locked-indicator"><LockKeyhole aria-hidden="true" /> 已锁定</span>
        ) : (
          <span className="locked-indicator"><CircleDot aria-hidden="true" /> 待机</span>
        )}
      </header>
      <div className="transcript-content" aria-live="polite" aria-atomic="false">
        {transcript ? (
          <p>
            {state.finalSegments.join('')}
            {state.partialSegment ? <span className="partial-transcript">{state.partialSegment}</span> : null}
            {isLive ? <span className="text-caret" aria-hidden="true" /> : null}
          </p>
        ) : (
          <div className="empty-state empty-state--transcript">
            <span className="empty-state__icon"><Headphones aria-hidden="true" /></span>
            <strong>{emptyTitle}</strong>
            <span>{emptyDescription}</span>
          </div>
        )}
      </div>
      <footer className="panel-footer">
        <span>
          <ShieldCheck aria-hidden="true" />
          {state.mode === 'qa' ? '锁定后不再接收旧的转写更新' : '原始转写优先保存，入库可重试'}
        </span>
        <span>{transcript.length.toLocaleString('zh-CN')} 字</span>
      </footer>
    </section>
  )
}

const FRONT_STEPS: readonly {
  key: AppState['frontPhase']
  label: string
  description: string
}[] = [
  { key: 'recording', label: '保存原始转写', description: '持续检查点保存' },
  { key: 'structuring', label: '结构化 Markdown', description: '标题、要点与数据' },
  { key: 'indexing', label: '建立检索索引', description: '分块、去重与向量化' },
  { key: 'complete', label: '入库可检索', description: '成为原始资料新成员' },
]

function FrontProgressPanel({
  state,
  pendingAction,
  onOpenKnowledgeBase,
}: Pick<DashboardProps, 'state' | 'pendingAction' | 'onOpenKnowledgeBase'>): React.JSX.Element {
  const currentIndex = FRONT_STEPS.findIndex((step) => step.key === state.frontPhase)
  const isComplete = state.frontPhase === 'complete'

  return (
    <section className="workspace-panel front-progress-panel" aria-labelledby="front-progress-title">
      <header className="panel-header">
        <div>
          <span className="panel-icon panel-icon--front"><FileText aria-hidden="true" /></span>
          <div>
            <h2 id="front-progress-title">记录入库进度</h2>
            <p>原始转写优先保存，后续阶段可独立重试</p>
          </div>
        </div>
        {isComplete ? <span className="success-badge"><CheckCircle2 aria-hidden="true" />已完成</span> : null}
      </header>
      <ol className="front-steps">
        {FRONT_STEPS.map((step, index) => {
          const completed = isComplete || (currentIndex >= 0 && index < currentIndex)
          const active = !isComplete && index === currentIndex
          return (
            <li
              key={step.key}
              className={`${completed ? 'is-complete' : ''}${active ? ' is-active' : ''}`}
              aria-current={active ? 'step' : undefined}
            >
              <span className="front-step__marker">
                {completed ? <CheckCircle2 aria-hidden="true" /> : active ? <Loader2 aria-hidden="true" className={step.key === 'recording' ? '' : 'spin'} /> : <span>{index + 1}</span>}
              </span>
              <div>
                <strong>{step.label}</strong>
                <small>{step.description}</small>
              </div>
            </li>
          )
        })}
      </ol>
      {state.frontPhase === 'idle' ? (
        <div className="front-guide">
          <Sparkles aria-hidden="true" />
          <div>
            <strong>结束记录后自动处理</strong>
            <span>你只需明确点击「结束记录并入库」，系统会保留原文后继续。</span>
          </div>
        </div>
      ) : null}
      {state.frontPhase === 'error' ? (
        <div className="front-guide front-guide--error">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>原始转写已安全保留</strong>
            <span>结构化或索引任务失败不会丢失本次记录，可从失败阶段重试。</span>
          </div>
        </div>
      ) : null}
      {isComplete ? (
        <div className="front-complete-card">
          <span className="front-complete-card__icon"><Database aria-hidden="true" /></span>
          <div>
            <strong>新资料已可用</strong>
            <span>后续 QA 模式会把本次内容作为原始资料来源参与检索。</span>
          </div>
          <button type="button" onClick={onOpenKnowledgeBase} disabled={pendingAction !== null}>
            查看资料库
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  )
}

function PrimaryActionDock({
  state,
  environment,
  pendingAction,
  onStart,
  onStopSession,
  onStopFront,
  onAcknowledgeFrontComplete,
  onEndQuestion,
  onEndAnswer,
  onSkipQuestion,
  onRetry,
  onOpenKnowledgeBase,
  onOpenSettings,
}: Pick<
  DashboardProps,
  | 'state'
  | 'environment'
  | 'pendingAction'
  | 'onStart'
  | 'onStopSession'
  | 'onStopFront'
  | 'onAcknowledgeFrontComplete'
  | 'onEndQuestion'
  | 'onEndAnswer'
  | 'onSkipQuestion'
  | 'onRetry'
  | 'onOpenKnowledgeBase'
  | 'onOpenSettings'
>): React.JSX.Element {
  const presentation = primaryActionPresentation(state, environment)
  const permission = selectedPermission(state, environment)
  const pendingLabel = pendingAction === null ? undefined : ACTION_PENDING_LABELS[pendingAction]
  const disabled = presentation.disabled || pendingAction !== null
  const captureActive = state.mode === 'qa' ? state.qaPhase === 'listening' : state.frontPhase === 'recording'
  const stopDisabled = pendingAction === 'stop-session'

  let icon: React.JSX.Element
  let onClick: () => void
  switch (presentation.action) {
    case 'start':
      icon = <Play aria-hidden="true" />
      onClick = onStart
      break
    case 'stop-front':
      icon = <Square aria-hidden="true" />
      onClick = onStopFront
      break
    case 'acknowledge-front-complete':
      icon = <CheckCircle2 aria-hidden="true" />
      onClick = onAcknowledgeFrontComplete
      break
    case 'end-question':
      icon = <LockKeyhole aria-hidden="true" />
      onClick = onEndQuestion
      break
    case 'end-answer':
      icon = <CheckCircle2 aria-hidden="true" />
      onClick = onEndAnswer
      break
    case 'retry':
      icon = <RefreshCcw aria-hidden="true" />
      onClick = onRetry
      break
    case 'open-knowledge-base':
      icon = <Library aria-hidden="true" />
      onClick = onOpenKnowledgeBase
      break
    case null:
      icon = <Loader2 aria-hidden="true" className="spin" />
      onClick = () => undefined
      break
  }

  return (
    <div className="primary-action-dock" aria-busy={pendingAction !== null}>
      <div className="primary-action-dock__context">
        <span className={`audio-health-dot audio-health-dot--${environment.captureHealth}`} aria-hidden="true" />
        <div>
          <strong>{AUDIO_SOURCE_LABELS[state.audioSource]}</strong>
          <span>{PERMISSION_LABELS[permission]} · {presentation.hint}</span>
        </div>
      </div>
      {permission === 'denied' || permission === 'unavailable' ? (
        <button
          type="button"
          className="secondary-action-button"
          onClick={() => { onOpenSettings('permissions') }}
          disabled={pendingAction !== null}
        >
          <Settings aria-hidden="true" />
          打开权限设置
        </button>
      ) : null}
      {captureActive ? (
        <button
          type="button"
          className="secondary-action-button secondary-action-button--stop"
          onClick={onStopSession}
          disabled={stopDisabled}
        >
          {pendingAction === 'stop-session' ? <Loader2 aria-hidden="true" className="spin" /> : <Square aria-hidden="true" />}
          {pendingAction === 'stop-session' ? '正在停止…' : state.mode === 'qa' ? '停止监听' : '取消记录'}
        </button>
      ) : null}
      {state.mode === 'qa' && state.qaPhase === 'error' && state.errorOperation === 'final' ? (
        <button
          type="button"
          className="secondary-action-button"
          onClick={onSkipQuestion}
          disabled={pendingAction !== null}
        >
          <ChevronRight aria-hidden="true" />
          跳过本问
        </button>
      ) : null}
      <button
        type="button"
        className={`primary-action-button primary-action-button--${state.mode}`}
        onClick={onClick}
        disabled={disabled}
      >
        {pendingAction !== null || presentation.action === null ? <Loader2 aria-hidden="true" className="spin" /> : icon}
        <span>{pendingLabel ?? presentation.label}</span>
      </button>
    </div>
  )
}

function Dashboard(props: DashboardProps): React.JSX.Element {
  const [viewportWidth, setViewportWidth] = useState(initialViewportWidth)
  const [preferredWorkbenchWidth, setPreferredWorkbenchWidth] = useState(initialWorkbenchWidth)
  const [workbenchCollapsed, setWorkbenchCollapsed] = useState(false)
  const [workbenchSheetOpen, setWorkbenchSheetOpen] = useState(false)
  const presentation = useMemo(
    () => phasePresentation(props.state, props.environment),
    [props.state, props.environment],
  )
  const narrow = workbenchLayoutMode(viewportWidth) === 'sheet'
  const workbenchMaxWidth = effectiveWorkbenchMaxWidth(viewportWidth)
  const workbenchWidth = effectiveWorkbenchWidth(preferredWorkbenchWidth, viewportWidth)
  const renderedWorkbenchWidth = workbenchCollapsed && !narrow
    ? WORKBENCH_COLLAPSED_WIDTH
    : workbenchWidth
  const workspaceRoundCount = props.qaWorkspace.page?.projectId === props.project.activeProjectId
    ? props.qaWorkspace.page.items.length
    : 0
  const workbenchSheetVisible = workbenchSheetIsVisible(
    workbenchSheetOpen,
    props.externalDrawerOpen,
    props.state.mode,
  )

  useEffect(() => {
    const update = (): void => { setViewportWidth(initialViewportWidth()) }
    window.addEventListener('resize', update)
    return () => { window.removeEventListener('resize', update) }
  }, [])

  const openSettings = (section: SettingsSection): void => {
    setWorkbenchSheetOpen(false)
    props.onOpenSettings(section)
  }
  const openKnowledgeBase = (): void => {
    setWorkbenchSheetOpen(false)
    props.onOpenKnowledgeBase()
  }
  const openProjectCenter = (): void => {
    setWorkbenchSheetOpen(false)
    props.onOpenProjectCenter()
  }

  const dashboardStyle = {
    '--qa-workbench-width': `${renderedWorkbenchWidth}px`,
  } as CSSProperties

  return (
    <div className="qaing-app" data-mode={props.state.mode}>
      <a href="#main-workspace" className="skip-link">跳到主工作区</a>
      <Header
        {...props}
        onOpenKnowledgeBase={openKnowledgeBase}
        onOpenSettings={openSettings}
        workspaceRoundCount={workspaceRoundCount}
        onOpenWorkbench={() => {
          if (narrow) setWorkbenchSheetOpen(true)
          else setWorkbenchCollapsed(false)
        }}
      />
      <NoticeStack {...props} onOpenSettings={openSettings} />
      <div
        className={`dashboard-grid dashboard-grid--${props.state.mode}`}
        style={dashboardStyle}
      >
        <ControlSidebar
          {...props}
          onOpenKnowledgeBase={openKnowledgeBase}
          onOpenSettings={openSettings}
          onOpenProjectCenter={openProjectCenter}
          onSwitchMode={(mode) => {
            if (mode === 'front') setWorkbenchSheetOpen(false)
            props.onSwitchMode(mode)
          }}
        />
        <main className={`main-workspace${props.state.mode === 'qa' ? ' main-workspace--qa' : ''}`} id="main-workspace">
          <SessionHero
            presentation={presentation}
            state={props.state}
            environment={props.environment}
            audioLevels={props.audioLevels}
          />
          <TranscriptPanel state={props.state} environment={props.environment} />
          {props.state.mode === 'front' ? <FrontProgressPanel {...props} onOpenKnowledgeBase={openKnowledgeBase} /> : null}
          <PrimaryActionDock {...props} onOpenKnowledgeBase={openKnowledgeBase} onOpenSettings={openSettings} />
        </main>
        {props.state.mode === 'qa' ? (
          <>
            <button
              type="button"
              className={`workbench-sheet-backdrop${workbenchSheetVisible ? ' is-open' : ''}`}
              aria-label="关闭会话工作台"
              aria-hidden={!workbenchSheetVisible}
              disabled={!workbenchSheetVisible}
              tabIndex={-1}
              onClick={() => { setWorkbenchSheetOpen(false) }}
            />
            <div className={`qa-workbench-shell${workbenchSheetVisible ? ' is-sheet-open' : ''}`}>
              {!narrow && !workbenchCollapsed ? (
                <WorkbenchResizeHandle
                  width={workbenchWidth}
                  maxWidth={workbenchMaxWidth}
                  onResize={setPreferredWorkbenchWidth}
                  onCommit={persistWorkbenchWidth}
                />
              ) : null}
              {!narrow || workbenchSheetVisible ? (
                <ConversationWorkbench
                  key={props.project.activeProjectId ?? 'unselected-project'}
                  state={props.state}
                  workspace={props.qaWorkspace}
                  projectId={props.project.activeProjectId}
                  projectName={props.project.activeProject?.displayName ?? null}
                  mutationLocked={hasActiveSession(props.state)}
                  collapsed={workbenchCollapsed}
                  narrow={narrow}
                  sheetOpen={workbenchSheetVisible}
                  pendingAction={props.pendingAction}
                  onToggleCollapsed={() => { setWorkbenchCollapsed((value) => !value) }}
                  onCloseSheet={() => { setWorkbenchSheetOpen(false) }}
                  onLoadMore={props.onLoadMoreQaWorkspace}
                  onRetry={props.onRetryQaWorkspace}
                  onCopyAnswer={props.onCopyAnswer}
                  onStopSession={props.onStopSession}
                  onDeleteRound={props.onDeleteQaWorkspaceRound}
                  onClearProject={props.onClearQaWorkspaceProject}
                  onExportProject={props.onExportQaWorkspaceProject}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      <div className="sr-only" aria-live="polite">
        {props.pendingAction !== null ? ACTION_PENDING_LABELS[props.pendingAction] ?? '正在处理操作' : ''}
      </div>
    </div>
  )
}

export default function App({
  state,
  environment,
  adapter,
  audioLevels = [],
  qaWorkspace,
  onLoadMoreQaWorkspace,
  onRetryQaWorkspace,
  onDeleteQaWorkspaceRound,
  onClearQaWorkspaceProject,
  onExportQaWorkspaceProject,
  project,
  simulatedQa,
}: AppProps): React.JSX.Element {
  const [pendingAction, setPendingAction] = useState<UiActionName | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [permissionRequestResults, setPermissionRequestResults] = useState<
    Readonly<Partial<Record<AudioSourceKind, AudioPermissionRequestResult>>>
  >({})
  const pendingRef = useRef<UiActionName | null>(null)
  const actionGenerationRef = useRef(0)
  const mutationLocked = hasActiveSession(state)
  const projectState = project?.state ?? EMPTY_PROJECT_UI_STATE

  const runAction = useCallback(
    async (name: UiActionName, action: () => UiActionResult): Promise<void> => {
      if (pendingRef.current !== null && name !== 'stop-session') return
      const actionGeneration = actionGenerationRef.current + 1
      actionGenerationRef.current = actionGeneration
      pendingRef.current = name
      setPendingAction(name)
      setLocalError(null)
      try {
        await action()
      } catch (error) {
        if (actionGenerationRef.current === actionGeneration) setLocalError(actionFailureMessage(name, error))
        throw error
      } finally {
        if (actionGenerationRef.current === actionGeneration) {
          pendingRef.current = null
          setPendingAction(null)
        }
      }
    },
    [],
  )

  const invoke = useCallback(
    (name: UiActionName, action: () => UiActionResult): void => {
      void runAction(name, action).catch(() => undefined)
    },
    [runAction],
  )

  const handlers: ActionHandlers = {
    onSwitchMode: (mode) => { invoke('switch-mode', () => adapter.switchMode(mode)) },
    onSelectAudioSource: (source) => { invoke('select-audio', () => adapter.selectAudioSource(source)) },
    onStart: () => { invoke('start', adapter.start) },
    onStopSession: () => { invoke('stop-session', adapter.stopSession) },
    onStopFront: () => { invoke('stop-front', adapter.stopFront) },
    onAcknowledgeFrontComplete: () => { invoke('acknowledge-front-complete', adapter.acknowledgeFrontComplete) },
    onEndQuestion: () => { invoke('end-question', adapter.endQuestion) },
    onEndAnswer: () => { invoke('end-answer', adapter.endAnswer) },
    onSkipQuestion: () => { invoke('skip-question', adapter.skipQuestion) },
    onRetry: () => { invoke('retry', adapter.retry) },
    onDismissError: () => {
      setLocalError(null)
      if (state.error !== null) invoke('dismiss-error', adapter.dismissError)
    },
    onOpenSettings: (section) => {
      if (pendingRef.current !== null) return
      setLocalError(null)
      setSettingsSection(section)
      setActiveDrawer('settings')
    },
    onOpenKnowledgeBase: () => {
      if (pendingRef.current !== null) return
      setLocalError(null)
      setActiveDrawer('knowledge')
    },
    onOpenProjectCenter: () => {
      if (pendingRef.current !== null) return
      setLocalError(null)
      setActiveDrawer('project')
    },
    onCopyAnswer: (answer) => { invoke('copy-answer', () => adapter.copyAnswer(answer)) },
    onConfigureProvider: (provider, credential) => {
      invoke('configure-provider', () => adapter.configureProvider(provider, credential))
    },
    onClearProvider: (provider) => { invoke('clear-provider', () => adapter.clearProvider(provider)) },
    onOpenPermission: (source) => { invoke('open-permission', () => adapter.openPermission(source)) },
    onRequestAudioPermission: (source) => {
      invoke('request-permission', async () => {
        const result = await adapter.requestAudioPermission(source)
        setPermissionRequestResults((current) => ({ ...current, [source]: result }))
      })
    },
    onRestartApplication: () => { invoke('restart-application', adapter.restartApplication) },
    onImportSourceDocuments: () => { invoke('import-source-documents', adapter.importSourceDocuments) },
    onImportPresetQa: () => { invoke('import-preset-qa', adapter.importPresetQa) },
    onDeleteDocument: (documentId) => { invoke('delete-document', () => adapter.deleteDocument(documentId)) },
    onSetAlwaysOnTop: (enabled) => { invoke('set-always-on-top', () => adapter.setAlwaysOnTop(enabled)) },
    onSelectProjectRoot: () => { invoke('select-project-root', adapter.selectProjectRoot) },
    onActivateProject: (projectId) => { invoke('activate-project', () => adapter.activateProject(projectId)) },
    onConfirmProjectDirectories: (projectId) => {
      invoke('confirm-project-directories', () => adapter.confirmProjectDirectories(projectId))
    },
    onCancelProjectPreparation: (projectId) => {
      invoke('cancel-project-preparation', () => adapter.cancelProjectPreparation(projectId))
    },
    onStartProjectSync: (projectId) => { invoke('start-project-sync', () => adapter.startProjectSync(projectId)) },
    onCancelProjectSync: (runId) => { invoke('cancel-project-sync', () => adapter.cancelProjectSync(runId)) },
    onRetryProjectSync: (projectId, runId) => {
      invoke('retry-project-sync', () => adapter.retryFailedProjectSync(projectId, runId))
    },
    onRelocateProject: (projectId) => { invoke('relocate-project', () => adapter.relocateProject(projectId)) },
    onSetProjectSyncPolicy: (projectId, policy) => {
      invoke('set-project-sync-policy', () => adapter.setProjectSyncPolicy(projectId, policy))
    },
    onSetProjectTaskFilter: (filter) => {
      invoke('set-project-task-filter', () => adapter.setProjectTaskFilter(filter))
    },
    onLoadMoreProjectTasks: () => { invoke('load-more-project-tasks', adapter.loadMoreProjectTasks) },
    onExportProjectDiagnostics: (projectId, runId) => {
      invoke('export-project-diagnostics', () => adapter.exportProjectDiagnostics(projectId, runId))
    },
    onDeleteQaWorkspaceRound: async (projectId, roundId) => {
      await runAction('delete-qa-workspace-round', () => onDeleteQaWorkspaceRound(projectId, roundId))
    },
    onClearQaWorkspaceProject: async (projectId) => {
      await runAction('clear-qa-workspace-project', () => onClearQaWorkspaceProject(projectId))
    },
    onExportQaWorkspaceProject: async (projectId) => {
      await runAction('export-qa-workspace-project', () => onExportQaWorkspaceProject(projectId))
    },
  }

  return (
    <>
      <Dashboard
        state={state}
        environment={environment}
        audioLevels={audioLevels}
        pendingAction={pendingAction}
        localError={localError}
        qaWorkspace={qaWorkspace}
        onLoadMoreQaWorkspace={onLoadMoreQaWorkspace}
        onRetryQaWorkspace={onRetryQaWorkspace}
        project={projectState}
        externalDrawerOpen={activeDrawer !== null}
        {...handlers}
      />
      {activeDrawer === 'settings' ? (
        <SettingsDrawer
          section={settingsSection}
          environment={environment}
          pendingAction={pendingAction}
          actionError={state.error ?? localError}
          mutationLocked={mutationLocked}
          onClose={() => { setActiveDrawer(null) }}
          onConfigureProvider={handlers.onConfigureProvider}
          onClearProvider={handlers.onClearProvider}
          onOpenPermission={handlers.onOpenPermission}
          onRequestAudioPermission={handlers.onRequestAudioPermission}
          onRestartApplication={handlers.onRestartApplication}
          permissionRequestResults={permissionRequestResults}
          onSetAlwaysOnTop={handlers.onSetAlwaysOnTop}
        />
      ) : null}
      {activeDrawer === 'knowledge' ? (
        <KnowledgeDrawer
          environment={environment}
          project={projectState}
          pendingAction={pendingAction}
          actionError={state.error ?? localError}
          mutationLocked={mutationLocked}
          onClose={() => { setActiveDrawer(null) }}
          onOpenProjectCenter={handlers.onOpenProjectCenter}
          onImportSourceDocuments={handlers.onImportSourceDocuments}
          onImportPresetQa={handlers.onImportPresetQa}
          onDeleteDocument={handlers.onDeleteDocument}
        />
      ) : null}
      {activeDrawer === 'project' ? (
        <ProjectSyncDrawer
          state={projectState}
          pendingAction={pendingAction}
          actionError={localError}
          sessionLocked={mutationLocked}
          onClose={() => { setActiveDrawer(null) }}
          onSelectRoot={handlers.onSelectProjectRoot}
          onActivate={handlers.onActivateProject}
          onConfirmDirectories={handlers.onConfirmProjectDirectories}
          onCancelPreparation={handlers.onCancelProjectPreparation}
          onStartSync={handlers.onStartProjectSync}
          onCancelSync={handlers.onCancelProjectSync}
          onRetryFailed={handlers.onRetryProjectSync}
          onRelocate={handlers.onRelocateProject}
          onSetPolicy={handlers.onSetProjectSyncPolicy}
          onSetFilter={handlers.onSetProjectTaskFilter}
          onLoadMore={handlers.onLoadMoreProjectTasks}
          onExportDiagnostics={handlers.onExportProjectDiagnostics}
          {...(simulatedQa === undefined ? {} : { simulatedQa })}
        />
      ) : null}
    </>
  )
}
