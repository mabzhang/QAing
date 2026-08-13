import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { initialAppState } from '../../core/state-machine'
import type { QaAnswerVersion, QaWorkspaceRound } from '../../core/types'
import { ConversationWorkbench, WorkspaceConfirmationDialog } from './ConversationWorkbench'

function version(patch: Partial<QaAnswerVersion>): QaAnswerVersion {
  return {
    id: 'version-1',
    roundId: 'round-1',
    ordinal: 0,
    stage: 'candidate',
    questionRevision: 1,
    questionSnapshot: '问题快照',
    questionIdentity: '问题快照',
    answer: '完整答案',
    retrievalRoute: 'preset_qa_exact',
    sources: [],
    elapsedMs: 5_200,
    createdAt: 100,
    isSelected: false,
    isSuperseded: false,
    answerUnchanged: false,
    ...patch,
  }
}

function round(patch: Partial<QaWorkspaceRound>): QaWorkspaceRound {
  return {
    id: 'round-1',
    sessionId: 'session-1',
    ordinal: 1,
    status: 'completed',
    questionPreview: '已完成问题',
    startedAt: 100,
    completedAt: 150,
    selectedAnswerVersionId: null,
    versions: [],
    ...patch,
  }
}

const workbenchActions = {
  mutationLocked: false,
  onDeleteRound: () => Promise.resolve(),
  onClearProject: () => Promise.resolve(),
  onExportProject: () => Promise.resolve(),
} as const

describe('ConversationWorkbench', () => {
  it('places the current round first, expands the latest completed round, and folds older rounds', () => {
    const current = round({
      id: 'current',
      status: 'active',
      ordinal: 1,
      startedAt: 400,
      completedAt: null,
      questionPreview: '当前问题',
    })
    const latestCompleted = round({
      id: 'latest',
      sessionId: 'previous-session',
      ordinal: 1,
      startedAt: 300,
      questionPreview: '最近完成问题',
      versions: [
        version({ id: 'latest-v2', roundId: 'latest', ordinal: 1, answer: '最近答案更新版' }),
        version({ id: 'latest-v1', roundId: 'latest', ordinal: 0, answer: '最近答案首版' }),
      ],
    })
    const older = round({
      id: 'older',
      sessionId: 'old-session',
      ordinal: 99,
      startedAt: 200,
      questionPreview: '更早问题',
      versions: [version({ id: 'older-v1', roundId: 'older', answer: '折叠后不应渲染的旧答案' })],
    })
    const html = renderToStaticMarkup(
      <ConversationWorkbench
        state={{ ...initialAppState, qaPhase: 'listening', sessionId: 'session-1', activeRoundId: 'current' }}
        workspace={{
          page: { projectId: 'project-1', totalRounds: 3, items: [older, latestCompleted, current], nextCursor: null, dataRevision: 2 },
          loading: false,
          loadingMore: false,
          error: null,
        }}
        projectId="project-1"
        projectName="演示项目"
        {...workbenchActions}
        collapsed={false}
        narrow={false}
        sheetOpen={false}
        pendingAction={null}
        onToggleCollapsed={() => undefined}
        onCloseSheet={() => undefined}
        onLoadMore={() => undefined}
        onRetry={() => undefined}
        onCopyAnswer={() => undefined}
        onStopSession={() => undefined}
      />,
    )

    expect(html.indexOf('当前问题')).toBeLessThan(html.indexOf('最近完成问题'))
    expect(html.indexOf('最近完成问题')).toBeLessThan(html.indexOf('更早问题'))
    expect(html.indexOf('最近答案首版')).toBeLessThan(html.indexOf('最近答案更新版'))
    expect(html).toContain('首次候选')
    expect(html).toContain('更新 2')
    expect(html).toContain('预设 QA 精确命中')
    expect(html).not.toContain('折叠后不应渲染的旧答案')
  })

  it('exposes a labelled compact rail when collapsed', () => {
    const html = renderToStaticMarkup(
      <ConversationWorkbench
        state={initialAppState}
        workspace={{ page: { projectId: null, totalRounds: 0, items: [], nextCursor: null, dataRevision: 0 }, loading: false, loadingMore: false, error: null }}
        projectId={null}
        projectName={null}
        {...workbenchActions}
        collapsed
        narrow={false}
        sheetOpen={false}
        pendingAction={null}
        onToggleCollapsed={() => undefined}
        onCloseSheet={() => undefined}
        onLoadMore={() => undefined}
        onRetry={() => undefined}
        onCopyAnswer={() => undefined}
        onStopSession={() => undefined}
      />,
    )
    expect(html).toContain('aria-label="会话工作台已折叠"')
    expect(html).toContain('aria-label="展开会话工作台"')
  })

  it('presents zero-based stored round ordinals as human one-based labels', () => {
    const html = renderToStaticMarkup(
      <ConversationWorkbench
        state={initialAppState}
        workspace={{
          page: { projectId: 'project-1', totalRounds: 1, items: [round({ ordinal: 0, versions: [version({})] })], nextCursor: null, dataRevision: 1 },
          loading: false,
          loadingMore: false,
          error: null,
        }}
        projectId="project-1"
        projectName="演示项目"
        {...workbenchActions}
        collapsed={false}
        narrow={false}
        sheetOpen={false}
        pendingAction={null}
        onToggleCollapsed={() => undefined}
        onCloseSheet={() => undefined}
        onLoadMore={() => undefined}
        onRetry={() => undefined}
        onCopyAnswer={() => undefined}
        onStopSession={() => undefined}
      />,
    )
    expect(html).toContain('第 1 轮')
    expect(html).toContain('aria-label="第 1 轮答案版本"')
    expect(html).not.toContain('第 0 轮')
  })

  it('labels the active project and exposes exact-count project actions', () => {
    const html = renderToStaticMarkup(
      <ConversationWorkbench
        state={initialAppState}
        workspace={{
          page: { projectId: 'project-1', totalRounds: 27, items: [round({ ordinal: 0 })], nextCursor: 'cursor', dataRevision: 8 },
          loading: false,
          loadingMore: false,
          error: null,
        }}
        projectId="project-1"
        projectName="政府报告项目"
        {...workbenchActions}
        collapsed={false}
        narrow={false}
        sheetOpen={false}
        pendingAction={null}
        onToggleCollapsed={() => undefined}
        onCloseSheet={() => undefined}
        onLoadMore={() => undefined}
        onRetry={() => undefined}
        onCopyAnswer={() => undefined}
        onStopSession={() => undefined}
      />,
    )
    expect(html).toContain('政府报告项目 · 会话工作台')
    expect(html).toContain('27 轮 · 完整版本留存')
    expect(html).toContain('aria-label="导出项目“政府报告项目”的会话工作台"')
    expect(html).toContain('aria-label="清空项目“政府报告项目”的 27 轮会话"')
    expect(html).toContain('aria-label="删除第 1 轮"')
  })

  it('keeps export available but disables destructive actions during an active session', () => {
    const html = renderToStaticMarkup(
      <ConversationWorkbench
        state={{ ...initialAppState, qaPhase: 'listening', sessionId: 'session-active' }}
        workspace={{
          page: { projectId: 'project-1', totalRounds: 1, items: [round({ ordinal: 0 })], nextCursor: null, dataRevision: 8 },
          loading: false,
          loadingMore: false,
          error: null,
        }}
        projectId="project-1"
        projectName="政府报告项目"
        {...workbenchActions}
        mutationLocked
        collapsed={false}
        narrow={false}
        sheetOpen={false}
        pendingAction={null}
        onToggleCollapsed={() => undefined}
        onCloseSheet={() => undefined}
        onLoadMore={() => undefined}
        onRetry={() => undefined}
        onCopyAnswer={() => undefined}
        onStopSession={() => undefined}
      />,
    )
    const exportButton = html.match(/<button[^>]+aria-label="导出项目“政府报告项目”的会话工作台"[^>]*>/u)?.[0] ?? ''
    const clearButton = html.match(/<button[^>]+aria-label="清空项目“政府报告项目”的 1 轮会话"[^>]*>/u)?.[0] ?? ''
    const deleteButton = html.match(/<button[^>]+aria-label="删除第 1 轮"[^>]*>/u)?.[0] ?? ''
    expect(exportButton).not.toContain('disabled')
    expect(clearButton).toContain('disabled')
    expect(deleteButton).toContain('disabled')
    expect(html).toContain('会话进行中，可导出；删除与清空已锁定')
  })

  it('never renders another project page while the selected project is changing', () => {
    const html = renderToStaticMarkup(
      <ConversationWorkbench
        state={initialAppState}
        workspace={{
          page: { projectId: 'project-old', totalRounds: 1, items: [round({ questionPreview: '旧项目不得出现' })], nextCursor: null, dataRevision: 99 },
          loading: true,
          loadingMore: false,
          error: null,
        }}
        projectId="project-new"
        projectName="新项目"
        {...workbenchActions}
        collapsed={false}
        narrow={false}
        sheetOpen={false}
        pendingAction={null}
        onToggleCollapsed={() => undefined}
        onCloseSheet={() => undefined}
        onLoadMore={() => undefined}
        onRetry={() => undefined}
        onCopyAnswer={() => undefined}
        onStopSession={() => undefined}
      />,
    )
    expect(html).toContain('正在加载会话工作台')
    expect(html).not.toContain('旧项目不得出现')
  })

  it('presents the narrow workbench as a modal sheet with a reachable escape action', () => {
    const html = renderToStaticMarkup(
      <ConversationWorkbench
        state={{ ...initialAppState, qaPhase: 'listening', sessionId: 'session-active' }}
        workspace={{
          page: { projectId: 'project-1', totalRounds: 0, items: [], nextCursor: null, dataRevision: 3 },
          loading: false,
          loadingMore: false,
          error: null,
        }}
        projectId="project-1"
        projectName="窄屏项目"
        {...workbenchActions}
        collapsed={false}
        narrow
        sheetOpen
        pendingAction={null}
        onToggleCollapsed={() => undefined}
        onCloseSheet={() => undefined}
        onLoadMore={() => undefined}
        onRetry={() => undefined}
        onCopyAnswer={() => undefined}
        onStopSession={() => undefined}
      />,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="关闭会话工作台"')
    expect(html).toContain('停止监听')
  })

  it('shows the exact project and round count in both clear confirmations', () => {
    const first = renderToStaticMarkup(
      <WorkspaceConfirmationDialog
        confirmation={{ kind: 'clear', step: 1 }}
        projectName="政府报告项目"
        totalRounds={93}
        busy={false}
        busyLabel="正在处理…"
        error={null}
        onCancel={() => undefined}
        onAdvanceClear={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    const second = renderToStaticMarkup(
      <WorkspaceConfirmationDialog
        confirmation={{ kind: 'clear', step: 2 }}
        projectName="政府报告项目"
        totalRounds={93}
        busy={false}
        busyLabel="正在处理…"
        error={null}
        onCancel={() => undefined}
        onAdvanceClear={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(first).toContain('这是第一次确认')
    expect(first).toContain('政府报告项目')
    expect(first).toContain('93 轮')
    expect(second).toContain('请再次确认清空')
    expect(second).toContain('确认清空 93 轮')

    const single = renderToStaticMarkup(
      <WorkspaceConfirmationDialog
        confirmation={{ kind: 'delete', roundId: 'round-8', roundLabel: '第 8 轮' }}
        projectName="政府报告项目"
        totalRounds={93}
        busy={false}
        busyLabel="正在处理…"
        error={null}
        onCancel={() => undefined}
        onAdvanceClear={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(single).toContain('删除这一轮')
    expect(single).toContain('当前项目：政府报告项目')
    expect(single).toContain('删除第 8 轮')

    const busy = renderToStaticMarkup(
      <WorkspaceConfirmationDialog
        confirmation={{ kind: 'delete', roundId: 'round-8', roundLabel: '第 8 轮' }}
        projectName="政府报告项目"
        totalRounds={93}
        busy
        busyLabel="正在核对最新轮次…"
        error={null}
        onCancel={() => undefined}
        onAdvanceClear={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(busy).toContain('正在核对最新轮次…')
    expect(busy).toContain('role="alertdialog"')
    expect(busy).toContain('tabindex="-1"')
    expect(busy.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(3)
  })
})
