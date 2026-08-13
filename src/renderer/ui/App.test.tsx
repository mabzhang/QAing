import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from '../App'
import { initialAppState } from '../../core/state-machine'
import type {
  AppState,
  QaAnswerVersion,
  QaWorkspacePage,
  QaWorkspaceRound,
} from '../../core/types'
import type { AppProps, ProjectUiState, UiAdapter, UiEnvironment } from './contracts'
import { KnowledgeDrawer } from './KnowledgeDrawer'
import { SettingsDrawer } from './SettingsDrawer'
import { HistoryDrawer } from './HistoryDrawer'

const adapter: UiAdapter = {
  switchMode: () => undefined,
  selectAudioSource: () => undefined,
  start: () => undefined,
  stopSession: () => undefined,
  stopFront: () => undefined,
  acknowledgeFrontComplete: () => undefined,
  endQuestion: () => undefined,
  endAnswer: () => undefined,
  skipQuestion: () => undefined,
  retry: () => undefined,
  dismissError: () => undefined,
  copyAnswer: () => undefined,
  configureProvider: () => undefined,
  clearProvider: () => undefined,
  openPermission: () => undefined,
  requestAudioPermission: () => Promise.resolve({ status: 'granted' }),
  restartApplication: () => undefined,
  importSourceDocuments: () => undefined,
  importPresetQa: () => undefined,
  deleteDocument: () => undefined,
  setAlwaysOnTop: () => undefined,
  selectProjectRoot: () => undefined,
  activateProject: () => undefined,
  confirmProjectDirectories: () => undefined,
  cancelProjectPreparation: () => undefined,
  startProjectSync: () => undefined,
  cancelProjectSync: () => undefined,
  retryFailedProjectSync: () => undefined,
  relocateProject: () => undefined,
  setProjectSyncPolicy: () => undefined,
  setProjectTaskFilter: () => undefined,
  loadMoreProjectTasks: () => undefined,
  exportProjectDiagnostics: () => undefined,
}

const environment: UiEnvironment = {
  permissions: { microphone: 'granted', system: 'granted' },
  captureHealth: 'healthy',
  alwaysOnTop: false,
  retrievalMode: 'hybrid',
  retrievalHealth: 'ready',
  knowledgeBase: { presetQaCount: 25, sourceDocumentCount: 8, pendingIndexJobs: 1 },
  providerStatuses: {
    deepseek: { configured: true, maskedKey: '••••D33P' },
    doubao_asr: { configured: false, maskedKey: null },
    embedding: { configured: true, maskedKey: '本地 ONNX 模型' },
  },
  documents: [
    {
      id: 'doc-1',
      title: '年度路演资料.md',
      kind: 'source_document',
      chunkCount: 18,
      indexStatus: 'ready',
      updatedAt: 1_786_500_000_000,
      error: null,
    },
    {
      id: 'qa-1',
      title: '管理层问答清单.xlsx',
      kind: 'preset_qa',
      chunkCount: 42,
      indexStatus: 'pending',
      updatedAt: 1_786_400_000_000,
      error: null,
    },
  ],
}

const DEFAULT_PROJECT_KNOWLEDGE = {
  usableDocumentSources: 8,
  usablePresetQaSources: 1,
  usablePresetQaItems: 25,
} as const

const DEFAULT_PROJECT_SIMPLE_STATUS = {
  readiness: 'hybrid_ready',
  activity: 'idle',
  attention: 'none',
  pendingChanges: 0,
  issueCount: 0,
  detailsRecommended: false,
} as const

const workspaceProps: Pick<AppProps,
  | 'qaWorkspace'
  | 'onLoadMoreQaWorkspace'
  | 'onRetryQaWorkspace'
  | 'onDeleteQaWorkspaceRound'
  | 'onClearQaWorkspaceProject'
  | 'onExportQaWorkspaceProject'
> = {
  qaWorkspace: { page: null, loading: false, loadingMore: false, error: null },
  onLoadMoreQaWorkspace: () => undefined,
  onRetryQaWorkspace: () => undefined,
  onDeleteQaWorkspaceRound: () => undefined,
  onClearQaWorkspaceProject: () => undefined,
  onExportQaWorkspaceProject: () => undefined,
} as const

function answerVersion(patch: Partial<QaAnswerVersion> = {}): QaAnswerVersion {
  return {
    id: 'version-1',
    roundId: 'round-1',
    ordinal: 0,
    stage: 'final',
    questionRevision: 1,
    questionSnapshot: '今年的收入增长是多少？',
    questionIdentity: '今年的收入增长是多少？',
    answer: '根据年度路演资料，公司收入同比增长 18%。',
    retrievalRoute: 'source_document',
    sources: [{
      id: 'source-1',
      documentId: 'doc-1',
      title: '年度路演资料',
      kind: 'source_document',
      excerpt: '全年收入同比增长 18%。',
      score: 0.97,
    }],
    elapsedMs: 5_800,
    createdAt: 1_786_500_006_000,
    isSelected: true,
    isSuperseded: false,
    answerUnchanged: false,
    ...patch,
  }
}

function workspaceRound(patch: Partial<QaWorkspaceRound> = {}): QaWorkspaceRound {
  return {
    id: 'round-1',
    sessionId: 'session-1',
    ordinal: 1,
    status: 'answer_locked',
    questionPreview: '今年的收入增长是多少？',
    startedAt: 1_786_500_000_000,
    completedAt: null,
    selectedAnswerVersionId: 'version-1',
    versions: [answerVersion()],
    ...patch,
  }
}

const workspaceProject = {
  id: 'project-1',
  displayName: '演示项目',
  lampStatus: 'synced',
  lastCompletedScanAt: 1_786_500_000_000,
  knowledgeVersion: 1,
  syncPolicy: 'auto_check_confirm',
  semanticIndex: { status: 'ready', readyItems: 1, pendingItems: 0, failedItems: 0 },
  knowledgeSummary: DEFAULT_PROJECT_KNOWLEDGE,
  simpleStatus: DEFAULT_PROJECT_SIMPLE_STATUS,
} as const

const workspaceProjectState: ProjectUiState = {
  projects: [workspaceProject],
  activeProjectId: workspaceProject.id,
  activeProject: workspaceProject,
  run: null,
  counts: { added: 0, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 0, completed: 0, total: 0 },
  taskPage: null,
  taskFilter: 'all',
  directoryConfirmation: null,
  loading: false,
  loadingMore: false,
  errorCode: null,
}

function workspaceWith(
  rounds: readonly QaWorkspaceRound[],
  patch: Partial<QaWorkspacePage> = {},
): typeof workspaceProps & Pick<AppProps, 'project'> {
  return {
    ...workspaceProps,
    qaWorkspace: {
      page: { projectId: workspaceProject.id, totalRounds: rounds.length, items: rounds, nextCursor: null, dataRevision: 1, ...patch },
      loading: false,
      loadingMore: false,
      error: null,
    },
    project: { state: workspaceProjectState },
  }
}

function stateWith(patch: Partial<AppState>): AppState {
  return { ...initialAppState, ...patch }
}

describe('renderer UI server render', () => {
  it('renders a locked answer with evidence and committed context', () => {
    const state = stateWith({
      qaPhase: 'answer_locked',
      sessionId: 'session-1',
      activeRoundId: 'round-1',
      finalSegments: ['今年的收入增长是多少？'],
      lockedAnswer: '根据年度路演资料，公司收入同比增长 18%。',
      sources: [{
        id: 'source-1',
        documentId: 'doc-1',
        title: '年度路演资料',
        kind: 'source_document',
        excerpt: '全年收入同比增长 18%。',
        score: 0.97,
      }],
      history: [{
        id: 'turn-1',
        question: '上一个问题',
        answer: '上一轮答案',
        sourceIds: ['source-1'],
        answerOrigin: 'final',
        createdAt: 1_786_500_000_000,
      }],
    })
    const html = renderToStaticMarkup(
      <App state={state} environment={environment} adapter={adapter} {...workspaceWith([workspaceRound()])} />,
    )
    expect(html).toContain('答案已锁定')
    expect(html).toContain('公司收入同比增长 18%')
    expect(html).toContain('年度路演资料')
    expect(html).toContain('回答结束')
    expect(html).toContain('aria-label="复制最终"')
  })

  it('labels keyword fallback and permission denial without presenting a startable empty session', () => {
    const degradedEnvironment: UiEnvironment = {
      ...environment,
      permissions: { microphone: 'granted', system: 'denied' },
      retrievalMode: 'keyword_fallback',
    }
    const html = renderToStaticMarkup(
      <App state={initialAppState} environment={degradedEnvironment} adapter={adapter} {...workspaceProps} />,
    )
    expect(html).toContain('关键词检索降级')
    expect(html).toContain('系统音频权限不可用')
    expect(html).toContain('class="primary-action-button primary-action-button--qa" disabled=""')
    expect(html).toContain('<span>开始监听</span>')
  })

  it('renders secure provider status and knowledge management drawers without plaintext credentials', () => {
    const settingsHtml = renderToStaticMarkup(
      <SettingsDrawer
        section="general"
        environment={environment}
        pendingAction={null}
        actionError={null}
        mutationLocked={false}
        onClose={() => undefined}
        onConfigureProvider={() => undefined}
        onClearProvider={() => undefined}
        onOpenPermission={() => undefined}
        onRequestAudioPermission={() => undefined}
        onRestartApplication={() => undefined}
        permissionRequestResults={{}}
        onSetAlwaysOnTop={() => undefined}
      />,
    )
    expect(settingsHtml).toContain('凭据仅提交给主进程安全存储')
    expect(settingsHtml).toContain('••••D33P')
    expect(settingsHtml.match(/type="password"/g)).toHaveLength(2)
    expect(settingsHtml).toContain('bge-large-zh-v1.5')
    expect(settingsHtml).toContain('固定的本地中文语义向量模型，不需要 API Key')
    expect(settingsHtml).not.toContain('provider-embedding')
    expect(settingsHtml).not.toContain('sk-')
    expect(settingsHtml).toContain('默认不置顶')
    expect(settingsHtml).toContain('role="switch"')
    expect(settingsHtml).toContain('已关闭')

    const knowledgeHtml = renderToStaticMarkup(
      <KnowledgeDrawer
        environment={environment}
        project={{ activeProjectId: null, activeProject: null, loading: false }}
        pendingAction={null}
        actionError={null}
        mutationLocked={false}
        onClose={() => undefined}
        onOpenProjectCenter={() => undefined}
        onImportSourceDocuments={() => undefined}
        onImportPresetQa={() => undefined}
        onDeleteDocument={() => undefined}
      />,
    )
    expect(knowledgeHtml).toContain('导入原始资料')
    expect(knowledgeHtml).toContain('入库后可立即关键词检索')
    expect(knowledgeHtml).toContain('JSON / CSV / TSV / Markdown')
    expect(knowledgeHtml).toContain('管理层问答清单.xlsx')
    expect(knowledgeHtml).toContain('待索引')
    expect(knowledgeHtml).toContain('aria-label="删除 年度路演资料.md"')
  })

  it('makes the knowledge drawer project-managed and removes legacy mutations for an active project', () => {
    const activeProject = {
      id: 'project-managed',
      displayName: '政府报告项目',
      lampStatus: 'synced',
      lastCompletedScanAt: 1_786_500_000_000,
      knowledgeVersion: 12,
      syncPolicy: 'auto_check_confirm',
      semanticIndex: { status: 'ready', readyItems: 154, pendingItems: 0, failedItems: 0 },
      knowledgeSummary: DEFAULT_PROJECT_KNOWLEDGE,
      simpleStatus: DEFAULT_PROJECT_SIMPLE_STATUS,
    } as const
    const html = renderToStaticMarkup(
      <KnowledgeDrawer
        environment={environment}
        project={{ activeProjectId: activeProject.id, activeProject, loading: false }}
        pendingAction={null}
        actionError={null}
        mutationLocked={false}
        onClose={() => undefined}
        onOpenProjectCenter={() => undefined}
        onImportSourceDocuments={() => undefined}
        onImportPresetQa={() => undefined}
        onDeleteDocument={() => undefined}
      />,
    )
    expect(html).toContain('只读取当前项目转换资料库')
    expect(html).toContain('政府报告项目')
    expect(html).toContain('打开项目同步中心')
    expect(html).toContain('此处不展示跨项目的旧导入记录')
    expect(html).not.toContain('导入原始资料')
    expect(html).not.toContain('导入预设 QA')
    expect(html).not.toContain('document-delete')
    expect(html).not.toContain('年度路演资料.md')
  })

  it('renders truthful connecting state, a top-level real meter, and an enabled escape action', () => {
    const state = stateWith({
      qaPhase: 'listening',
      sessionId: 'session-1',
      activeRoundId: 'round-1',
      audioSource: 'microphone',
    })
    const connectingEnvironment = { ...environment, captureHealth: 'starting' as const }
    const html = renderToStaticMarkup(
      <App
        state={state}
        environment={connectingEnvironment}
        adapter={adapter}
        {...workspaceProps}
        audioLevels={[{
          sessionId: 'session-1',
          source: 'microphone',
          sequence: 2,
          timestampMs: 1_786_500_000_000,
          level: 0.37,
        }]}
      />,
    )
    expect(html).toContain('连接中')
    expect(html).not.toContain('LIVE')
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-valuenow="0"')
    const heroStart = html.indexOf('class="session-hero ')
    const heroEnd = html.indexOf('</section>', heroStart)
    const meter = html.indexOf('role="meter"')
    expect(heroStart).toBeGreaterThanOrEqual(0)
    expect(meter).toBeGreaterThan(heroStart)
    expect(meter).toBeLessThan(heroEnd)
    expect(html.match(/role="meter"/g)).toHaveLength(1)
    expect(html).toContain('>停止监听</button>')
    expect(html).not.toContain('secondary-action-button secondary-action-button--stop" disabled')
  })

  it('keeps the stable candidate visible while updating and during final verification', () => {
    const candidate = stateWith({
      qaPhase: 'listening',
      sessionId: 'session-1',
      revision: 8,
      candidateAnswer: '这是已完整发布的稳定候选。',
      candidateRevision: 7,
      candidateQuestion: '旧版但完整的问题',
      candidateUpdating: true,
      candidateSources: [{
        id: 'candidate-source',
        documentId: 'doc-1',
        title: '候选来源',
        kind: 'source_document',
        excerpt: '只用于候选阶段的证据。',
        score: 0.91,
      }],
      finalSegments: ['最新问题内容'],
    })
    const listeningHtml = renderToStaticMarkup(
      <App
        state={candidate}
        environment={environment}
        adapter={adapter}
        {...workspaceWith([workspaceRound({
          status: 'active',
          selectedAnswerVersionId: null,
          versions: [answerVersion({
            stage: 'candidate',
            questionRevision: 7,
            questionSnapshot: '旧版但完整的问题',
            answer: '这是已完整发布的稳定候选。',
            sources: [{
              id: 'candidate-source',
              documentId: 'doc-1',
              title: '候选来源',
              kind: 'source_document',
              excerpt: '只用于候选阶段的证据。',
              score: 0.91,
            }],
            isSelected: false,
          })],
        })])}
      />,
    )
    expect(listeningHtml).toContain('正在根据最新问题更新')
    expect(listeningHtml).toContain('这是已完整发布的稳定候选')
    expect(listeningHtml).toContain('候选来源')

    const finalizingHtml = renderToStaticMarkup(
      <App
        state={{
          ...candidate,
          qaPhase: 'finalizing',
          candidateUpdating: false,
          lockedQuestionRevision: 8,
          lockedQuestionIdentity: '最新问题内容',
        }}
        environment={environment}
        adapter={adapter}
        {...workspaceWith([workspaceRound({
          status: 'active',
          selectedAnswerVersionId: null,
          versions: [answerVersion({
            stage: 'candidate',
            questionRevision: 7,
            questionSnapshot: '旧版但完整的问题',
            answer: '这是已完整发布的稳定候选。',
            isSelected: false,
          })],
        })])}
      />,
    )
    expect(finalizingHtml).toContain('正在对锁定问题做最终核验')
    expect(finalizingHtml).toContain('这是已完整发布的稳定候选')
  })

  it('keeps an old candidate only as a clearly labelled historical version after final failure', () => {
    const state = stateWith({
      qaPhase: 'error',
      sessionId: 'session-1',
      activeRoundId: 'round-1',
      error: '最终生成失败',
      errorOperation: 'final',
      candidateAnswer: '不得显示的旧候选正文',
      candidateRevision: 3,
      candidateQuestion: '较早问题',
      candidateSources: [{
        id: 'stale-source',
        documentId: 'private-document',
        title: '不得显示的旧候选来源',
        kind: 'source_document',
        excerpt: '不得显示的旧候选摘要',
        score: 0.99,
      }],
      lockedQuestionRevision: 4,
      lockedQuestionIdentity: '已锁定问题',
      finalSegments: ['已锁定问题'],
    })
    const html = renderToStaticMarkup(
      <App
        state={state}
        environment={environment}
        adapter={adapter}
        {...workspaceWith([workspaceRound({
          status: 'active',
          selectedAnswerVersionId: null,
          versions: [answerVersion({
            stage: 'candidate',
            questionRevision: 3,
            questionSnapshot: '较早问题',
            answer: '不得冒充确定答案的旧候选正文',
            sources: [{
              id: 'stale-source',
              documentId: 'private-document',
              title: '旧候选来源',
              kind: 'source_document',
              excerpt: '旧候选摘要',
              score: 0.99,
            }],
            isSelected: false,
          })],
        })])}
      />,
    )
    expect(html).toContain('重新生成确定答案')
    expect(html).toContain('跳过本问')
    expect(html).toContain('仅保留基于早期问题快照的历史候选')
    expect(html).toContain('不得冒充确定答案的旧候选正文')
    expect(html).toContain('较早问题')
    expect(html).not.toContain('重试本轮')
  })

  it('labels an exact candidate fallback instead of implying final verification succeeded', () => {
    const state = stateWith({
      qaPhase: 'answer_locked',
      sessionId: 'session-1',
      activeRoundId: 'round-1',
      lockedAnswer: '与锁定问题完全一致的候选。',
      answerOrigin: 'candidate_fallback',
      lockedQuestionRevision: 5,
      lockedQuestionIdentity: '锁定问题',
    })
    const html = renderToStaticMarkup(
      <App
        state={state}
        environment={environment}
        adapter={adapter}
        {...workspaceWith([workspaceRound({
          versions: [answerVersion({
            stage: 'candidate_fallback',
            answer: '与锁定问题完全一致的候选。',
            questionRevision: 5,
          })],
        })])}
      />,
    )
    expect(html).toContain('候选降级答案')
    expect(html).toContain('最终核验未完成')
    expect(html).toContain('候选降级')
  })

  it('preserves a locked answer on commit failure and offers an operation-specific recovery', () => {
    const state = stateWith({
      qaPhase: 'error',
      sessionId: 'session-1',
      activeRoundId: 'round-1',
      error: '保存失败',
      errorOperation: 'commit',
      lockedAnswer: '已锁定且不应丢失的答案。',
      answerOrigin: 'final',
      lockedQuestionRevision: 8,
      lockedQuestionIdentity: '已锁定问题',
    })
    const html = renderToStaticMarkup(
      <App
        state={state}
        environment={environment}
        adapter={adapter}
        {...workspaceWith([workspaceRound({
          versions: [answerVersion({ answer: '已锁定且不应丢失的答案。' })],
        })])}
      />,
    )
    expect(html).toContain('已锁定且不应丢失的答案')
    expect(html).toContain('重新保存本轮')
    expect(html).toContain('结束会话')
    expect(html).not.toContain('跳过本问')
  })

  it('renders complete history details with origin, source count, time, and copy action', () => {
    const html = renderToStaticMarkup(
      <HistoryDrawer
        history={[{
          id: 'turn-1',
          question: '这是需要完整查看的长问题？',
          answer: '这是可复制的完整答案。',
          sourceIds: ['source-1', 'source-2'],
          answerOrigin: 'candidate_fallback',
          createdAt: 1_786_500_000_000,
        }]}
        initialTurnId="turn-1"
        pendingAction={null}
        actionError={null}
        onClose={() => undefined}
        onCopyAnswer={() => undefined}
      />,
    )
    expect(html).toContain('完整问题')
    expect(html).toContain('这是可复制的完整答案')
    expect(html).toContain('候选降级答案')
    expect(html).toContain('2 条已保存来源')
    expect(html).toContain('复制答案')
  })

  it('labels migrated workspace content as unverifiable legacy history', () => {
    const legacyRound = workspaceRound({
      id: 'legacy-round',
      status: 'completed',
      completedAt: 1_786_500_010_000,
      selectedAnswerVersionId: 'legacy-version',
      versions: [answerVersion({
        id: 'legacy-version',
        roundId: 'legacy-round',
        stage: 'legacy_committed',
        retrievalRoute: 'legacy_unknown',
        sources: [],
        answer: '升级前保存的答案。',
      })],
    })
    const html = renderToStaticMarkup(
      <App
        state={initialAppState}
        environment={environment}
        adapter={adapter}
        {...workspaceWith([legacyRound])}
      />,
    )
    expect(html).toContain('历史答案')
    expect(html).toContain('旧版记录')
    expect(html).toContain('生成路径未记录')
    expect(html).toContain('不代表已完成最终核验')
    expect(html).not.toContain('class="workbench-route-badge workbench-route-badge--document"')
  })

  it('does not render an empty QA workbench in front mode', () => {
    const html = renderToStaticMarkup(
      <App
        state={stateWith({ mode: 'front' })}
        environment={environment}
        adapter={adapter}
        {...workspaceWith([workspaceRound()])}
      />,
    )
    expect(html).not.toContain('id="qa-conversation-workbench"')
    expect(html).not.toContain('workbench-resize-handle')
    expect(html).toContain('dashboard-grid dashboard-grid--front')
  })

  it('wires the controlled project state into the persistent left context card', () => {
    const activeProject = {
      id: 'project-1',
      displayName: '政府报告项目',
      lampStatus: 'synced',
      lastCompletedScanAt: 1_786_500_000_000,
      knowledgeVersion: 9,
      syncPolicy: 'auto_check_confirm',
      semanticIndex: { status: 'pending', readyItems: 90, pendingItems: 3, failedItems: 0 },
      knowledgeSummary: DEFAULT_PROJECT_KNOWLEDGE,
      simpleStatus: DEFAULT_PROJECT_SIMPLE_STATUS,
    } as const
    const projectState: ProjectUiState = {
      projects: [activeProject],
      activeProjectId: activeProject.id,
      activeProject,
      run: null,
      counts: { added: 0, changed: 0, deleted: 0, awaitingAgent: 0, failed: 0, actionRequired: 0, completed: 0, total: 0 },
      taskPage: null,
      taskFilter: 'all',
      directoryConfirmation: null,
      loading: false,
      loadingMore: false,
      errorCode: null,
    }
    const html = renderToStaticMarkup(
      <App
        state={initialAppState}
        environment={environment}
        adapter={adapter}
        project={{ state: projectState }}
        {...workspaceProps}
      />,
    )
    expect(html).toContain('政府报告项目')
    expect(html).toContain('项目可用性：已同步')
    expect(html).toContain('语义索引补齐中')
    expect(html).toContain('知识版本')
    expect(html).toContain('当前项目转换资料库')
    expect(html).toContain('只读项目检索基座')
    expect(html).toContain('资料变更只通过项目同步中心')
    expect(html).toContain('打开项目同步中心')
  })

  it('renders one permission action per state and explicit restart recovery', () => {
    const permissionEnvironment: UiEnvironment = {
      ...environment,
      permissions: { microphone: 'denied', system: 'prompt' },
    }
    const html = renderToStaticMarkup(
      <SettingsDrawer
        section="permissions"
        environment={permissionEnvironment}
        pendingAction={null}
        actionError={null}
        mutationLocked={false}
        onClose={() => undefined}
        onConfigureProvider={() => undefined}
        onClearProvider={() => undefined}
        onOpenPermission={() => undefined}
        onRequestAudioPermission={() => undefined}
        onRestartApplication={() => undefined}
        permissionRequestResults={{ microphone: { status: 'restart_required', code: 'MICROPHONE_PERMISSION_RESTART_REQUIRED' } }}
        onSetAlwaysOnTop={() => undefined}
      />,
    )
    expect(html).toContain('申请权限')
    expect(html).toContain('打开系统设置')
    expect(html).toContain('完全退出并重开')
    expect(html).toContain('当前应用身份尚未生效')
    expect(html).not.toContain('MICROPHONE_PERMISSION_RESTART_REQUIRED')
  })
})
