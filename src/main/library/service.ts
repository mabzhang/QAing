import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import type { DocumentSummary } from '../../core/contracts'
import type { LibraryService } from '../app/facade'
import type { DataStore } from '../data/database'
import type {
  SourceDocumentFormat,
  StructuredQaFormat,
  StructuredQaTemplate,
} from '../data/importers'
import { parseStructuredQaDocument, validateAndDedupeQa } from '../data/importers'
import type { KnowledgeRepository } from '../data/repository'
import type { EmbeddingIndexer } from '../data/vector'

const MAX_IMPORT_BYTES = 10 * 1024 * 1024
const MAX_SELECTION_FILES = 32
const MAX_SELECTION_BYTES = 40 * 1024 * 1024
const MAX_BACKGROUND_BATCHES = 313

function sourceFormat(path: string): SourceDocumentFormat {
  return extname(path).toLocaleLowerCase() === '.md' || extname(path).toLocaleLowerCase() === '.markdown'
    ? 'markdown'
    : 'text'
}

function qaFormat(path: string): StructuredQaFormat {
  const extension = extname(path).toLocaleLowerCase()
  if (extension === '.json') return 'json'
  if (extension === '.tsv') return 'tsv'
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  return 'csv'
}

function qaPreviewFormat(template: StructuredQaTemplate): string {
  switch (template) {
    case 'markdown_heading': return 'Markdown 模板 A'
    case 'markdown_numbered': return 'Markdown 模板 B'
    case 'markdown_review_report': return 'Markdown 模板 C（评审汇总）'
    case 'json': return 'JSON'
    case 'csv': return 'CSV'
    case 'tsv': return 'TSV'
  }
}

interface SelectedText {
  readonly path: string
  readonly content: string
  readonly bytes: number
}

async function readSelectedTexts(paths: readonly string[]): Promise<readonly SelectedText[]> {
  if (paths.length < 1 || paths.length > MAX_SELECTION_FILES) throw new Error('IMPORT_SELECTION_SIZE_INVALID')
  let totalBytes = 0
  const selected: SelectedText[] = []
  for (const path of paths) {
    const item = await readSelectedText(path)
    totalBytes += item.bytes
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SELECTION_BYTES) {
      throw new Error('IMPORT_SELECTION_SIZE_INVALID')
    }
    selected.push(item)
  }
  return selected
}

/**
 * The final path component must be a regular non-symlink file. Validation and
 * bounded reading use the same descriptor, closing the stat/read TOCTOU gap.
 */
async function readSelectedText(path: string): Promise<SelectedText> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > MAX_IMPORT_BYTES) {
      throw new Error('IMPORT_FILE_SIZE_INVALID')
    }
    const buffer = Buffer.allocUnsafe(before.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat()
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('IMPORT_FILE_CHANGED_DURING_READ')
    }
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
    } catch {
      throw new Error('IMPORT_FILE_ENCODING_INVALID')
    }
    return { path, content, bytes: offset }
  } finally {
    await handle.close()
  }
}

export class DesktopLibraryService implements LibraryService {
  readonly #window: BrowserWindow
  readonly #store: DataStore
  readonly #indexer: Pick<EmbeddingIndexer, 'indexPending'>
  readonly #knowledge: KnowledgeRepository
  readonly #onIndexStateChanged: (() => void) | undefined
  readonly #indexController = new AbortController()
  #indexingScheduled = false
  #indexingTask: Promise<void> | null = null
  #disposed = false
  #disposeTask: Promise<void> | null = null

  constructor(input: {
    readonly window: BrowserWindow
    readonly store: DataStore
    readonly indexer: Pick<EmbeddingIndexer, 'indexPending'>
    readonly knowledge: KnowledgeRepository
    readonly onIndexStateChanged?: () => void
  }) {
    this.#window = input.window
    this.#store = input.store
    this.#indexer = input.indexer
    this.#knowledge = input.knowledge
    this.#onIndexStateChanged = input.onIndexStateChanged
    this.#window.once('closed', () => { void this.dispose() })
  }

  async listDocuments(): Promise<readonly DocumentSummary[]> {
    const jobs = this.#store.listIndexJobs()
    const jobByOwner = new Map(jobs.map((job) => [`${job.ownerType}:${job.ownerId}`, job]))
    const chunksByDocument = new Map<string, Array<ReturnType<DataStore['listChunks']>[number]>>()
    for (const chunk of this.#store.listChunks()) {
      let chunks = chunksByDocument.get(chunk.documentId)
      if (!chunks) {
        chunks = []
        chunksByDocument.set(chunk.documentId, chunks)
      }
      chunks.push(chunk)
    }
    const documents = this.#store.listDocuments().map((document): DocumentSummary => {
      const chunks = chunksByDocument.get(document.id) ?? []
      const states = chunks.map((chunk) => jobByOwner.get(`chunk:${chunk.id}`)?.status ?? 'pending')
      const failed = states.some((status) => status === 'failed')
      const indexed = chunks.length > 0 && chunks.every((chunk) => chunk.embedding !== null)
      return {
        id: document.id,
        title: document.title,
        kind: document.kind === 'front_transcript' ? 'front_recording' : 'source_document',
        status: failed ? 'failed' : indexed ? 'indexed' : 'pending',
        chunkCount: chunks.length,
        createdAt: document.updatedAt,
        error: failed ? 'INDEX_FAILED' : null,
      }
    })
    const qa = this.#store.listPresetQa().map((record): DocumentSummary => {
      const job = jobByOwner.get(`preset_qa:${record.id}`)
      return {
        id: record.id,
        title: record.question,
        kind: 'preset_qa',
        status: job?.status === 'failed' ? 'failed' : record.embedding ? 'indexed' : 'pending',
        chunkCount: 1,
        createdAt: record.updatedAt,
        error: job?.status === 'failed' ? 'INDEX_FAILED' : null,
      }
    })
    return [...documents, ...qa].sort((left, right) => right.createdAt - left.createdAt)
  }

  dispose(): Promise<void> {
    this.#disposeTask ??= this.#disposeOnce()
    return this.#disposeTask
  }

  async #disposeOnce(): Promise<void> {
    this.#disposed = true
    this.#indexingScheduled = false
    this.#indexController.abort(new Error('LIBRARY_SERVICE_DISPOSED'))
    try {
      await this.#indexingTask
    } catch {
      // The background task already preserves SQLite/FTS and translates model
      // failures to keyword fallback; disposal only waits for it to settle.
    }
  }

  async importSourceDocuments(): Promise<readonly DocumentSummary[]> {
    const selection = await dialog.showOpenDialog(this.#window, {
      title: '导入原始资料',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文本与 Markdown', extensions: ['txt', 'md', 'markdown'] }],
    })
    if (selection.canceled) return this.listDocuments()
    if (selection.filePaths.length === 0) return this.listDocuments()
    const selected = await readSelectedTexts(selection.filePaths)
    this.#knowledge.importSourceDocumentsDeferred(selected.map((item) => ({
        title: basename(item.path),
        format: sourceFormat(item.path),
        content: item.content,
        sourceUri: item.path,
    })))
    this.#scheduleIndexing()
    return this.listDocuments()
  }

  async importPresetQa(): Promise<readonly DocumentSummary[]> {
    const selection = await dialog.showOpenDialog(this.#window, {
      title: '导入预设 QA',
      message: '预设 QA 会作为高优先级答案库，必须是结构化 JSON/CSV/TSV 或严格 Markdown。',
      buttonLabel: '检查并导入',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'QA 数据', extensions: ['json', 'csv', 'tsv', 'md', 'markdown'] }],
    })
    if (selection.canceled) return this.listDocuments()
    if (selection.filePaths.length === 0) return this.listDocuments()
    const selected = await readSelectedTexts(selection.filePaths)
    const sources = selected.map((item) => ({
      rawContent: item.content,
      format: qaFormat(item.path),
    }))
    const parsedDocuments = sources.map((source) => (
      parseStructuredQaDocument(source.rawContent, source.format)
    ))
    const parsed = validateAndDedupeQa(parsedDocuments.flatMap((document) => document.items))
    // Preview and commit use the same normalized/deduplicated records. Check
    // reviewed-answer conflicts before asking the user to confirm; the commit
    // transaction repeats this check to close the confirmation TOCTOU window.
    this.#store.assertPresetQaBatchHasNoConflicts(parsed)
    const formats = [...new Set(parsedDocuments.map((document) => qaPreviewFormat(document.template)))].join(' / ')
    const preview = await dialog.showMessageBox(this.#window, {
      type: 'question',
      title: '确认导入预设 QA',
      message: `已严格检查 ${sources.length} 个文件，去重后共 ${parsed.length} 条问答。`,
      detail: `识别格式：${formats}。确认后将写入高优先级预设 QA 库；取消则零写入，原始资料库不受影响。`,
      buttons: ['取消', `导入 ${parsed.length} 条`],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    })
    if (preview.response !== 1) return this.listDocuments()
    this.#knowledge.importPreparedStructuredQaBatch(parsed)
    this.#scheduleIndexing()
    return this.listDocuments()
  }

  async deleteDocument(documentId: string): Promise<void> {
    const document = this.#store.getDocument(documentId)
    if (document) {
      this.#knowledge.deleteDocument(documentId)
      return
    }
    if (this.#store.getPresetQa(documentId)) {
      this.#knowledge.deletePresetQa(documentId)
      return
    }
    throw new Error('DOCUMENT_NOT_FOUND')
  }

  #scheduleIndexing(): void {
    if (this.#disposed) return
    this.#indexingScheduled = true
    if (this.#indexingTask) return
    queueMicrotask(() => {
      if (this.#disposed || this.#indexingTask || !this.#indexingScheduled) return
      this.#indexingScheduled = false
      this.#indexingTask = this.#drainPendingIndexJobs()
        .catch(() => {
          // SQLite/FTS import has already committed. Worker failures are an
          // explicit keyword-fallback state and must never become unhandled.
        })
        .finally(() => {
          this.#indexingTask = null
          if (!this.#disposed) this.#onIndexStateChanged?.()
          if (!this.#disposed && this.#indexingScheduled) this.#scheduleIndexing()
        })
    })
  }

  async #drainPendingIndexJobs(): Promise<void> {
    let previousRemaining = Number.POSITIVE_INFINITY
    for (let batch = 0; batch < MAX_BACKGROUND_BATCHES; batch += 1) {
      const result = await this.#indexer.indexPending({ limit: 64, signal: this.#indexController.signal })
      if (result.remaining < 1) return
      if (result.indexed < 1 && result.failed < 1 && result.remaining >= previousRemaining) return
      previousRemaining = result.remaining
    }
  }
}
