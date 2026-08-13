import {
  BookOpen,
  CheckCircle2,
  CircleAlert,
  Database,
  FilePlus2,
  FileText,
  FolderCog,
  Loader2,
  Search,
  Table2,
  Trash2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DocumentIndexStatus, ProjectUiState, UiActionName, UiEnvironment } from './contracts'
import { DrawerShell } from './DrawerShell'
import { projectTimeLabel, safeProjectName, semanticIndexPresentation } from './project-ui'

interface KnowledgeDrawerProps {
  readonly environment: UiEnvironment
  readonly project: Pick<ProjectUiState, 'activeProjectId' | 'activeProject' | 'loading'>
  readonly pendingAction: UiActionName | null
  readonly actionError: string | null
  readonly mutationLocked: boolean
  readonly onClose: () => void
  readonly onOpenProjectCenter: () => void
  readonly onImportSourceDocuments: () => void
  readonly onImportPresetQa: () => void
  readonly onDeleteDocument: (documentId: string) => void
}

const INDEX_LABELS: Readonly<Record<DocumentIndexStatus, string>> = {
  ready: '可检索',
  pending: '待索引',
  failed: '需重试',
}

function documentDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '时间未知'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function IndexStatus({ status }: { readonly status: DocumentIndexStatus }): React.JSX.Element {
  const Icon = status === 'ready' ? CheckCircle2 : status === 'pending' ? Loader2 : CircleAlert
  return (
    <span className={`document-status document-status--${status}`}>
      <Icon aria-hidden="true" className={status === 'pending' ? 'spin' : undefined} />
      {INDEX_LABELS[status]}
    </span>
  )
}

export function KnowledgeDrawer({
  environment,
  project,
  pendingAction,
  actionError,
  mutationLocked,
  onClose,
  onOpenProjectCenter,
  onImportSourceDocuments,
  onImportPresetQa,
  onDeleteDocument,
}: KnowledgeDrawerProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const busy = pendingAction !== null
  const projectManaged = project.activeProjectId !== null
  const activeProject = project.activeProject
  const semantic = semanticIndexPresentation(activeProject?.semanticIndex.status ?? 'unavailable')
  const mutationsDisabled = busy || mutationLocked
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
  const documents = useMemo(
    () => projectManaged
      ? []
      : [...environment.documents]
        .filter((document) => !normalizedQuery || document.title.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
        .sort((left, right) => right.updatedAt - left.updatedAt),
    [environment.documents, normalizedQuery, projectManaged],
  )

  const confirmDelete = (documentId: string): void => {
    setPendingDeleteId(null)
    onDeleteDocument(documentId)
  }

  return (
    <DrawerShell
      title={projectManaged ? '当前项目资料库' : '本地资料库'}
      description={projectManaged
        ? '只读取当前项目转换资料库；资料变更统一通过项目同步中心。'
        : '导入、检查与管理预设 QA 和原始资料。'}
      icon={Database}
      busy={busy}
      actionError={actionError}
      onClose={onClose}
    >
      {mutationLocked ? (
        <div className="drawer-session-lock" role="status">
          <Database aria-hidden="true" />
          <span>{projectManaged
            ? '当前会话进行中：可查看已应用状态，同步发布需在会话结束后进行。'
            : '当前会话进行中：可查看资料，但需在本轮结束后导入或删除。'}</span>
        </div>
      ) : null}
      {projectManaged ? (
        <section className="knowledge-managed" aria-labelledby="knowledge-managed-title" aria-busy={project.loading}>
          <div className="knowledge-managed__icon"><FolderCog aria-hidden="true" /></div>
          <div className="knowledge-managed__copy">
            <span>Project managed</span>
            <h3 id="knowledge-managed-title">只读转换资料库</h3>
            <p>
              {activeProject === null
                ? project.loading ? '正在读取当前项目状态…' : '当前项目状态暂不可用，请前往同步中心重新检查。'
                : `${safeProjectName(activeProject.displayName)} 仅使用已校验并安全应用的转换产物。`}
            </p>
          </div>
          <div className="knowledge-managed__metrics" aria-label="当前项目知识状态">
            <div>
              <strong>{activeProject === null || activeProject.knowledgeVersion === null ? '—' : `K${activeProject.knowledgeVersion}`}</strong>
              <span>知识版本</span>
            </div>
            <div><strong>{activeProject?.semanticIndex.readyItems.toLocaleString('zh-CN') ?? '—'}</strong><span>语义已就绪</span></div>
            <div>
              <strong>{activeProject === null ? '—' : (activeProject.semanticIndex.pendingItems + activeProject.semanticIndex.failedItems).toLocaleString('zh-CN')}</strong>
              <span>语义待处理</span>
            </div>
          </div>
          <span className={`project-index-badge project-index-badge--${semantic.tone}`}>
            <Database aria-hidden="true" />
            {semantic.label}
          </span>
          <p className="knowledge-managed__note">
            此处不展示跨项目的旧导入记录，也不允许逐项删除。请在同步中心查看转换任务、失败原因与最后检查时间。
            {activeProject !== null ? ` 最后检查：${projectTimeLabel(activeProject.lastCompletedScanAt)}。` : ''}
          </p>
          <button type="button" className="knowledge-managed__cta" onClick={onOpenProjectCenter} disabled={busy}>
            <FolderCog aria-hidden="true" />
            打开项目同步中心
          </button>
        </section>
      ) : (
        <>
          <section className="knowledge-overview" aria-label="资料库概览">
        <div><span><Table2 aria-hidden="true" /></span><strong>{environment.knowledgeBase.presetQaCount.toLocaleString('zh-CN')}</strong><small>预设 QA</small></div>
        <div><span><FileText aria-hidden="true" /></span><strong>{environment.knowledgeBase.sourceDocumentCount.toLocaleString('zh-CN')}</strong><small>原始资料</small></div>
        <div className={environment.knowledgeBase.pendingIndexJobs > 0 ? 'has-warning' : ''}><span><Database aria-hidden="true" /></span><strong>{environment.knowledgeBase.pendingIndexJobs.toLocaleString('zh-CN')}</strong><small>待索引任务</small></div>
          </section>

          <section className="knowledge-imports" aria-labelledby="knowledge-import-title">
        <div className="drawer-section__heading">
          <div>
            <span>Import</span>
            <h3 id="knowledge-import-title">导入资料</h3>
          </div>
          <p>导入由主进程打开本机文件选择器，严格校验后再使用内容哈希幂等去重。</p>
        </div>
        <div className="import-actions">
          <button type="button" onClick={onImportSourceDocuments} disabled={mutationsDisabled}>
            {pendingAction === 'import-source-documents' ? <Loader2 aria-hidden="true" className="spin" /> : <FilePlus2 aria-hidden="true" />}
            <span><strong>导入原始资料</strong><small>TXT / Markdown：入库后可立即关键词检索，语义索引后台补齐</small></span>
          </button>
          <button type="button" onClick={onImportPresetQa} disabled={mutationsDisabled}>
            {pendingAction === 'import-preset-qa' ? <Loader2 aria-hidden="true" className="spin" /> : <Table2 aria-hidden="true" />}
            <span><strong>导入预设 QA</strong><small>JSON / CSV / TSV / Markdown：严格问题与答案结构</small></span>
          </button>
        </div>
          </section>

          <section className="document-manager" aria-labelledby="document-list-title">
        <div className="document-manager__toolbar">
          <div>
            <span>Documents</span>
            <h3 id="document-list-title">已入库内容</h3>
          </div>
          <label className="document-search">
            <Search aria-hidden="true" />
            <span className="sr-only">搜索资料标题</span>
            <input
              type="search"
              value={query}
              placeholder="搜索标题"
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
        </div>

        <div className="document-list" role="list">
          {documents.length ? documents.map((document) => {
            const confirming = pendingDeleteId === document.id
            return (
              <article key={document.id} className="document-row" role="listitem">
                <span className={`document-row__icon document-row__icon--${document.kind}`}>
                  {document.kind === 'preset_qa' ? <Table2 aria-hidden="true" /> : <FileText aria-hidden="true" />}
                </span>
                <div className="document-row__content">
                  <strong>{document.title}</strong>
                  <span>
                    {document.kind === 'preset_qa' ? '预设 QA' : document.kind === 'front_recording' ? '前置记录' : '原始资料'} · {document.chunkCount.toLocaleString('zh-CN')} 个分块 · {documentDate(document.updatedAt)}
                  </span>
                  {document.indexStatus === 'failed' ? (
                    <small className="document-row__error" role="status">索引未完成；原资料仍保留，可删除后重新导入。</small>
                  ) : null}
                </div>
                <IndexStatus status={document.indexStatus} />
                {confirming ? (
                  <div className="document-delete-confirm" role="group" aria-label={`确认删除 ${document.title}`}>
                    <span>同时删除派生分块与索引？</span>
                    <button type="button" onClick={() => { confirmDelete(document.id) }} disabled={mutationsDisabled}>确认</button>
                    <button type="button" onClick={() => { setPendingDeleteId(null) }} disabled={busy}>取消</button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="document-delete"
                    aria-label={`删除 ${document.title}`}
                    title="删除资料"
                    onClick={() => { setPendingDeleteId(document.id) }}
                    disabled={mutationsDisabled}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                )}
              </article>
            )
          }) : (
            <div className="document-empty">
              <BookOpen aria-hidden="true" />
              <strong>{normalizedQuery ? '没有匹配的资料' : '资料库还是空的'}</strong>
              <span>{normalizedQuery ? '请尝试其他标题关键词。' : '可导入原始资料或已审核的预设 QA。'}</span>
            </div>
          )}
        </div>
          </section>
        </>
      )}
    </DrawerShell>
  )
}
