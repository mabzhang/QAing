import type {
  QaWorkspaceClearResult,
  QaWorkspaceDeleteResult,
  QaWorkspacePageInput,
} from '../../core/contracts'
import type { QaAnswerVersion, QaWorkspaceChanged, QaWorkspacePage, QaWorkspaceRound } from '../../core/types'

export interface QaWorkspaceStore {
  getProject(projectId: string): { readonly displayName: string } | null
  getQaWorkspacePage(input: QaWorkspacePageInput & { readonly expectedDataRevision?: number }): QaWorkspacePage
  deleteQaWorkspaceRound(input: { readonly projectId: string; readonly roundId: string }): QaWorkspaceDeleteResult
  clearQaWorkspaceProject(projectId: string): QaWorkspaceClearResult
  beginQaWorkspaceExport(projectId: string): { readonly projectId: string; readonly snapshotRevision: number }
  getQaWorkspaceExportPage(input: {
    readonly projectId: string
    readonly snapshotRevision: number
    readonly cursor?: string | null
    readonly limit?: number
  }): QaWorkspacePage
}

export interface QaWorkspaceExportGateway {
  save(suggestedName: string, chunks: AsyncIterable<string>): Promise<void>
}

type WorkspaceListener = (event: QaWorkspaceChanged) => void

/**
 * Keeps large answer history off the high-frequency public snapshot path.
 * Mutations publish one lightweight revision event; pages are fetched only
 * when the workbench is open or a committed revision arrives.
 */
export class QaWorkspaceRuntime {
  readonly #store: QaWorkspaceStore
  readonly #listeners = new Set<WorkspaceListener>()
  readonly #exportGateway: QaWorkspaceExportGateway | undefined

  constructor(store: QaWorkspaceStore, exportGateway?: QaWorkspaceExportGateway) {
    this.#store = store
    this.#exportGateway = exportGateway
  }

  getPage(input: QaWorkspacePageInput): Promise<QaWorkspacePage> {
    return Promise.resolve(this.#store.getQaWorkspacePage(input))
  }

  deleteRound(projectId: string, roundId: string): Promise<QaWorkspaceDeleteResult> {
    const result = this.#store.deleteQaWorkspaceRound({ projectId, roundId })
    if (result.deleted) this.notify({ projectId, dataRevision: result.dataRevision, roundId, answerVersionId: null })
    return Promise.resolve(result)
  }

  clearProject(projectId: string): Promise<QaWorkspaceClearResult> {
    const result = this.#store.clearQaWorkspaceProject(projectId)
    if (result.deletedRounds > 0 || result.deletedTurns > 0) {
      this.notify({ projectId, dataRevision: result.dataRevision, roundId: null, answerVersionId: null })
    }
    return Promise.resolve(result)
  }

  async exportProject(projectId: string): Promise<void> {
    if (!this.#exportGateway) throw new Error('QA_WORKSPACE_EXPORT_UNAVAILABLE')
    const project = this.#store.getProject(projectId)
    if (!project) throw new Error('PROJECT_NOT_FOUND')
    const snapshot = this.#store.beginQaWorkspaceExport(projectId)
    await this.#exportGateway.save(
      `QAing-${safeFileName(project.displayName)}-会话工作台.md`,
      this.#exportChunks(project.displayName, snapshot),
    )
  }

  subscribe(listener: WorkspaceListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  notify(event: QaWorkspaceChanged): void {
    // Mutations are already committed before their revision is published.
    // A stale renderer must not make durable work look rejected or prevent
    // the remaining subscribers from observing the new revision.
    for (const listener of this.#listeners) {
      try { listener(event) } catch { /* SQLite remains canonical. */ }
    }
  }

  dispose(): void {
    this.#listeners.clear()
  }

  async *#exportChunks(
    projectName: string,
    snapshot: { readonly projectId: string; readonly snapshotRevision: number },
  ): AsyncGenerator<string> {
    yield `# QAing 会话工作台导出\n\n- 项目：${safeInline(projectName)}\n- 导出时间：${new Date().toISOString()}\n\n`
    let cursor: string | null = null
    do {
      const page = this.#store.getQaWorkspaceExportPage({
        projectId: snapshot.projectId,
        snapshotRevision: snapshot.snapshotRevision,
        ...(cursor === null ? {} : { cursor }),
        limit: 20,
      })
      if (page.projectId !== snapshot.projectId) throw new Error('QA_WORKSPACE_SCOPE_CHANGED')
      for (const round of page.items) yield roundMarkdown(round)
      cursor = page.nextCursor
    } while (cursor !== null)
  }
}

function safeFileName(value: string): string {
  return value.normalize('NFKC').replace(/[/:\\\0]/gu, '-').trim().slice(0, 80) || '未命名项目'
}

function safeInline(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim()
}

function versionMarkdown(version: QaAnswerVersion): string {
  const label = version.stage === 'final'
    ? '最终答案'
    : version.stage === 'candidate_fallback'
      ? '候选降级答案'
      : version.stage === 'legacy_committed'
        ? '历史答案'
        : `候选答案 ${String(version.ordinal + 1)}`
  return `### ${label}${version.isSelected ? '（已选定）' : ''}\n\n` +
    `**对应问题**\n\n${version.questionSnapshot}\n\n` +
    `**答案**\n\n${version.answer}\n\n` +
    `> 生成路径：${version.retrievalRoute}；来源数：${String(version.sources.length)}；时间：${new Date(version.createdAt).toISOString()}\n\n`
}

function roundMarkdown(round: QaWorkspaceRound): string {
  return `## 第 ${String(round.ordinal + 1)} 轮 · ${safeInline(round.status)}\n\n` +
    `**问题**\n\n${round.questionPreview}\n\n` +
    round.versions.map(versionMarkdown).join('') +
    '---\n\n'
}
