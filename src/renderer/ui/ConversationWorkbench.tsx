import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  Download,
  FileText,
  History,
  Loader2,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AppState, QaAnswerVersion, QaWorkspaceRound, SourceReference } from '../../core/types'
import type { QaWorkspaceViewState, UiActionName } from './contracts'
import {
  answerVersionLabel,
  elapsedAnswerLabel,
  orderedAnswerVersions,
  orderedWorkspaceRounds,
  resolveVersionView,
  resolveWorkspaceExport,
  retrievalRoutePresentation,
} from './qa-workspace'
import { safeProjectName } from './project-ui'

interface ConversationWorkbenchProps {
  readonly state: AppState
  readonly workspace: QaWorkspaceViewState
  readonly projectId: string | null
  readonly projectName: string | null
  readonly mutationLocked: boolean
  readonly collapsed: boolean
  readonly narrow: boolean
  readonly sheetOpen: boolean
  readonly pendingAction: UiActionName | null
  readonly onToggleCollapsed: () => void
  readonly onCloseSheet: () => void
  readonly onLoadMore: () => void
  readonly onRetry: () => void
  readonly onCopyAnswer: (answer: string) => void
  readonly onStopSession: () => void
  readonly onDeleteRound: (projectId: string, roundId: string) => Promise<void>
  readonly onClearProject: (projectId: string) => Promise<void>
  readonly onExportProject: (projectId: string) => Promise<void>
}

interface LocalVersionSelection {
  readonly versionId: string
  readonly pinned: boolean
}

interface RoundStatusMessage {
  readonly tone: 'progress' | 'warning'
  readonly title: string
  readonly detail: string
}

type WorkspaceConfirmation =
  | { readonly kind: 'delete'; readonly roundId: string; readonly roundLabel: string }
  | { readonly kind: 'clear'; readonly step: 1 | 2 }

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'details > summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const ROUND_STATUS_LABELS: Readonly<Record<QaWorkspaceRound['status'], string>> = {
  active: '当前轮',
  answer_locked: '答案已锁定',
  completed: '已完成',
  skipped: '已跳过',
  cancelled: '已取消',
  interrupted: '已中断',
  failed: '未完成',
}

function safeTimeLabel(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '时间未知'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function sourceRelativeRank(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.max(0, Math.min(100, Math.round(score * 100)))
}

function VersionSource({ source, rank }: { readonly source: SourceReference; readonly rank: number }): React.JSX.Element {
  return (
    <article className="workbench-source">
      <header>
        <span className={`source-rank source-rank--${source.kind}`}>{rank}</span>
        <div>
          <span>{source.kind === 'preset_qa' ? '预设 QA' : '原始资料'}</span>
          <strong>{source.title}</strong>
        </div>
        <span
          className="source-score"
          title="融合排名相对值，不代表答案正确率"
          aria-label={`融合排名相对值 ${sourceRelativeRank(source.score)}，不代表答案正确率`}
        >
          R{sourceRelativeRank(source.score)}
        </span>
      </header>
      <p>{source.excerpt}</p>
    </article>
  )
}

function VersionDetail({
  version,
  pendingAction,
  onCopyAnswer,
}: {
  readonly version: QaAnswerVersion
  readonly pendingAction: UiActionName | null
  readonly onCopyAnswer: (answer: string) => void
}): React.JSX.Element {
  const route = retrievalRoutePresentation(version.retrievalRoute)
  return (
    <div className="workbench-version-detail">
      <div className="workbench-version-meta">
        <span className={`workbench-route-badge workbench-route-badge--${route.tone}`}>
          {route.tone === 'document'
            ? <FileText aria-hidden="true" />
            : route.tone === 'legacy'
              ? <History aria-hidden="true" />
              : <Sparkles aria-hidden="true" />}
          {route.label}
        </span>
        <span>{elapsedAnswerLabel(version.elapsedMs)}</span>
        {version.answerUnchanged ? <span>与上一版一致</span> : null}
        {version.isSuperseded ? <span>历史版本</span> : null}
      </div>

      <section className="workbench-question-snapshot" aria-label="该答案基于的完整问题">
        <header>
          <span>基于问题</span>
          <span>R{version.questionRevision}</span>
        </header>
        <p>{version.questionSnapshot || '未保存问题快照。'}</p>
      </section>

      <section className="workbench-answer-copy" aria-label="完整答案">
        <header>
          <strong>完整答案</strong>
          <button
            type="button"
            aria-label={`复制${answerVersionLabel(version)}`}
            title="复制该版答案"
            onClick={() => { onCopyAnswer(version.answer) }}
            disabled={pendingAction !== null || version.answer.trim().length === 0}
          >
            <Copy aria-hidden="true" />
            复制
          </button>
        </header>
        <p>{version.answer || '该版未生成可用答案。'}</p>
      </section>

      <details className="workbench-sources">
        <summary>
          <span><BookOpen aria-hidden="true" />版本来源</span>
          <span>{version.sources.length} 条 · {route.detail}</span>
        </summary>
        <div>
          {version.sources.length ? version.sources.map((source, index) => (
            <VersionSource key={`${source.id}:${index}`} source={source} rank={index + 1} />
          )) : (
            <div className="workbench-source-empty">
              <ShieldCheck aria-hidden="true" />
              <span>{version.stage === 'legacy_committed'
                ? '旧版记录未保存来源，不代表已完成最终核验。'
                : '该版未保存可展示的来源摘要。'}</span>
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

function RoundCard({
  round,
  current,
  expanded,
  pendingAction,
  selection,
  onToggle,
  onSelectVersion,
  onFollowLatest,
  onCopyAnswer,
  statusMessage,
  destructiveDisabled,
  destructiveReason,
  onRequestDelete,
}: {
  readonly round: QaWorkspaceRound
  readonly current: boolean
  readonly expanded: boolean
  readonly pendingAction: UiActionName | null
  readonly selection: LocalVersionSelection | undefined
  readonly onToggle: () => void
  readonly onSelectVersion: (version: QaAnswerVersion, latest: QaAnswerVersion) => void
  readonly onFollowLatest: () => void
  readonly onCopyAnswer: (answer: string) => void
  readonly statusMessage: RoundStatusMessage | null
  readonly destructiveDisabled: boolean
  readonly destructiveReason: string
  readonly onRequestDelete: () => void
}): React.JSX.Element {
  const idPrefix = useId().replaceAll(':', '')
  const versions = orderedAnswerVersions(round)
  const { selected, latest, hasNewer } = resolveVersionView(
    round,
    selection?.pinned === true ? selection.versionId : null,
  )
  const bodyId = `${idPrefix}-body`
  const roundTitle = round.questionPreview.trim() || (current ? '等待首次语义完整的问题' : '未保存问题摘要')
  const displayOrdinal = round.ordinal + 1

  return (
    <article className={`workbench-round${current ? ' workbench-round--current' : ''}`}>
      <div className="workbench-round__header">
        <button
          type="button"
          className="workbench-round__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="workbench-round__index">{displayOrdinal}</span>
          <span className="workbench-round__heading">
            <span>
              <strong>{current ? '当前轮' : `第 ${displayOrdinal} 轮`}</strong>
              <small>{ROUND_STATUS_LABELS[round.status]} · {safeTimeLabel(round.startedAt)}</small>
            </span>
            <span>{roundTitle}</span>
          </span>
          <span className="workbench-round__count">{versions.length} 版</span>
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
        {!current ? (
          <button
            type="button"
            aria-label={`删除第 ${displayOrdinal} 轮`}
            title={destructiveDisabled ? destructiveReason : '删除本轮'}
            className="workbench-round__delete"
            disabled={destructiveDisabled}
            onClick={onRequestDelete}
          >
            <Trash2 aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div id={bodyId} className="workbench-round__body">
          {statusMessage !== null ? (
            <div
              className={`workbench-round-status workbench-round-status--${statusMessage.tone}`}
              role="status"
            >
              {statusMessage.tone === 'progress'
                ? <Loader2 aria-hidden="true" className="spin" />
                : <CircleAlert aria-hidden="true" />}
              <div>
                <strong>{statusMessage.title}</strong>
                <span>{statusMessage.detail}</span>
              </div>
            </div>
          ) : null}
          {versions.length && selected !== null && latest !== null ? (
            <>
              <div className="workbench-version-row">
                <div className="workbench-version-tabs" role="tablist" aria-label={`第 ${displayOrdinal} 轮答案版本`}>
                  {versions.map((version, index) => {
                    const selectedVersion = version.id === selected.id
                    const tabId = `${idPrefix}-tab-${index}`
                    const panelId = `${idPrefix}-panel-${index}`
                    return (
                      <button
                        key={version.id}
                        id={tabId}
                        type="button"
                        role="tab"
                        aria-selected={selectedVersion}
                        aria-controls={panelId}
                        tabIndex={selectedVersion ? 0 : -1}
                        className={selectedVersion ? 'is-selected' : undefined}
                        onClick={() => { onSelectVersion(version, latest) }}
                        onKeyDown={(event) => {
                          let nextIndex: number | null = null
                          if (event.key === 'ArrowRight') nextIndex = (index + 1) % versions.length
                          if (event.key === 'ArrowLeft') nextIndex = (index - 1 + versions.length) % versions.length
                          if (event.key === 'Home') nextIndex = 0
                          if (event.key === 'End') nextIndex = versions.length - 1
                          if (nextIndex === null) return
                          event.preventDefault()
                          const next = versions[nextIndex]
                          if (next === undefined) return
                          onSelectVersion(next, latest)
                          document.getElementById(`${idPrefix}-tab-${nextIndex}`)?.focus()
                        }}
                      >
                        <span>{answerVersionLabel(version)}</span>
                        <small>{elapsedAnswerLabel(version.elapsedMs)}</small>
                      </button>
                    )
                  })}
                </div>
                {hasNewer ? (
                  <button type="button" className="workbench-new-version" onClick={onFollowLatest}>
                    <Sparkles aria-hidden="true" />
                    有新完整版本
                  </button>
                ) : null}
              </div>
              {versions.map((version, index) => version.id === selected.id ? (
                <div
                  key={version.id}
                  id={`${idPrefix}-panel-${index}`}
                  role="tabpanel"
                  aria-labelledby={`${idPrefix}-tab-${index}`}
                >
                  <VersionDetail
                    version={version}
                    pendingAction={pendingAction}
                    onCopyAnswer={onCopyAnswer}
                  />
                </div>
              ) : null)}
            </>
          ) : (
            <div className="workbench-round-empty" role="status">
              {current ? <Loader2 aria-hidden="true" className="spin" /> : <MessageSquareText aria-hidden="true" />}
              <div>
                <strong>{current ? '等待首次完整候选' : '本轮没有可用答案版本'}</strong>
                <span>{current
                  ? '问题首次语义完整后，完整答案会原子出现在这里。'
                  : '跳过、中断或未完成的轮次不会伪造答案。'}</span>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </article>
  )
}

export function WorkspaceConfirmationDialog({
  confirmation,
  projectName,
  totalRounds,
  busy,
  busyLabel,
  error,
  onCancel,
  onAdvanceClear,
  onConfirm,
}: {
  readonly confirmation: WorkspaceConfirmation
  readonly projectName: string
  readonly totalRounds: number
  readonly busy: boolean
  readonly busyLabel: string
  readonly error: string | null
  readonly onCancel: () => void
  readonly onAdvanceClear: () => void
  readonly onConfirm: () => void
}): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => { dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [])
  const destructiveLabel = confirmation.kind === 'delete'
    ? `删除${confirmation.roundLabel}`
    : confirmation.step === 1
      ? '继续清空'
      : `确认清空 ${totalRounds.toLocaleString('zh-CN')} 轮`
  return (
    <div className="workbench-confirmation-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="workbench-confirmation"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (!busy) onCancel()
            return
          }
          if (event.key !== 'Tab') return
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
          if (focusable.length === 0) {
            event.preventDefault()
            dialogRef.current?.focus()
            return
          }
          const first = focusable[0]
          const last = focusable.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <header>
          <span><Trash2 aria-hidden="true" /></span>
          <div>
            <strong id={titleId}>{confirmation.kind === 'delete' ? '删除这一轮？' : confirmation.step === 1 ? '清空当前项目工作台？' : '请再次确认清空'}</strong>
            <small>当前项目：{projectName}</small>
          </div>
          <button type="button" aria-label="取消并关闭确认" onClick={onCancel} disabled={busy}><X aria-hidden="true" /></button>
        </header>
        {confirmation.kind === 'delete' ? (
          <p>将永久删除{confirmation.roundLabel}及其全部答案版本。其他轮次不受影响，此操作无法撤销。</p>
        ) : (
          <p>将永久删除项目“{projectName}”中的 <strong>{totalRounds.toLocaleString('zh-CN')} 轮</strong>及全部答案版本。不会影响其他项目，此操作无法撤销。</p>
        )}
        {confirmation.kind === 'clear' && confirmation.step === 1 ? (
          <div className="workbench-confirmation__warning"><CircleAlert aria-hidden="true" />这是第一次确认；下一步仍需再次确认项目名和轮次数。</div>
        ) : null}
        {error !== null ? <div className="workbench-confirmation__error" role="alert">{error}</div> : null}
        <footer>
          <button type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button
            type="button"
            className="is-danger"
            onClick={confirmation.kind === 'clear' && confirmation.step === 1 ? onAdvanceClear : onConfirm}
            disabled={busy}
          >
            {busy ? <Loader2 aria-hidden="true" className="spin" /> : <Trash2 aria-hidden="true" />}
            {busy ? busyLabel : destructiveLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}

export function ConversationWorkbench({
  state,
  workspace,
  projectId,
  projectName,
  mutationLocked,
  collapsed,
  narrow,
  sheetOpen,
  pendingAction,
  onToggleCollapsed,
  onCloseSheet,
  onLoadMore,
  onRetry,
  onCopyAnswer,
  onStopSession,
  onDeleteRound,
  onClearProject,
  onExportProject,
}: ConversationWorkbenchProps): React.JSX.Element {
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null)
  const [expandedOverrides, setExpandedOverrides] = useState<Readonly<Record<string, boolean>>>({})
  const [versionSelections, setVersionSelections] = useState<Readonly<Record<string, LocalVersionSelection>>>({})
  const [confirmation, setConfirmation] = useState<WorkspaceConfirmation | null>(null)
  const [confirmationError, setConfirmationError] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [mutationAnnouncement, setMutationAnnouncement] = useState('')
  const visiblePage = projectId !== null && workspace.page?.projectId === projectId ? workspace.page : null
  const rounds = useMemo(
    () => orderedWorkspaceRounds(visiblePage, state.activeRoundId),
    [visiblePage, state.activeRoundId],
  )
  const activeRound = rounds.find((round) => round.id === state.activeRoundId)
    ?? rounds.find((round) => round.status === 'active' || round.status === 'answer_locked')
    ?? null
  const latestCompleted = rounds.find((round) => round.id !== activeRound?.id && round.status === 'completed') ?? null
  const activeRoundStatus: RoundStatusMessage | null = (() => {
    if (state.qaPhase === 'finalizing') {
      return {
        tone: 'progress',
        title: '正在对锁定问题做最终核验',
        detail: '当前完整候选保持可见；核验完成后会新增“最终”版本。',
      }
    }
    if (state.qaPhase === 'listening' && state.candidateUpdating) {
      return {
        tone: 'progress',
        title: '正在根据最新问题更新',
        detail: '已发布的完整版本不会被流式内容覆盖。',
      }
    }
    if (state.qaPhase === 'error' && state.errorOperation === 'final') {
      return {
        tone: 'warning',
        title: '最终核验未完成',
        detail: '下方仅保留基于早期问题快照的历史候选，不是本轮确定答案。',
      }
    }
    if (state.qaPhase === 'answer_locked' && state.answerOrigin === 'candidate_fallback') {
      return {
        tone: 'warning',
        title: '候选降级答案',
        detail: '最终核验未完成；该版本与已锁定的问题快照一致，请结合来源使用。',
      }
    }
    return null
  })()
  const safeName = projectName === null ? '未选择项目' : safeProjectName(projectName)
  const totalRounds = visiblePage?.totalRounds ?? 0
  const destructiveDisabled = mutationLocked
    || pendingAction !== null
    || projectId === null
    || workspace.loading
    || workspace.error !== null
    || visiblePage === null
  const destructiveReason = mutationLocked
    ? '会话进行中不能删除或清空轮次'
    : workspace.loading
      ? '正在核对最新轮次，暂不能执行破坏操作'
      : workspace.error !== null
        ? '请先重新加载最新工作台，再执行破坏操作'
        : pendingAction !== null
          ? '请等待当前操作完成'
          : '当前项目工作台尚未就绪'

  const closeConfirmation = (restoreToHeader = false): void => {
    setConfirmation(null)
    setConfirmationError(null)
    queueMicrotask(() => {
      const target = restoreToHeader ? null : confirmationReturnFocusRef.current
      if (target?.isConnected) target.focus()
      else headerRef.current?.focus()
      confirmationReturnFocusRef.current = null
    })
  }

  const requestConfirmation = (next: WorkspaceConfirmation): void => {
    if (destructiveDisabled) return
    confirmationReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setConfirmationError(null)
    setConfirmation(next)
  }

  const confirmDestructiveAction = async (): Promise<void> => {
    if (confirmation === null || projectId === null || destructiveDisabled) return
    try {
      if (confirmation.kind === 'delete') {
        await onDeleteRound(projectId, confirmation.roundId)
        setMutationAnnouncement(`${confirmation.roundLabel}已删除。`)
      } else {
        await onClearProject(projectId)
        setMutationAnnouncement(`项目“${safeName}”的 ${totalRounds.toLocaleString('zh-CN')} 轮已清空。`)
      }
      closeConfirmation(true)
    } catch {
      setConfirmationError('操作未完成，当前工作台内容已保留。请稍后重试。')
    }
  }

  useEffect(() => {
    if (!narrow || !sheetOpen) return undefined
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => { previouslyFocused?.focus() }
  }, [narrow, sheetOpen])

  const handleSheetKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (confirmation !== null) return
    if (!narrow || !sheetOpen) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onCloseSheet()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
    if (focusable.length === 0) {
      event.preventDefault()
      panelRef.current?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  if (collapsed && !narrow) {
    return (
      <aside id="qa-conversation-workbench" className="conversation-workbench conversation-workbench--collapsed" aria-label="会话工作台已折叠">
        <button type="button" onClick={onToggleCollapsed} aria-label="展开会话工作台" title="展开会话工作台">
          <PanelRightOpen aria-hidden="true" />
          <span>{rounds.length}</span>
        </button>
        <span aria-hidden="true">会话工作台</span>
      </aside>
    )
  }

  return (
    <aside
      ref={panelRef}
      id="qa-conversation-workbench"
      className="conversation-workbench"
      aria-label="多轮会话工作台"
      role={narrow ? 'dialog' : undefined}
      aria-modal={narrow ? 'true' : undefined}
      tabIndex={narrow ? -1 : undefined}
      onKeyDown={handleSheetKeyDown}
    >
      <header ref={headerRef} className="workbench-header" tabIndex={-1}>
        <div>
          <span className="workbench-header__icon"><History aria-hidden="true" /></span>
          <div>
            <strong>{projectId === null ? '会话工作台' : `${safeName} · 会话工作台`}</strong>
            <span title={mutationLocked ? '会话进行中，可导出；删除与清空已锁定。' : undefined}>{projectId === null
              ? '尚未选择项目'
              : mutationLocked
                ? `${totalRounds} 轮 · 会话进行中，可导出；删除与清空已锁定`
              : totalRounds > 0
                ? `${totalRounds} 轮 · 完整版本留存`
                : '当前项目等待第一轮问答'}</span>
          </div>
        </div>
        <div className="workbench-header__actions">
          {projectId !== null ? (
            <>
              <button
                type="button"
                aria-label={`导出项目“${safeName}”的会话工作台`}
                title="导出当前项目"
                onClick={() => {
                  setExportError(null)
                  void resolveWorkspaceExport(() => onExportProject(projectId))
                    .then((outcome) => {
                      if (outcome === 'exported') {
                        setMutationAnnouncement(`项目“${safeName}”的会话工作台已导出。`)
                      } else {
                        setExportError('导出未完成，没有改变任何轮次。请稍后重试。')
                      }
                    })
                }}
                disabled={pendingAction !== null}
              >
                <Download aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`清空项目“${safeName}”的 ${totalRounds} 轮会话`}
                title={destructiveDisabled ? destructiveReason : '清空当前项目'}
                onClick={() => { requestConfirmation({ kind: 'clear', step: 1 }) }}
                disabled={destructiveDisabled || totalRounds === 0}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </>
          ) : null}
          {narrow && state.qaPhase === 'listening' ? (
            <button
              type="button"
              className="workbench-stop-action"
              onClick={onStopSession}
              disabled={pendingAction !== null}
            >
              <Square aria-hidden="true" />
              停止监听
            </button>
          ) : null}
          <button
            ref={narrow ? closeRef : undefined}
            type="button"
            aria-label={narrow ? '关闭会话工作台' : '折叠会话工作台'}
            title={narrow ? '关闭' : '折叠工作台'}
            onClick={narrow ? onCloseSheet : onToggleCollapsed}
          >
            <PanelRightClose aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="workbench-scroll-region">
        {exportError !== null ? (
          <div className="workbench-inline-error" role="alert">
            <CircleAlert aria-hidden="true" />
            <span>{exportError}</span>
            <button type="button" onClick={() => { setExportError(null) }}>关闭</button>
          </div>
        ) : null}
        {workspace.loading && visiblePage === null && projectId !== null ? (
          <div className="workbench-loading" role="status">
            <Loader2 aria-hidden="true" className="spin" />
            <strong>正在加载会话工作台</strong>
            <span>答案正文通过独立分页通道读取。</span>
          </div>
        ) : workspace.error !== null && visiblePage === null && projectId !== null ? (
          <div className="workbench-error" role="alert">
            <CircleAlert aria-hidden="true" />
            <strong>会话工作台暂时无法读取</strong>
            <span>{workspace.error}</span>
            <button type="button" onClick={onRetry}>
              <RefreshCcw aria-hidden="true" />
              重新加载
            </button>
          </div>
        ) : rounds.length ? (
          <ol className="workbench-round-list">
            {rounds.map((round) => {
              const current = round.id === activeRound?.id
              const expanded = expandedOverrides[round.id] ?? (current || round.id === latestCompleted?.id)
              return (
                <li key={round.id}>
                  <RoundCard
                    round={round}
                    current={current}
                    expanded={expanded}
                    pendingAction={pendingAction}
                    selection={versionSelections[round.id]}
                    statusMessage={current ? activeRoundStatus : null}
                    destructiveDisabled={destructiveDisabled}
                    destructiveReason={destructiveReason}
                    onRequestDelete={() => {
                      requestConfirmation({
                        kind: 'delete',
                        roundId: round.id,
                        roundLabel: `第 ${round.ordinal + 1} 轮`,
                      })
                    }}
                    onToggle={() => {
                      setExpandedOverrides((values) => ({ ...values, [round.id]: !expanded }))
                    }}
                    onSelectVersion={(version, latest) => {
                      setVersionSelections((values) => {
                        if (version.id === latest.id) {
                          const next = { ...values }
                          delete next[round.id]
                          return next
                        }
                        return { ...values, [round.id]: { versionId: version.id, pinned: true } }
                      })
                    }}
                    onFollowLatest={() => {
                      setVersionSelections((values) => {
                        const next = { ...values }
                        delete next[round.id]
                        return next
                      })
                    }}
                    onCopyAnswer={onCopyAnswer}
                  />
                </li>
              )
            })}
          </ol>
        ) : (
          <div className="workbench-empty">
            <MessageSquareText aria-hidden="true" />
            <strong>{projectId === null ? '尚未选择项目' : state.activeRoundId === null ? '当前项目还没有问答轮次' : '当前轮正在理解问题'}</strong>
            <span>{projectId === null
              ? '选择项目后，工作台只显示并管理该项目的问答轮次。'
              : state.activeRoundId === null
                ? '开始监听后，每个完整答案版本都会留在当前项目。'
              : '问题首次语义完整后，会立即生成首次候选。'}</span>
          </div>
        )}

        {workspace.error !== null && visiblePage !== null ? (
          <div className="workbench-inline-error" role="status">
            <CircleAlert aria-hidden="true" />
            <span>{workspace.error}</span>
            <button type="button" onClick={onRetry}>重试</button>
          </div>
        ) : null}

        {visiblePage?.nextCursor !== null && visiblePage?.nextCursor !== undefined ? (
          <button
            type="button"
            className="workbench-load-more"
            onClick={onLoadMore}
            disabled={workspace.loading || workspace.loadingMore}
          >
            {workspace.loadingMore ? <Loader2 aria-hidden="true" className="spin" /> : <History aria-hidden="true" />}
            {workspace.loadingMore ? '正在加载…' : '加载更早轮次'}
          </button>
        ) : rounds.length ? (
          <div className="workbench-end"><CheckCircle2 aria-hidden="true" />已显示全部已加载轮次</div>
        ) : null}
      </div>

      <div className="sr-only" aria-live="polite">
        {mutationAnnouncement || (visiblePage === null ? '' : `完整答案列表已更新，数据版本 ${visiblePage.dataRevision}。`)}
      </div>
      {confirmation !== null ? (
        <WorkspaceConfirmationDialog
          confirmation={confirmation}
          projectName={safeName}
          totalRounds={totalRounds}
          busy={workspace.loading || pendingAction === 'delete-qa-workspace-round' || pendingAction === 'clear-qa-workspace-project'}
          busyLabel={workspace.loading ? '正在核对最新轮次…' : '正在处理…'}
          error={confirmationError}
          onCancel={closeConfirmation}
          onAdvanceClear={() => { setConfirmation({ kind: 'clear', step: 2 }) }}
          onConfirm={() => { void confirmDestructiveAction() }}
        />
      ) : null}
    </aside>
  )
}
