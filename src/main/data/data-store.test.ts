import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { chunkText, type TokenCounter } from './chunking'
import { DataStore } from './database'
import {
  importSourceDocument,
  importSourceDocumentsDeferred,
  importStructuredQa,
  parseStructuredQa,
} from './importers'
import { KnowledgeRepository } from './repository'
import { applyMigrations, latestSchemaVersion } from './migrations'
import { TestOnlyDeterministicEmbeddingProvider } from './testing'
import { EmbeddingIndexer, InMemoryExactVectorIndex } from './vector'

class CodePointCounter implements TokenCounter {
  readonly modelId = 'test/token-counter'
  readonly modelRevision = 'v1'
  readonly maxInputTokens = 512

  countTokens(text: string): number {
    return [...text].length
  }
}

describe('deterministic document chunking', () => {
  it('preserves order and enforces the verified provider limit for oversized units', () => {
    const content = `${'甲'.repeat(700)}。\n\n${'乙'.repeat(260)}！`
    const chunks = chunkText(content, new CodePointCounter(), { targetTokens: 128 })

    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((chunk) => chunk.tokenCount <= 128)).toBe(true)
    expect(chunks.map((chunk) => chunk.content).join('').replaceAll('\n', '')).toBe(content.replaceAll('\n', ''))
    expect(chunkText(content, new CodePointCounter(), { targetTokens: 128 })).toEqual(chunks)
  })

  it('rejects counters that claim an input contract above 512 tokens', () => {
    const invalid = { ...new CodePointCounter(), maxInputTokens: 513, countTokens: (text: string) => [...text].length }
    expect(() => chunkText('内容', invalid)).toThrow(/512/)
  })
})

describe('SQLite canonical store', () => {
  it('migrates a populated v1 database through the latest schema without losing chunks or FTS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-migration-'))
    const databasePath = join(directory, 'legacy.sqlite')
    const legacy = new Database(databasePath)
    try {
      legacy.pragma('foreign_keys = ON')
      applyMigrations(legacy, 1, 1)
      legacy
        .prepare(
          `INSERT INTO documents(id, title, kind, source_uri, content, content_hash, created_at, updated_at)
           VALUES ('legacy-doc', '旧资料', 'text', NULL, '旧的保修规则', 'doc-hash', 1, 1)`,
        )
        .run()
      legacy
        .prepare(
          `INSERT INTO chunks(id, document_id, ordinal, content, content_hash, token_count)
           VALUES ('legacy-chunk', 'legacy-doc', 0, '保修期限一年', 'chunk-hash', 8)`,
        )
        .run()
    } finally {
      legacy.close()
    }

    const store = new DataStore(databasePath)
    try {
      expect(store.schemaVersion()).toBe(latestSchemaVersion)
      expect(store.listChunks('legacy-doc')).toEqual([
        expect.objectContaining({ id: 'legacy-chunk', content: '保修期限一年' }),
      ])
      expect(store.searchKeywords('保修期限')[0]).toMatchObject({ ownerId: 'legacy-chunk' })
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('recovers raw front transcripts across a crash without any model dependency', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-front-recovery-'))
    const databasePath = join(directory, 'qaing.sqlite')
    let store = new DataStore(databasePath)
    try {
      store.createSession({ id: 'front-session', mode: 'front', audioSource: 'system', startedAt: 1 })
      const draft = store.upsertFrontDraft(
        {
          id: 'front-draft',
          sessionId: 'front-session',
          transcript: '这是模型未就绪时也必须保存的原始转写。',
          status: 'raw_ready',
        },
        2,
      )
      store.close()

      store = new DataStore(databasePath)
      expect(store.listRecoverableFrontDrafts()).toEqual([
        expect.objectContaining({ id: 'front-draft', transcript: '这是模型未就绪时也必须保存的原始转写。' }),
      ])
      expect(() => store.markFrontDraftStructured('front-draft', 'stale-hash', '# 错误', 3)).toThrow(/stale/)
      store.markFrontDraftStructuring('front-draft', draft.contentHash, 4)
      store.markFrontDraftStructured('front-draft', draft.contentHash, '# 可恢复的结构化记录', 5)
      expect(store.completeFrontDraft('front-draft', 6)).toMatchObject({ status: 'complete' })
      expect(store.listRecoverableFrontDrafts()).toEqual([])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('imports documents idempotently, replaces changed chunks atomically, and cascades deletes', () => {
    const store = new DataStore(':memory:')
    const counter = new CodePointCounter()
    try {
      const first = importSourceDocument(
        store,
        { title: '政策', format: 'markdown', content: '# 政策\n\n七天内可退货。', sourceUri: '/tmp/policy.md' },
        counter,
        {},
        100,
      )
      const originalChunks = store.listChunks(first.document.id)
      const duplicate = importSourceDocument(
        store,
        { title: '政策新标题', format: 'markdown', content: '# 政策\n\n七天内可退货。', sourceUri: '/tmp/policy.md' },
        counter,
        {},
        200,
      )
      expect(duplicate).toMatchObject({ inserted: false, contentChanged: false })
      expect(store.listDocuments()).toHaveLength(1)
      const sameContentOtherSource = importSourceDocument(
        store,
        { title: '备份', format: 'markdown', content: '# 政策\n\n七天内可退货。', sourceUri: '/tmp/copy.md' },
        counter,
        {},
        250,
      )
      expect(sameContentOtherSource.document.sourceUri).toBe('/tmp/policy.md')
      expect(store.listChunks(first.document.id).map((chunk) => chunk.id)).toEqual(originalChunks.map((chunk) => chunk.id))

      const changed = importSourceDocument(
        store,
        { title: '政策', format: 'markdown', content: '# 政策\n\n十四天内可退货。', sourceUri: '/tmp/policy.md' },
        counter,
        {},
        300,
      )
      expect(changed).toMatchObject({ inserted: false, contentChanged: true })
      expect(store.listChunks(changed.document.id).map((chunk) => chunk.content).join('')).toContain('十四天')
      expect(store.listChunks(changed.document.id).map((chunk) => chunk.id)).not.toEqual(
        originalChunks.map((chunk) => chunk.id),
      )
      expect(store.deleteDocument(changed.document.id).length).toBeGreaterThan(0)
      expect(store.listChunks(changed.document.id)).toEqual([])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('allows repeated chunk content at different deterministic ordinals', () => {
    const store = new DataStore(':memory:')
    try {
      const result = store.upsertDocument({
        title: '重复段落',
        kind: 'text',
        content: '声明\n\n声明',
        chunks: [
          { content: '声明', tokenCount: 2 },
          { content: '声明', tokenCount: 2 },
        ],
      })
      expect(store.listChunks(result.document.id)).toHaveLength(2)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('rolls back a complete multi-document import when a later source conflicts', () => {
    const store = new DataStore(':memory:')
    try {
      importSourceDocumentsDeferred(store, [
        { title: '甲', format: 'text', content: '甲原文', sourceUri: '/tmp/qaing-a.txt' },
        { title: '乙', format: 'text', content: '乙原文', sourceUri: '/tmp/qaing-b.txt' },
      ], {}, 1)
      expect(() => importSourceDocumentsDeferred(store, [
        { title: '甲更新', format: 'text', content: '新的共享正文', sourceUri: '/tmp/qaing-a.txt' },
        { title: '乙更新', format: 'text', content: '新的共享正文', sourceUri: '/tmp/qaing-b.txt' },
      ], {}, 2)).toThrow(/different source/)
      expect(store.listDocuments().map((record) => record.content)).toEqual(['甲原文', '乙原文'])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('rolls back an entire structured QA import when any duplicate conflicts', () => {
    const store = new DataStore(':memory:')
    try {
      expect(() =>
        importStructuredQa(
          store,
          JSON.stringify([
            { question: '如何退款？', answer: '联系客服' },
            { question: ' 如何退款? ', answer: '另一个答案' },
          ]),
          'json',
        ),
      ).toThrow(/conflicting/)
      expect(store.listPresetQa()).toEqual([])
    } finally {
      store.close()
    }
  })

  it('parses quoted CSV and JSON maps without truncating multiline answers', () => {
    const csv = 'question,answer\r\n"退货,怎么办？","第一行\n第二行"\r\n'
    expect(parseStructuredQa(csv, 'csv')).toEqual([{ question: '退货,怎么办？', answer: '第一行\n第二行' }])
    expect(parseStructuredQa('{"保修多久？":"一年"}', 'json')).toEqual([{ question: '保修多久？', answer: '一年' }])
  })

  it('maintains exact QA, trigram FTS, recent-five history, and embedding recovery', async () => {
    const store = new DataStore(':memory:')
    const provider = new TestOnlyDeterministicEmbeddingProvider(64)
    const index = new InMemoryExactVectorIndex()
    try {
      importStructuredQa(
        store,
        JSON.stringify([
          { question: '保修期限是多久？', answer: '自购买之日起一年。' },
          { question: '可以退货吗？', answer: '符合条件时七天内可退。' },
        ]),
        'json',
        10,
      )
      expect(store.findExactPresetQa('  保修期限是多久? ')).toHaveLength(1)
      expect(store.searchKeywords('保修期限多久')[0]?.excerpt).toContain('一年')

      store.createProjectManifest({
        id: 'history-project',
        displayName: '历史检索项目',
        rootPath: '/tmp/qaing-history-project',
        rootIdentity: 'history-project-root',
        schemaVersion: 1,
      }, 1)
      store.createSession({
        id: 's1',
        projectId: 'history-project',
        mode: 'qa',
        audioSource: 'microphone',
        startedAt: 1,
      })
      for (let index = 0; index < 7; index += 1) {
        store.appendTurn({ id: `t${index}`, sessionId: 's1', question: `q${index}`, answer: `a${index}`, createdAt: index + 2 })
      }
      expect(store.getRecentTurns('s1', 5).map((turn) => turn.question)).toEqual(['q2', 'q3', 'q4', 'q5', 'q6'])
      const retried = store.appendTurn({ id: 't6', sessionId: 's1', question: 'q6', answer: 'a6' })
      expect(retried.ordinal).toBe(6)
      expect(() => store.appendTurn({ id: 't6', sessionId: 's1', question: 'q6', answer: '冲突答案' })).toThrow(
        /conflicting/,
      )
      expect(store.getRecentTurns('s1', 5)).toHaveLength(5)

      const indexer = new EmbeddingIndexer({ store, index, provider, allowTestProvider: true })
      expect(indexer.initialize()).toMatchObject({ indexed: 0, mode: 'hybrid' })
      const claimed = store.claimIndexJobs(1)
      expect(claimed).toHaveLength(1)
      expect(store.recoverInterruptedIndexJobs()).toBe(1)
      const result = await indexer.indexPending()
      expect(result.indexed).toBe(2)
      expect(index.size).toBe(2)
      const recovered = new InMemoryExactVectorIndex()
      const recovery = new EmbeddingIndexer({ store, index: recovered, provider, allowTestProvider: true }).initialize()
      expect(recovery).toMatchObject({ indexed: 2, remaining: 0 })
      expect(recovered.size).toBe(2)
      expect(store.listIndexJobs().every((job) => job.status === 'ready')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('isolates an over-limit poison record and immediately invalidates changed vectors through the repository', async () => {
    const store = new DataStore(':memory:')
    const provider = new TestOnlyDeterministicEmbeddingProvider(64)
    const index = new InMemoryExactVectorIndex()
    const repository = new KnowledgeRepository(store, index)
    try {
      repository.importStructuredQa(
        JSON.stringify([
          { question: '有效问题？', answer: '有效答案' },
          { question: `${'过'.repeat(511)}？`, answer: '过长问题答案' },
        ]),
        'json',
      )
      const indexer = new EmbeddingIndexer({ store, index, provider, allowTestProvider: true })
      const first = await indexer.indexPending()
      expect(first).toMatchObject({ indexed: 1, failed: 1, remaining: 0 })
      expect(index.size).toBe(1)
      expect(store.listIndexJobs().map((job) => job.status).sort()).toEqual(['failed', 'ready'])
      store.prepareEmbeddingJobs({ ...provider.metadata, modelRevision: 'fixture-v2' })
      expect(store.listIndexJobs().map((job) => job.status).sort()).toEqual(['pending', 'pending'])
      store.prepareEmbeddingJobs(provider.metadata)

      repository.importStructuredQa('[{"question":"有效问题？","answer":"修订答案"}]', 'json')
      expect(index.size).toBe(0)
      expect((await indexer.indexPending()).indexed).toBe(1)
      expect(index.size).toBe(1)
    } finally {
      store.close()
    }
  })
})
