import { describe, expect, it, vi } from 'vitest'
import { DataStore, VectorCapacityError, type EmbeddingWrite } from './database'
import { importStructuredQa } from './importers'
import {
  HybridRetriever,
  RetrievalScopeChangedError,
  canonicalExactQuestion,
  qaCriticalTermsCompatible,
  reciprocalRankFusion,
} from './retrieval'
import { TestOnlyDeterministicEmbeddingProvider } from './testing'
import {
  EmbeddingIndexer,
  EmbeddingProviderError,
  InMemoryExactVectorIndex,
  embedTexts,
  type EmbeddingProvider,
} from './vector'

describe('hybrid retrieval', () => {
  it('uses rank fusion with preset/source prior instead of mixing raw scores', () => {
    const references = reciprocalRankFusion(
      [
        {
          weight: 1,
          hits: [
            { ownerType: 'chunk', ownerId: 'c1', documentId: 'd1', title: 'D', excerpt: 'raw cosine intentionally absent' },
            { ownerType: 'preset_qa', ownerId: 'q1', documentId: 'preset:q1', title: 'Q', excerpt: 'A' },
          ],
        },
        {
          weight: 1,
          hits: [{ ownerType: 'preset_qa', ownerId: 'q1', documentId: 'preset:q1', title: 'Q', excerpt: 'A' }],
        },
      ],
      5,
    )
    expect(references.map((reference) => reference.id)).toEqual(['q1', 'c1'])
    expect(references[0]?.score).toBe(1)
  })

  it('marks missing production embeddings as keyword_fallback and upgrades after a real index is ready', async () => {
    const store = new DataStore(':memory:')
    try {
      importStructuredQa(store, '[{"question":"退货期限？","answer":"七天。"}]', 'json')
      const emptyIndex = new InMemoryExactVectorIndex()
      const fallback = new HybridRetriever({ store, index: emptyIndex })
      expect((await fallback.retrieve('退货期限')).mode).toBe('keyword_fallback')

      const provider = new TestOnlyDeterministicEmbeddingProvider(64)
      await new EmbeddingIndexer({ store, index: emptyIndex, provider, allowTestProvider: true }).indexPending()
      const hybrid = new HybridRetriever({ store, index: emptyIndex, provider, allowTestProvider: true, minimumVectorScore: -1 })
      const result = await hybrid.retrieve('退货期限？')
      expect(result.mode).toBe('hybrid')
      expect(result.references[0]).toMatchObject({ kind: 'preset_qa', excerpt: '七天。' })
    } finally {
      store.close()
    }
  })

  it('keeps exact canonicalization narrow and rejects answer-changing near-QA facets', () => {
    expect(canonicalExactQuestion(' 2024年净利润？ ')).toBe('2024年净利润')
    expect(canonicalExactQuestion('2023年净利润？')).not.toBe(canonicalExactQuestion('2024年净利润？'))
    expect(qaCriticalTermsCompatible('2024年净利润是多少？', '2024年净利润多少？')).toBe(true)
    expect(qaCriticalTermsCompatible('2024年净利润是多少？', '2023年净利润多少？')).toBe(false)
    expect(qaCriticalTermsCompatible('是否支持退货？', '是否不支持退货？')).toBe(false)
    expect(qaCriticalTermsCompatible('这是付费服务吗？', '这不是付费服务吗？')).toBe(false)
    expect(qaCriticalTermsCompatible('结算金额是多少？', '成交额是多少？')).toBe(false)
    expect(qaCriticalTermsCompatible('二〇二三年净利润是多少？', '二〇二四年净利润是多少？')).toBe(false)
    expect(qaCriticalTermsCompatible('一期项目预算多少？', '二期项目预算多少？')).toBe(false)
    expect(qaCriticalTermsCompatible('何时交付？', '为何交付？')).toBe(false)
    expect(qaCriticalTermsCompatible('如何支持退货？', '是否支持退货？')).toBe(false)
    expect(qaCriticalTermsCompatible('何时交付？', '什么时候交付？')).toBe(true)
    expect(qaCriticalTermsCompatible('为何延期？', '为什么延期？')).toBe(true)
    expect(qaCriticalTermsCompatible('百分之十的增长率？', '百分之二十的增长率？')).toBe(false)
    expect(qaCriticalTermsCompatible('3万元的预算？', '3元的预算？')).toBe(false)
    expect(qaCriticalTermsCompatible('请问A公司2024年预算是多少？', 'A公司2024年预算是多少？')).toBe(true)
    expect(qaCriticalTermsCompatible('请问A公司2024年预算是多少？', 'B公司2024年预算是多少？')).toBe(false)
    expect(qaCriticalTermsCompatible('SKU-A型号的价格？', 'SKU-B型号的价格？')).toBe(false)
    expect(qaCriticalTermsCompatible('项目预算是多少？', '项目成本是多少？')).toBe(false)
    expect(qaCriticalTermsCompatible('项目周期是多久？', '项目进度是多久？')).toBe(false)
    expect(qaCriticalTermsCompatible('销售额同比增长多少？', '销量环比增长多少？')).toBe(false)
  })

  it('uses a unique high-confidence preset-question FTS match while the embedding worker is unavailable', async () => {
    const store = new DataStore(':memory:')
    const index = new InMemoryExactVectorIndex()
    let readiness: NonNullable<EmbeddingProvider['readiness']> = 'loading'
    const embed = vi.fn(() => Promise.resolve([new Float32Array([1, 0])]))
    const provider: EmbeddingProvider = {
      usage: 'production',
      get readiness() { return readiness },
      modelId: 'fixture', modelRevision: 'v1', maxInputTokens: 512, maxBatchSize: 1,
      metadata: { modelId: 'fixture', modelRevision: 'v1', dimension: 2, normalized: true },
      countTokens: () => 1,
      embed,
    }
    try {
      const qa = store.upsertPresetQa({
        question: '退货的办理时限是多少天？',
        answer: '七天。',
      }).record
      const retriever = new HybridRetriever({ store, index, provider })
      const fallback = await retriever.retrieve('请问退货的办理时限是多少天')
      expect(fallback).toMatchObject({
        mode: 'keyword_fallback',
        route: 'preset_qa_semantic',
        directAnswer: '七天。',
      })
      expect(embed).not.toHaveBeenCalled()

      readiness = 'ready'
      index.upsert([{
        ownerType: 'preset_qa', ownerId: qa.id, documentId: `preset:${qa.id}`,
        title: qa.question, excerpt: qa.answer, contentHash: qa.contentHash,
        vector: new Float32Array([1, 0]), metadata: provider.metadata,
      }])
      const recovered = await retriever.retrieve('请问退货的办理时限是多少天')
      expect(recovered).toMatchObject({ mode: 'hybrid', route: 'preset_qa_semantic', directAnswer: '七天。' })
      expect(embed).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('returns a strict QA FTS match before a ready embedding worker can time out', async () => {
    const store = new DataStore(':memory:')
    const index = new InMemoryExactVectorIndex()
    const embed = vi.fn(() => Promise.reject(new EmbeddingProviderError('TIMEOUT', 'worker timeout', true)))
    const provider: EmbeddingProvider = {
      usage: 'production', readiness: 'ready', modelId: 'fixture', modelRevision: 'v1', maxInputTokens: 512,
      maxBatchSize: 1, metadata: { modelId: 'fixture', modelRevision: 'v1', dimension: 2, normalized: true },
      countTokens: () => 1,
      embed,
    }
    try {
      const qa = store.upsertPresetQa({ question: '退货的办理时限是多少天？', answer: '七天。' }).record
      index.upsert([{
        ownerType: 'preset_qa', ownerId: qa.id, documentId: `preset:${qa.id}`,
        title: qa.question, excerpt: qa.answer, contentHash: qa.contentHash,
        vector: new Float32Array([1, 0]), metadata: provider.metadata,
      }])
      await expect(new HybridRetriever({ store, index, provider }).retrieve(
        '请问退货的办理时限是多少天',
      )).resolves.toMatchObject({
        mode: 'hybrid', route: 'preset_qa_semantic', directAnswer: '七天。',
      })
      expect(embed).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('fails closed when lexical preset candidates are ambiguous or protected facets differ', async () => {
    const store = new DataStore(':memory:')
    try {
      store.upsertPresetQa({ question: '退货的办理时限是多少天？', answer: '退货答案。' })
      store.upsertPresetQa({ question: '换货的办理时限是多少天？', answer: '换货答案。' })
      store.upsertPresetQa({ question: '二〇二三年净利润是多少？', answer: '历史答案。' })
      const retriever = new HybridRetriever({ store, index: new InMemoryExactVectorIndex() })

      await expect(retriever.retrieve('请问办理时限是多少天？')).resolves.toMatchObject({
        route: 'source_document', directAnswer: null,
      })
      await expect(retriever.retrieve('二〇二四年净利润是多少？')).resolves.toMatchObject({
        route: 'source_document', directAnswer: null,
      })
    } finally {
      store.close()
    }
  })

  it('short-circuits exact preset QA before embedding and vector search', async () => {
    const store = new DataStore(':memory:')
    const index = new InMemoryExactVectorIndex()
    const embed = vi.fn(() => Promise.resolve([new Float32Array([1, 0])]))
    const provider: EmbeddingProvider = {
      usage: 'production', readiness: 'ready', modelId: 'fixture', modelRevision: 'v1', maxInputTokens: 512,
      maxBatchSize: 1, metadata: { modelId: 'fixture', modelRevision: 'v1', dimension: 2, normalized: true },
      countTokens: () => 1,
      embed,
    }
    try {
      const qa = store.upsertPresetQa({ question: '2024年净利润是多少？', answer: '100万元。' }).record
      index.upsert([{
        ownerType: 'preset_qa', ownerId: qa.id, documentId: `preset:${qa.id}`, title: qa.question,
        excerpt: qa.answer, contentHash: qa.contentHash, vector: new Float32Array([1, 0]), metadata: provider.metadata,
      }])
      const search = vi.spyOn(index, 'search')
      const result = await new HybridRetriever({ store, index, provider }).retrieve(' 2024年净利润是多少。 ')
      expect(result).toMatchObject({ route: 'preset_qa_exact', directAnswer: '100万元。' })
      expect(embed).not.toHaveBeenCalled()
      expect(search).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('searches the preset-QA vector partition before documents and does not lose QA below global top 100', async () => {
    const store = new DataStore(':memory:')
    const index = new InMemoryExactVectorIndex(200)
    const provider: EmbeddingProvider = {
      usage: 'production', readiness: 'ready', modelId: 'fixture', modelRevision: 'v1', maxInputTokens: 512,
      maxBatchSize: 1, metadata: { modelId: 'fixture', modelRevision: 'v1', dimension: 2, normalized: true },
      countTokens: () => 1,
      embed: () => Promise.resolve([new Float32Array([1, 0])]),
    }
    try {
      const qa = store.upsertPresetQa({ question: '退货的处理时限是多少天？', answer: '七天。' }).record
      index.upsert([
        ...Array.from({ length: 120 }, (_value, ordinal) => ({
          ownerType: 'chunk' as const,
          ownerId: `chunk-${ordinal}`,
          documentId: `doc-${ordinal}`,
          title: '文档',
          excerpt: '没有关系的内容',
          contentHash: `hash-${ordinal}`,
          vector: new Float32Array([1, 0]),
          metadata: provider.metadata,
        })),
        {
          ownerType: 'preset_qa', ownerId: qa.id, documentId: `preset:${qa.id}`,
          title: qa.question, excerpt: qa.answer, contentHash: qa.contentHash,
          vector: new Float32Array([0.9999, 0.01414]), metadata: provider.metadata,
        },
      ])
      const result = await new HybridRetriever({
        store,
        index,
        provider,
        strictNearQa: { enabled: true, minimumCosine: 0.98, minimumMargin: 0.05, minimumLexicalScore: 0.7 },
      }).retrieve('请问退货的办理时限是多少天')
      expect(result).toMatchObject({ route: 'preset_qa_semantic', directAnswer: '七天。' })
    } finally {
      store.close()
    }
  })

  it('falls through to source documents when a high-cosine preset has a protected-term conflict', async () => {
    const store = new DataStore(':memory:')
    const index = new InMemoryExactVectorIndex()
    const provider: EmbeddingProvider = {
      usage: 'production', readiness: 'ready', modelId: 'fixture', modelRevision: 'v1', maxInputTokens: 512,
      maxBatchSize: 1, metadata: { modelId: 'fixture', modelRevision: 'v1', dimension: 2, normalized: true },
      countTokens: () => 1,
      embed: () => Promise.resolve([new Float32Array([1, 0])]),
    }
    try {
      const qa = store.upsertPresetQa({ question: '2023年净利润是多少？', answer: '80万元。' }).record
      const document = store.upsertDocument({
        title: '2024年报', kind: 'text', content: '2024年净利润是100万元。',
        chunks: [{ content: '2024年净利润是100万元。', tokenCount: 12 }],
      })
      const chunk = store.listChunks(document.document.id)[0]
      index.upsert([
        { ownerType: 'preset_qa', ownerId: qa.id, documentId: `preset:${qa.id}`, title: qa.question,
          excerpt: qa.answer, contentHash: qa.contentHash, vector: new Float32Array([1, 0]), metadata: provider.metadata },
        { ownerType: 'chunk', ownerId: chunk?.id as string, documentId: document.document.id, title: document.document.title,
          excerpt: chunk?.content as string, contentHash: chunk?.contentHash as string,
          vector: new Float32Array([0.99, 0.141]), metadata: provider.metadata },
      ])
      const result = await new HybridRetriever({ store, index, provider }).retrieve('2024年净利润是多少？')
      expect(result.route).toBe('source_document')
      expect(result.directAnswer).toBeNull()
      expect(result.references.every((reference) => reference.kind === 'source_document')).toBe(true)
    } finally {
      store.close()
    }
  })

  it.each([
    ['A to B', false],
    ['A to B to A', true],
  ] as const)('rejects a stale asynchronous retrieval scope after %s project switching', async (_label, switchBack) => {
    const store = new DataStore(':memory:')
    const index = new InMemoryExactVectorIndex()
    let resolveEmbedding: ((vectors: readonly Float32Array[]) => void) | undefined
    const embed = vi.fn(() => new Promise<readonly Float32Array[]>((resolve) => {
      resolveEmbedding = resolve
    }))
    const provider: EmbeddingProvider = {
      usage: 'production', readiness: 'ready', modelId: 'fixture', modelRevision: 'v1', maxInputTokens: 512,
      maxBatchSize: 1, metadata: { modelId: 'fixture', modelRevision: 'v1', dimension: 2, normalized: true },
      countTokens: () => 1,
      embed,
    }
    try {
      for (const id of ['project-a', 'project-b']) {
        store.createProjectManifest({
          id,
          displayName: id,
          rootPath: `/tmp/${id}`,
          rootIdentity: `root-${id}`,
          schemaVersion: 1,
        })
      }
      store.setActiveProject('project-a')
      vi.spyOn(store, 'getRetrievalOwnerIds').mockImplementation((ownerType) =>
        ownerType === 'chunk' ? new Set(['chunk-a']) : new Set(),
      )
      index.upsert([{
        ownerType: 'chunk', ownerId: 'chunk-a', documentId: 'document-a', title: 'A', excerpt: 'A',
        contentHash: 'hash-a', vector: new Float32Array([1, 0]), metadata: provider.metadata,
      }])

      const pending = new HybridRetriever({ store, index, provider }).retrieve('scope switch query')
      await vi.waitFor(() => expect(embed).toHaveBeenCalledOnce())
      store.setActiveProject('project-b')
      if (switchBack) store.setActiveProject('project-a')
      ;(resolveEmbedding as (vectors: readonly Float32Array[]) => void)([new Float32Array([1, 0])])

      await expect(pending).rejects.toBeInstanceOf(RetrievalScopeChangedError)
    } finally {
      store.close()
    }
  })

  it('searches the document FTS partition even when preset QA has more than forty stronger keyword hits', async () => {
    const store = new DataStore(':memory:')
    try {
      for (let index = 0; index < 60; index += 1) {
        store.upsertPresetQa({
          question: `退货期限政策与办理流程 ${index}？`,
          answer: `预设答案 ${index}`,
        }, index)
      }
      const document = store.upsertDocument({
        title: '原始政策', kind: 'text', content: '退货期限政策与办理流程以此原始文件为准。',
        chunks: [{ content: '退货期限政策与办理流程以此原始文件为准。', tokenCount: 22 }],
      }, 100)
      const result = await new HybridRetriever({
        store,
        index: new InMemoryExactVectorIndex(),
      }).retrieve('退货期限政策与办理流程什么')
      expect(result.route).toBe('source_document')
      expect(result.references).toEqual([
        expect.objectContaining({ documentId: document.document.id, kind: 'source_document' }),
      ])
    } finally {
      store.close()
    }
  })

  it('refuses to activate a test-only embedding provider without an explicit test gate', () => {
    const store = new DataStore(':memory:')
    try {
      expect(
        () =>
          new EmbeddingIndexer({
            store,
            index: new InMemoryExactVectorIndex(),
            provider: new TestOnlyDeterministicEmbeddingProvider(),
          }),
      ).toThrow(/test-only/)
    } finally {
      store.close()
    }
  })

  it('keeps the previous exact index intact when replacement validation fails', () => {
    const index = new InMemoryExactVectorIndex()
    const metadata = { modelId: 'fixture', modelRevision: 'v1', dimension: 2, normalized: true } as const
    index.replaceAll([
      {
        ownerType: 'chunk',
        ownerId: 'valid',
        documentId: 'doc',
        title: 'valid',
        excerpt: 'valid',
        contentHash: 'hash',
        vector: new Float32Array([1, 0]),
        metadata,
      },
    ])
    expect(() =>
      index.replaceAll([
        {
          ownerType: 'chunk',
          ownerId: 'invalid',
          documentId: 'doc',
          title: 'invalid',
          excerpt: 'invalid',
          contentHash: 'hash',
          vector: new Float32Array([1, 0, 0]),
          metadata,
        },
      ]),
    ).toThrow(/dimension/)
    expect(index.search(new Float32Array([1, 0]), 1)[0]?.ownerId).toBe('valid')
  })

  it('enforces its timeout even when a provider ignores the abort signal', async () => {
    const provider: EmbeddingProvider = {
      usage: 'production',
      readiness: 'ready',
      modelId: 'fixture/provider',
      modelRevision: 'v1',
      maxInputTokens: 512,
      maxBatchSize: 1,
      metadata: { modelId: 'fixture/provider', modelRevision: 'v1', dimension: 2, normalized: true },
      countTokens: () => 1,
      embed: () => new Promise((resolve) => setTimeout(() => resolve([new Float32Array([1, 0])]), 50)),
    }
    await expect(embedTexts(provider, ['query'], { timeoutMs: 5 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    })
  })

  it('rejects the capacity-crossing batch before any SQLite vector is written and recovers legacy overflow', () => {
    const store = new DataStore(':memory:')
    const metadata = { modelId: 'fixture/capacity', modelRevision: 'v1', dimension: 2, normalized: true } as const
    try {
      for (const question of ['q1', 'q2', 'q3']) store.upsertPresetQa({ question, answer: `answer-${question}` })
      const writes: EmbeddingWrite[] = store.listPresetQa().map((record, index) => ({
        ownerType: 'preset_qa',
        ownerId: record.id,
        contentHash: record.contentHash,
        vector: index % 2 === 0 ? new Float32Array([1, 0]) : new Float32Array([0, 1]),
        metadata,
      }))

      expect(() => store.storeEmbeddings(writes, 10, 2)).toThrow(VectorCapacityError)
      expect(store.countStoredVectors()).toBe(0)
      store.storeEmbeddings(writes.slice(0, 2), 11, 2)
      expect(store.countStoredVectors()).toBe(2)
      expect(() => store.storeEmbeddings(writes.slice(2), 12, 2)).toThrow(VectorCapacityError)
      expect(store.countStoredVectors()).toBe(2)

      // Simulate an older release that already persisted more than the new
      // exact-index limit. Startup must degrade, not crash forever.
      store.storeEmbeddings(writes.slice(2), 13, 3)
      const provider: EmbeddingProvider = {
        usage: 'production',
        readiness: 'ready',
        modelId: metadata.modelId,
        modelRevision: metadata.modelRevision,
        maxInputTokens: 512,
        maxBatchSize: 1,
        metadata,
        countTokens: () => 1,
        embed: () => Promise.resolve([new Float32Array([1, 0])]),
      }
      const index = new InMemoryExactVectorIndex(2)
      expect(new EmbeddingIndexer({ store, index, provider }).initialize()).toMatchObject({
        mode: 'keyword_fallback',
        indexed: 0,
      })
      expect(index.size).toBe(0)
    } finally {
      store.close()
    }
  })
})
