import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { showOpenDialog, showMessageBox } = vi.hoisted(() => ({ showOpenDialog: vi.fn(), showMessageBox: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showOpenDialog, showMessageBox } }))

import type { BrowserWindow } from 'electron'
import { DataStore } from '../data/database'
import { KnowledgeRepository } from '../data/repository'
import { InMemoryExactVectorIndex, type IndexingResult } from '../data/vector'
import { DesktopLibraryService } from './service'

interface Fixture {
  readonly directory: string
  readonly store: DataStore
  readonly service: DesktopLibraryService
  readonly indexPending: ReturnType<typeof vi.fn<(
    options?: { readonly limit?: number; readonly signal?: AbortSignal },
  ) => Promise<IndexingResult>>>
  readonly windowOnce: ReturnType<typeof vi.fn>
}

let fixtures: Fixture[] = []

async function fixture(
  indexPending: Fixture['indexPending'] = vi.fn(async () => ({
    mode: 'keyword_fallback', indexed: 0, remaining: 1, failed: 0,
  })),
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'qaing-library-fixture-'))
  const store = new DataStore(join(directory, 'qaing.sqlite3'))
  const knowledge = new KnowledgeRepository(store, new InMemoryExactVectorIndex())
  const windowOnce = vi.fn()
  const value: Fixture = {
    directory,
    store,
    indexPending,
    windowOnce,
    service: new DesktopLibraryService({
      window: { once: windowOnce } as unknown as BrowserWindow,
      store,
      indexer: { indexPending },
      knowledge,
    }),
  }
  fixtures.push(value)
  return value
}

beforeEach(() => {
  showOpenDialog.mockReset()
  showMessageBox.mockReset()
  showMessageBox.mockResolvedValue({ response: 1 })
})

afterEach(async () => {
  for (const item of fixtures) {
    item.store.close()
    await rm(item.directory, { recursive: true, force: true })
  }
  fixtures = []
})

describe('DesktopLibraryService crash-safe imports', () => {
  it('commits SQLite/FTS and returns without waiting for model preparation or indexing', async () => {
    const pendingIndex = new Promise<IndexingResult>(() => {})
    const indexPending = vi.fn(() => pendingIndex)
    const target = await fixture(indexPending)
    const sourcePath = join(target.directory, 'policy.md')
    await writeFile(sourcePath, '# 退款政策\n\n购买后七天内可以退款。', 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [sourcePath] })

    const documents = await target.service.importSourceDocuments()
    expect(documents).toEqual([
      expect.objectContaining({ title: 'policy.md', status: 'pending', chunkCount: 1 }),
    ])
    expect(target.store.searchKeywords('购买后七天内可以退款')[0]).toMatchObject({ title: 'policy.md' })
    await vi.waitFor(() => expect(indexPending).toHaveBeenCalledTimes(1))
  })

  it('preserves imported data and absorbs an asynchronous worker failure', async () => {
    const indexPending = vi.fn(async () => { throw new Error('WORKER_EXIT_11') })
    const target = await fixture(indexPending)
    const sourcePath = join(target.directory, 'manual.txt')
    await writeFile(sourcePath, '保修期限为一年，凭订单号申请。', 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [sourcePath] })

    await expect(target.service.importSourceDocuments()).resolves.toHaveLength(1)
    await vi.waitFor(() => expect(indexPending).toHaveBeenCalledTimes(1))
    expect(target.store.listDocuments()).toHaveLength(1)
    expect(target.store.searchKeywords('保修期限为一年')).toHaveLength(1)
    expect(target.store.integrityCheck()).toBe('ok')
  })

  it('prevalidates every selected document and leaves no partial import on failure', async () => {
    const target = await fixture()
    const validPath = join(target.directory, 'valid.txt')
    const invalidPath = join(target.directory, 'invalid.txt')
    await writeFile(validPath, '这一份原本有效。', 'utf8')
    await writeFile(invalidPath, '   \n\n  ', 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [validPath, invalidPath] })

    await expect(target.service.importSourceDocuments()).rejects.toThrow(/content/i)
    expect(target.store.listDocuments()).toEqual([])
    expect(target.store.listChunks()).toEqual([])
  })

  it('imports multiple QA files all-or-none when cross-file questions conflict', async () => {
    const target = await fixture()
    const firstPath = join(target.directory, 'first.csv')
    const secondPath = join(target.directory, 'second.csv')
    await writeFile(firstPath, 'question,answer\n如何退款,联系客服\n', 'utf8')
    await writeFile(secondPath, 'question,answer\n如何退款,无需联系\n', 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [firstPath, secondPath] })

    await expect(target.service.importPresetQa()).rejects.toThrow(/conflicting/i)
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(target.store.listPresetQa()).toEqual([])
  })

  it('previews the exact cross-file deduplicated batch that is committed', async () => {
    const target = await fixture()
    const firstPath = join(target.directory, 'first.json')
    const secondPath = join(target.directory, 'second.md')
    await writeFile(firstPath, '[{"question":"如何退款？","answer":"联系客服。"}]', 'utf8')
    await writeFile(secondPath, '## Question:如何退款?\n### Answer\n联系客服。', 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [firstPath, secondPath] })

    await target.service.importPresetQa()

    const previewOptions: unknown = showMessageBox.mock.calls[0]?.[1]
    expect(previewOptions).toEqual(expect.objectContaining({
      message: expect.stringContaining('去重后共 1 条问答') as unknown,
      detail: expect.stringContaining('JSON / Markdown 模板 A') as unknown,
    }))
    expect(target.store.listPresetQa()).toHaveLength(1)
    expect(target.store.listIndexJobs()).toHaveLength(1)
  })

  it('rejects a conflict with an existing reviewed answer before confirmation', async () => {
    const target = await fixture()
    target.store.upsertPresetQa({ question: '如何退款？', answer: '已审核答案。' }, 1)
    const path = join(target.directory, 'conflict.md')
    await writeFile(path, '## 问题：如何退款?\n### 答案\n未审核的不同答案。', 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })

    await expect(target.service.importPresetQa()).rejects.toThrow(/existing answer/i)

    expect(showMessageBox).not.toHaveBeenCalled()
    expect(target.store.listPresetQa().map(({ answer }) => answer)).toEqual(['已审核答案。'])
  })

  it('previews and imports the strict categorized Markdown QA format', async () => {
    const target = await fixture()
    const markdownPath = join(target.directory, 'review.md')
    await writeFile(markdownPath, [
      '# 模拟评审 QA 汇总',
      '> 版本：已审核',
      '---',
      '## 产品',
      '**1. 这是什么产品？**',
      '回答：这是一个稳定的测试答案。',
    ].join('\n'), 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [markdownPath] })

    const documents = await target.service.importPresetQa()

    const previewOptions: unknown = showMessageBox.mock.calls[0]?.[1]
    expect(previewOptions).toEqual(expect.objectContaining({
      message: expect.stringContaining('1 条问答') as unknown,
    }))
    expect(documents).toEqual([expect.objectContaining({ kind: 'preset_qa', title: '这是什么产品？' })])
    expect(target.store.listPresetQa()).toHaveLength(1)
  })

  it('previews a validated review report as Markdown template C', async () => {
    const target = await fixture()
    const markdownPath = join(target.directory, 'review-report.md')
    await writeFile(markdownPath, [
      '# 评审汇总',
      '> 版本：已审核',
      '---',
      '## 分类总览',
      '| 分类 | 说明 | 条数 |',
      '| --- | --- | --- |',
      '| 产品 | 基础问题 | 1 |',
      '---',
      '# 产品（1条）',
      '> 范围：基础信息',
      '---',
      '#### 1. 这是什么产品？',
      '回答：这是一个经过审核的测试答案。',
      '---',
      '> 统计：共 1 条',
    ].join('\n'), 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [markdownPath] })

    await target.service.importPresetQa()

    const previewOptions: unknown = showMessageBox.mock.calls[0]?.[1]
    expect(previewOptions).toEqual(expect.objectContaining({
      message: expect.stringContaining('1 条问答') as unknown,
      detail: expect.stringContaining('Markdown 模板 C（评审汇总）') as unknown,
    }))
    expect(target.store.listPresetQa()).toEqual([
      expect.objectContaining({ question: '这是什么产品？' }),
    ])
  })

  it('writes no preset QA when the strict preview is cancelled', async () => {
    const target = await fixture()
    const markdownPath = join(target.directory, 'review.md')
    await writeFile(markdownPath, '## 问题：是否写入？\n### 答案\n不应写入。', 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [markdownPath] })
    showMessageBox.mockResolvedValue({ response: 0 })

    await target.service.importPresetQa()

    expect(target.store.listPresetQa()).toEqual([])
  })

  it('rejects final-component symlinks rather than following a dialog path after validation', async () => {
    const target = await fixture()
    const realPath = join(target.directory, 'real.txt')
    const linkPath = join(target.directory, 'selected.txt')
    await writeFile(realPath, '不得通过符号链接导入。', 'utf8')
    await symlink(realPath, linkPath)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [linkPath] })

    await expect(target.service.importSourceDocuments()).rejects.toThrow()
    expect(target.store.listDocuments()).toEqual([])
  })

  it('aborts and awaits background indexing when the library lifecycle is disposed', async () => {
    const observedSignals: AbortSignal[] = []
    const indexPending = vi.fn((options?: { readonly signal?: AbortSignal }) => new Promise<IndexingResult>((_resolve, reject) => {
      const signal = options?.signal
      if (!signal) throw new Error('Expected library indexing signal')
      observedSignals.push(signal)
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Library indexing aborted'))
      }, { once: true })
    }))
    const target = await fixture(indexPending)
    const sourcePath = join(target.directory, 'lifecycle.txt')
    await writeFile(sourcePath, '后台索引必须跟随服务生命周期退出。', 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [sourcePath] })
    await target.service.importSourceDocuments()
    await vi.waitFor(() => expect(indexPending).toHaveBeenCalledTimes(1))

    await expect(target.service.dispose()).resolves.toBeUndefined()
    expect(observedSignals[0]?.aborted).toBe(true)
    expect(target.store.listDocuments()).toHaveLength(1)
    expect(target.store.integrityCheck()).toBe('ok')
  })

  it('shares the same pending disposal task after a window-close callback', async () => {
    let releaseIndex: (() => void) | undefined
    const indexPending = vi.fn((options?: { readonly signal?: AbortSignal }) => new Promise<IndexingResult>((resolve) => {
      releaseIndex = () => resolve({ mode: 'keyword_fallback', indexed: 0, remaining: 0, failed: 0 })
      options?.signal?.addEventListener('abort', () => undefined, { once: true })
    }))
    const target = await fixture(indexPending)
    const path = join(target.directory, 'closing.txt')
    await writeFile(path, '窗口关闭时索引任务必须先完全停止。', 'utf8')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })
    await target.service.importSourceDocuments()
    await vi.waitFor(() => expect(indexPending).toHaveBeenCalledTimes(1))

    const closedListener = target.windowOnce.mock.calls.find(([event]) => event === 'closed')?.[1] as (() => void) | undefined
    expect(closedListener).toBeTypeOf('function')
    closedListener?.()
    const awaitedDispose = target.service.dispose()
    let settled = false
    void awaitedDispose.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseIndex?.()
    await awaitedDispose
    expect(settled).toBe(true)
    expect(target.store.integrityCheck()).toBe('ok')
  })
})
