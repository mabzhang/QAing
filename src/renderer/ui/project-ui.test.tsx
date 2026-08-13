import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  ProjectDirectoryConfirmation,
  ProjectSummary,
  ProjectSyncRun,
  ProjectSyncTask,
} from '../../core/contracts'
import { ProjectContextCard } from './ProjectContextCard'
import { ProjectSyncDrawer } from './ProjectSyncDrawer'
import type { ProjectUiState } from './contracts'
import {
  PROJECT_PROGRESS_ANNOUNCEMENT_INTERVAL_MS,
  PROJECT_TASK_ERROR_HINTS,
  PROJECT_TASK_STATUS_LABELS,
  projectAnnouncementDelay,
  projectDirectoryPurpose,
  projectRunProgressLabel,
  projectSimpleStatusPresentation,
  projectSyncDisplay,
  projectStatusPresentation,
  projectTaskNeedsAttention,
  safeProjectPathLabel,
  semanticIndexPresentation,
} from './project-ui'

function project(patch: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'project-1',
    displayName: '政府报告项目',
    lampStatus: 'synced',
    lastCompletedScanAt: 1_786_500_000_000,
    knowledgeVersion: 7,
    syncPolicy: 'auto_check_confirm',
    semanticIndex: { status: 'ready', readyItems: 93, pendingItems: 0, failedItems: 0 },
    knowledgeSummary: { usableDocumentSources: 8, usablePresetQaSources: 1, usablePresetQaItems: 25 },
    simpleStatus: { readiness: 'hybrid_ready', activity: 'idle', attention: 'none', pendingChanges: 0, issueCount: 0, detailsRecommended: false },
    ...patch,
  }
}

function run(patch: Partial<ProjectSyncRun> = {}): ProjectSyncRun {
  return {
    id: 'run-1',
    projectId: 'project-1',
    status: 'running',
    stage: 'converting',
    completedItems: 2,
    totalItems: 5,
    startedAt: 1_786_500_001_000,
    completedAt: null,
    ...patch,
  }
}

function task(patch: Partial<ProjectSyncTask> = {}): ProjectSyncTask {
  return {
    id: 'task-1',
    projectId: 'project-1',
    runId: 'run-1',
    relativePath: '原始资料/评审报告.pdf',
    kind: 'source_document',
    conversionMode: 'external',
    status: 'awaiting_external_agent',
    lastGoodAvailable: true,
    requiresAction: true,
    errorCode: null,
    updatedAt: 1_786_500_002_000,
    ...patch,
  }
}

function projectState(patch: Partial<ProjectUiState> = {}): ProjectUiState {
  const activeProject = project({
    simpleStatus: {
      readiness: 'hybrid_ready',
      activity: 'updating',
      attention: 'action_required',
      pendingChanges: 3,
      issueCount: 1,
      detailsRecommended: true,
    },
  })
  return {
    projects: [activeProject],
    activeProjectId: activeProject.id,
    activeProject,
    run: run(),
    counts: {
      added: 2,
      changed: 1,
      deleted: 0,
      awaitingAgent: 1,
      failed: 0,
      actionRequired: 1,
      completed: 2,
      total: 5,
    },
    taskPage: { items: [task()], nextCursor: 'next-safe-cursor', dataRevision: 4 },
    taskFilter: 'all',
    directoryConfirmation: null,
    loading: false,
    loadingMore: false,
    errorCode: null,
    ...patch,
  }
}

const handlers = {
  onClose: () => undefined,
  onSelectRoot: () => undefined,
  onActivate: () => undefined,
  onConfirmDirectories: () => undefined,
  onCancelPreparation: () => undefined,
  onStartSync: () => undefined,
  onCancelSync: () => undefined,
  onRetryFailed: () => undefined,
  onRelocate: () => undefined,
  onSetPolicy: () => undefined,
  onSetFilter: () => undefined,
  onLoadMore: () => undefined,
  onExportDiagnostics: () => undefined,
} as const

describe('project context and sync center UI', () => {
  it('shows project availability and semantic-index health as independent labelled states', () => {
    const state = projectState({
      activeProject: project({
        lampStatus: 'changes_detected',
        semanticIndex: { status: 'degraded', readyItems: 90, pendingItems: 3, failedItems: 0 },
        simpleStatus: {
          readiness: 'hybrid_ready', activity: 'idle', attention: 'review_changes',
          pendingChanges: 3, issueCount: 0, detailsRecommended: true,
        },
      }),
    })
    const html = renderToStaticMarkup(
      <ProjectContextCard
        state={state}
        pendingAction={null}
        sessionLocked={false}
        onOpen={() => undefined}
        onSelectRoot={() => undefined}
        onActivate={() => undefined}
        onStartSync={() => undefined}
        onRelocate={() => undefined}
      />,
    )

    expect(html).toContain('项目可用性：发现待处理变化')
    expect(html).toContain('3 项变化待核对和应用')
    expect(html).toContain('语义索引降级')
    expect(html).toContain('3 待处理')
    expect(html).not.toContain('class="spin"')
  })

  it('keeps project switching disabled during a live session while retaining the bound version message', () => {
    const html = renderToStaticMarkup(
      <ProjectContextCard
        state={projectState()}
        pendingAction={null}
        sessionLocked
        onOpen={() => undefined}
        onSelectRoot={() => undefined}
        onActivate={() => undefined}
        onStartSync={() => undefined}
        onRelocate={() => undefined}
      />,
    )
    expect(html).toContain('<select aria-describedby="project-switch-lock-note" disabled=""')
    expect(html).toContain('当前轮继续使用已绑定版本')
  })

  it('keeps policy changes atomic and explains check-only versus automatic apply', () => {
    const html = renderToStaticMarkup(
      <ProjectSyncDrawer
        state={projectState()}
        pendingAction="set-project-sync-policy"
        actionError={null}
        sessionLocked={false}
        {...handlers}
      />,
    )
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('后台只检查；发现变化后等待你应用')
    expect(html).toContain('安全变化自动应用；删除与 QA 冲突仍需确认')
    expect(html.match(/type="radio"/gu)).toHaveLength(3)
    expect(html.match(/type="radio"[^>]+disabled=""/gu)).toHaveLength(3)
  })

  it('keeps a healthy no-change project concise and never infers exact counts from a task page', () => {
    const state = projectState({
      run: null,
      counts: { added: 0, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 0, completed: 0, total: 0 },
      taskPage: { items: [task({ status: 'ready', requiresAction: false })], nextCursor: null, dataRevision: 4 },
      activeProject: project({
        lampStatus: 'synced',
        knowledgeSummary: { usableDocumentSources: Number.NaN, usablePresetQaSources: 1, usablePresetQaItems: Number.NaN },
      }),
    })
    const html = renderToStaticMarkup(
      <ProjectSyncDrawer state={state} pendingAction={null} actionError={null} sessionLocked={false} {...handlers} />,
    )
    expect(html).toContain('资料可用性：已同步')
    expect(html).toContain('摘要暂不可用')
    expect(html).toContain('立即检查')
    expect(html).not.toContain('Pipeline')
    expect(html).not.toContain('上次成功版本可用')
    expect(html).not.toContain('知识版本 K')
    expect(html).not.toContain('导出诊断摘要')
  })

  it('shows exact project-scoped document and reviewed-QA counts only when supplied', () => {
    const state = projectState({
      run: null,
      counts: { added: 0, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 0, completed: 0, total: 0 },
      activeProject: project({
        lampStatus: 'synced',
        knowledgeSummary: { usableDocumentSources: 8, usablePresetQaSources: 1, usablePresetQaItems: 25 },
      }),
    })
    const html = renderToStaticMarkup(
      <ProjectSyncDrawer state={state} pendingAction={null} actionError={null} sessionLocked={false} {...handlers} />,
    )
    expect(html).toContain('8 份可用')
    expect(html).toContain('25 条已审阅')
    expect(html).not.toContain('语义索引已就绪')
  })

  it('does not render diagnostic detail before a project is selected', () => {
    const html = renderToStaticMarkup(
      <ProjectSyncDrawer
        state={projectState({ projects: [], activeProjectId: null, activeProject: null, run: null })}
        pendingAction={null}
        actionError={null}
        sessionLocked={false}
        {...handlers}
      />,
    )
    expect(html).toContain('选择项目文件夹')
    expect(html).not.toContain('Pipeline')
    expect(html).not.toContain('文件任务')
  })

  it('renders the complete sync journey without exposing raw content or absolute paths', () => {
    const html = renderToStaticMarkup(
      <ProjectSyncDrawer
        state={projectState()}
        pendingAction={null}
        actionError={null}
        sessionLocked={false}
        {...handlers}
      />,
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('项目同步中心')
    expect(html).toContain('扫描')
    expect(html).toContain('核对')
    expect(html).toContain('转换')
    expect(html).toContain('索引')
    expect(html).toContain('安全应用')
    expect(html).toContain('<strong>自动检查</strong>')
    expect(html).toContain('外部 Agent')
    expect(html).toContain('上次成功版本可用')
    expect(html).toContain('加载更多任务')
    expect(html.match(/aria-live="polite"/gu)).toHaveLength(1)
    expect(html).not.toContain('/Users/')
    expect(html).not.toContain('文档正文秘密')
  })

  it('shows a checked change set as waiting for apply instead of a green completed 0/4 pipeline', () => {
    const pendingTasks = Array.from({ length: 4 }, (_, index) => task({
      id: `pending-${index}`,
      conversionMode: 'local',
      status: 'needs_conversion',
      requiresAction: false,
    }))
    const state = projectState({
      activeProject: project({
        lampStatus: 'changes_detected',
        syncPolicy: 'auto_check_confirm',
        simpleStatus: {
          readiness: 'hybrid_ready', activity: 'idle', attention: 'review_changes',
          pendingChanges: 4, issueCount: 0, detailsRecommended: true,
        },
      }),
      run: run({ status: 'completed', stage: 'completed', completedItems: 0, totalItems: 4, completedAt: 1_786_500_004_000 }),
      counts: { added: 4, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 4, completed: 0, total: 4 },
      taskPage: { items: pendingTasks, nextCursor: null, dataRevision: 8 },
    })
    const display = projectSyncDisplay(state)
    const html = renderToStaticMarkup(
      <ProjectSyncDrawer state={state} pendingAction={null} actionError={null} sessionLocked={false} {...handlers} />,
    )

    expect(display).toMatchObject({ phase: 'waiting_apply', completedStages: ['scanning', 'reviewing'], progress: null })
    expect(html).toContain('检查完成，等待应用')
    expect(html).toContain('4 项变化待处理')
    expect(html).toContain('应用待处理变化')
    expect(html.match(/class="is-complete"/gu)).toHaveLength(2)
    expect(html).not.toContain('已完成 0 / 4')
    expect(html).not.toContain('<progress')
  })

  it('separates a no-change check, active synchronization, and a truly applied completion', () => {
    const noChange = projectState({
      activeProject: project({ lampStatus: 'synced' }),
      run: run({ status: 'completed', stage: 'completed', completedItems: 4, totalItems: 4, completedAt: 1_786_500_004_000 }),
      // A restored terminal run may no longer expose its transient converted
      // counter. The stable lamp/task states still prove this is not 0/4.
      counts: { added: 0, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 0, completed: 0, total: 4 },
      taskPage: { items: [task({ status: 'unchanged', conversionMode: 'local', requiresAction: false })], nextCursor: null, dataRevision: 9 },
    })
    expect(projectSyncDisplay(noChange)).toMatchObject({
      phase: 'checked_changes',
      label: '项目检查完成',
      completedStages: ['scanning', 'reviewing'],
      progress: null,
    })

    const syncing = projectState({
      run: run({ status: 'running', stage: 'converting', completedItems: 2, totalItems: 4 }),
      counts: { added: 4, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 0, completed: 2, total: 4 },
    })
    expect(projectSyncDisplay(syncing)).toMatchObject({
      phase: 'syncing',
      currentStage: 'converting',
      completedStages: ['scanning', 'reviewing'],
      progress: { value: 2, max: 4 },
    })

    const applied = projectState({
      activeProject: project({ lampStatus: 'synced' }),
      run: run({ status: 'completed', stage: 'completed', completedItems: 4, totalItems: 4, completedAt: 1_786_500_004_000 }),
      counts: { added: 4, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 0, completed: 0, total: 4 },
      taskPage: { items: [task({ status: 'ready', conversionMode: 'local', requiresAction: false })], nextCursor: null, dataRevision: 10 },
    })
    expect(projectSyncDisplay(applied)).toMatchObject({
      phase: 'completed',
      completedStages: ['scanning', 'reviewing', 'converting', 'indexing', 'applying'],
      progress: { value: 4, max: 4 },
    })
  })

  it('keeps manual Markdown validation failures red and explains validated manual success precisely', () => {
    const failedManual = projectState({
      activeProject: project({
        lampStatus: 'partial_failure',
        simpleStatus: {
          readiness: 'hybrid_ready', activity: 'idle', attention: 'partial_failure',
          pendingChanges: 0, issueCount: 1, detailsRecommended: true,
        },
      }),
      run: run({ status: 'completed', stage: 'completed', completedItems: 1, totalItems: 1, completedAt: 1_786_500_004_000 }),
      counts: { added: 1, changed: 0, deleted: 0, awaitingAgent: 0, failed: 1, actionRequired: 1, completed: 0, total: 1 },
      taskPage: {
        items: [task({ conversionMode: 'manual', status: 'failed', errorCode: 'OUTPUT_INVALID', requiresAction: true })],
        nextCursor: null,
        dataRevision: 11,
      },
    })
    const failedHtml = renderToStaticMarkup(
      <ProjectSyncDrawer state={failedManual} pendingAction={null} actionError={null} sessionLocked={false} {...handlers} />,
    )
    expect(projectSyncDisplay(failedManual)).toMatchObject({ phase: 'failed', failedStage: 'converting', progress: null })
    expect(failedHtml).toContain('手动 Markdown 未通过严格格式校验')
    expect(failedHtml).not.toContain('project-sync-stage--completed')

    const readyManual = projectState({
      activeProject: project({
        lampStatus: 'manual_ready',
        semanticIndex: { status: 'pending', readyItems: 0, pendingItems: 1, failedItems: 0 },
        simpleStatus: {
          readiness: 'keyword_ready', activity: 'idle', attention: 'none',
          pendingChanges: 0, issueCount: 0, detailsRecommended: false,
        },
      }),
      run: run({ status: 'completed', stage: 'completed', completedItems: 1, totalItems: 1, completedAt: 1_786_500_004_000 }),
      counts: { added: 1, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 0, completed: 1, total: 1 },
      taskPage: {
        items: [task({ conversionMode: 'manual', status: 'manual_ready', errorCode: null, requiresAction: false })],
        nextCursor: null,
        dataRevision: 12,
      },
    })
    const readyHtml = renderToStaticMarkup(
      <ProjectSyncDrawer state={readyManual} pendingAction={null} actionError={null} sessionLocked={false} {...handlers} />,
    )
    expect(readyHtml).toContain('资料可用性：资料库可用')
    expect(readyHtml).toContain('关键词检索可用，语义增强中')
    expect(readyHtml).not.toContain('资料可用性：手动转换已就绪')
    expect(readyHtml).toContain('语义索引补齐中')
    expect(readyHtml).toContain('手动 Markdown 已严格校验并提交')
  })

  it('renders tombstoned project tasks as removed instead of cancelled or actionable', () => {
    const removedTask = task({ status: 'removed', requiresAction: true, conversionMode: 'local' })
    const html = renderToStaticMarkup(
      <ProjectSyncDrawer
        state={projectState({
          taskPage: { items: [removedTask], nextCursor: null, dataRevision: 5 },
          counts: { ...projectState().counts, actionRequired: 0 },
        })}
        pendingAction={null}
        actionError={null}
        sessionLocked={false}
        {...handlers}
      />,
    )
    expect(html).toContain('project-task-state project-task-state--removed')
    expect(html).toContain('已移除')
    expect(html).not.toContain('project-task-row needs-attention')
    expect(html).not.toContain('已取消')
  })

  it('requires an explicit confirmation before creating the fixed project directories', () => {
    const confirmation: ProjectDirectoryConfirmation = {
      projectId: 'project-new',
      projectName: '新项目',
      directories: ['原始资料', '预设QA', '转换资料库/资料', '转换资料库/预设QA'],
    }
    const html = renderToStaticMarkup(
      <ProjectSyncDrawer
        state={projectState({ directoryConfirmation: confirmation })}
        pendingAction={null}
        actionError={null}
        sessionLocked={false}
        {...handlers}
      />,
    )
    expect(html).toContain('确认创建项目固定目录')
    expect(html).toContain('不会把相似文件夹静默当作输入根')
    expect(html).toContain('放置项目原始资料输入')
    expect(html).toContain('保存校验通过的标准问答产物')
    expect(html).toContain('创建并继续')
  })

  it('shows loading and load failure truthfully instead of claiming no project or no tasks', () => {
    const loadingHtml = renderToStaticMarkup(
      <ProjectContextCard
        state={projectState({ projects: [], activeProjectId: null, activeProject: null, loading: true })}
        pendingAction={null}
        sessionLocked={false}
        onOpen={() => undefined}
        onSelectRoot={() => undefined}
        onActivate={() => undefined}
        onStartSync={() => undefined}
        onRelocate={() => undefined}
      />,
    )
    expect(loadingHtml).toContain('aria-busy="true"')
    expect(loadingHtml).toContain('正在读取项目状态')
    expect(loadingHtml).not.toContain('项目可用性：尚未选择项目')

    const failedHtml = renderToStaticMarkup(
      <ProjectSyncDrawer
        state={projectState({ taskPage: null, errorCode: 'LOAD_FAILED' })}
        pendingAction={null}
        actionError={null}
        sessionLocked={false}
        {...handlers}
      />,
    )
    expect(failedHtml).toContain('任务列表暂时无法读取')
    expect(failedHtml).toContain('未把未知状态当作空列表')
    expect(failedHtml).not.toContain('暂无文件任务')
  })

  it('blocks project mutation and publication during a live session but keeps cancellation and diagnostics available', () => {
    const failedState = projectState({
      activeProject: project({
        simpleStatus: {
          readiness: 'hybrid_ready', activity: 'idle', attention: 'partial_failure',
          pendingChanges: 0, issueCount: 1, detailsRecommended: true,
        },
      }),
      run: run({ status: 'failed', stage: 'failed', completedAt: 1_786_500_004_000 }),
      counts: { ...projectState().counts, failed: 1 },
    })
    const html = renderToStaticMarkup(
      <ProjectSyncDrawer
        state={failedState}
        pendingAction={null}
        actionError={null}
        sessionLocked
        {...handlers}
      />,
    )

    expect(html).toContain('会话进行中不能切换项目')
    expect(html).toMatch(/<button[^>]+aria-expanded="false"[^>]+disabled="">更改<\/button>/u)
    expect(html).toMatch(/<button[^>]+class="is-primary"[^>]+disabled=""[^>]*>[\s\S]*?立即检查<\/button>/u)
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?重试失败项/u)
    expect(html).toContain('导出诊断摘要')
  })

  it('maps only bounded error codes to safe actionable copy', () => {
    expect(PROJECT_TASK_ERROR_HINTS.INPUT_SYMLINK_BLOCKED).toBe('符号链接输入已阻断')
    expect(PROJECT_TASK_ERROR_HINTS.CONVERTER_CRASHED).toBe('转换器异常退出')
    expect(projectStatusPresentation(null, 'PROJECT_ROOT_IDENTITY_CHANGED').detail).toContain('移动后的同一项目')
    expect(semanticIndexPresentation('failed').tone).toBe('danger')
    expect(safeProjectPathLabel('/Users/person/secret.md')).toBe('路径已隐藏')
    expect(safeProjectPathLabel('../secret.md')).toBe('路径已隐藏')
    expect(safeProjectPathLabel('原始\u202Efdp.exe')).toBe('路径已隐藏')
    expect(safeProjectPathLabel('原始资料/可公开标题.md')).toBe('原始资料/可公开标题.md')
  })

  it('defines icon-and-text presentations for every gray, green, yellow, and red lamp family', () => {
    expect(projectStatusPresentation(null, null)).toMatchObject({ tone: 'gray', label: '尚未选择项目' })
    expect(projectStatusPresentation(project({ lampStatus: 'synced' }), null)).toMatchObject({ tone: 'green', label: '已同步' })
    expect(projectStatusPresentation(project({ lampStatus: 'partial_failure' }), null)).toMatchObject({ tone: 'yellow', label: '部分项目未完成' })
    expect(projectStatusPresentation(project({ lampStatus: 'integrity_failed' }), null)).toMatchObject({ tone: 'red', label: '一致性校验失败' })
  })

  it('uses simpleStatus as the default truth even when restored lamp and task counters disagree', () => {
    const healthy = project({
      lampStatus: 'changes_detected',
      simpleStatus: {
        readiness: 'hybrid_ready', activity: 'idle', attention: 'none',
        pendingChanges: 0, issueCount: 0, detailsRecommended: false,
      },
    })
    expect(projectSimpleStatusPresentation(healthy, null)).toMatchObject({ tone: 'green', label: '已同步' })
    const html = renderToStaticMarkup(
      <ProjectSyncDrawer
        state={projectState({
          activeProject: healthy,
          run: run({ status: 'completed', stage: 'completed', completedAt: 1_786_500_004_000 }),
          counts: { added: 3, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 3, completed: 0, total: 3 },
        })}
        pendingAction={null}
        actionError={null}
        sessionLocked={false}
        {...handlers}
      />,
    )
    expect(html).toContain('资料可用性：已同步')
    expect(html).toContain('立即检查')
    expect(html).not.toContain('应用待处理变化')
    expect(html).not.toContain('Pipeline')
  })

  it('shows semantic status only when optimization or an index problem needs attention', () => {
    const healthyHtml = renderToStaticMarkup(
      <ProjectContextCard
        state={projectState({ activeProject: project() })}
        pendingAction={null}
        sessionLocked={false}
        onOpen={() => undefined}
        onSelectRoot={() => undefined}
        onActivate={() => undefined}
        onStartSync={() => undefined}
        onRelocate={() => undefined}
      />,
    )
    expect(healthyHtml).not.toContain('语义索引已就绪')

    const optimizingHtml = renderToStaticMarkup(
      <ProjectContextCard
        state={projectState({ activeProject: project({
          simpleStatus: {
            readiness: 'keyword_ready', activity: 'optimizing', attention: 'none',
            pendingChanges: 0, issueCount: 0, detailsRecommended: false,
          },
          semanticIndex: { status: 'pending', readyItems: 20, pendingItems: 5, failedItems: 0 },
        }) })}
        pendingAction={null}
        sessionLocked={false}
        onOpen={() => undefined}
        onSelectRoot={() => undefined}
        onActivate={() => undefined}
        onStartSync={() => undefined}
        onRelocate={() => undefined}
      />,
    )
    expect(optimizingHtml).toContain('语义索引补齐中')
  })

  it('presents removed and manual-ready tasks without false action requirements', () => {
    expect(PROJECT_TASK_STATUS_LABELS.removed).toBe('已移除')
    expect(PROJECT_TASK_STATUS_LABELS.manual_ready).toBe('手动转换已就绪')
    expect(projectTaskNeedsAttention(task({ status: 'removed', requiresAction: true }))).toBe(false)
    expect(projectTaskNeedsAttention(task({ status: 'manual_ready', requiresAction: true }))).toBe(false)
    expect(projectStatusPresentation(project({ lampStatus: 'manual_ready' }), null).detail).toContain('关键词检索可用')
  })

  it('caps progress announcements at two updates per second', () => {
    expect(PROJECT_PROGRESS_ANNOUNCEMENT_INTERVAL_MS).toBe(500)
    expect(projectAnnouncementDelay(1_000, 1_200)).toBe(300)
    expect(projectAnnouncementDelay(1_000, 1_500)).toBe(0)
    expect(projectAnnouncementDelay(1_000, 2_000)).toBe(0)
    expect(projectRunProgressLabel('cancelled', 3, 9)).toBe('已取消，本次已完成 3 项')
    expect(projectRunProgressLabel('cancel_requested', 3, null)).toBe('正在取消，已完成 3 项')
    expect(projectDirectoryPurpose('.qaing')).toContain('项目身份')
  })

  it('keeps the sync center responsive as a right sheet below 1120px', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
    expect(css).toContain('@media (max-width: 1119px)')
    expect(css).toContain('.project-sync-panel')
    expect(css).toContain('width: min(680px, calc(100vw - 34px));')
    expect(css).toContain('.project-context-card { grid-column: 1 / -1; }')
    expect(css).toContain('.project-context-primary')
    expect(css).toContain('min-height: 44px;')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
