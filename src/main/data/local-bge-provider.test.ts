import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  LOCAL_BGE_DIMENSION,
  LOCAL_BGE_MODEL_ID,
  LocalBgeWorkerRuntime,
  localBgeModelPath,
  type LocalBgePipeline,
  type LocalBgePipelineFactory,
} from './local-bge-provider'
import { InMemoryExactVectorIndex } from './vector'
import { DataStore } from './database'
import { HybridRetriever } from './retrieval'
import { importStructuredQa } from './importers'

function unitVector(position: number): number[] {
  return Array.from({ length: LOCAL_BGE_DIMENSION }, (_value, index) => (index === position ? 1 : 0))
}

function fixtureFactory(): { readonly factory: LocalBgePipelineFactory; readonly calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn()
  const factory: LocalBgePipelineFactory = (options) => {
    calls(options)
    const tokenizer = Object.assign(
      (text: string) => ({ input_ids: { data: Uint32Array.from([101, ...[...text].map(() => 1), 102]) } }),
      { encode: (text: string) => [101, ...[...text].map(() => 1), 102] },
    )
    const pipeline = Object.assign(
      (texts: readonly string[], inference: { readonly signal: AbortSignal }) => {
        if (inference.signal.aborted) return Promise.reject(new Error('Fixture inference aborted'))
        return Promise.resolve({ tolist: () => texts.map((_text, index) => unitVector(index)) })
      },
      { tokenizer },
    ) as LocalBgePipeline
    return Promise.resolve(pipeline)
  }
  return { factory, calls }
}

describe('LocalBgeEmbeddingProvider', () => {
  it('requires a pinned revision and never accepts mutable main', () => {
    expect(
      () => new LocalBgeWorkerRuntime({ revision: 'main', cacheDir: '/tmp/qaing-model-fixture' }),
    ).toThrow(/commit hash/)
  })

  it('loads only on explicit prepare and enforces the official model contract', async () => {
    const { factory, calls } = fixtureFactory()
    const provider = new LocalBgeWorkerRuntime({
      revision: 'abcdef1234567890',
      cacheDir: '/tmp/qaing-model-fixture',
      pipelineFactory: factory,
      verifyModelFile: 'skip',
    })
    const signal = new AbortController().signal
    expect(provider.readiness).toBe('not_loaded')
    expect(() => provider.countTokens('测试')).toThrow(/not ready/)
    await provider.prepare({ signal })
    expect(provider.readiness).toBe('ready')
    expect(provider.countTokens('测试')).toBe(4)
    expect(calls).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: LOCAL_BGE_MODEL_ID,
        revision: 'abcdef1234567890',
        dtype: 'q4',
      }),
    )
    const vectors = await provider.embed(['甲', '乙'], { signal })
    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toHaveLength(LOCAL_BGE_DIMENSION)
  })

  it('keeps retrieval in explicit keyword fallback while the local model is not ready', async () => {
    const store = new DataStore(':memory:')
    const { factory } = fixtureFactory()
    const provider = new LocalBgeWorkerRuntime({
      revision: 'abcdef1234567890',
      cacheDir: '/tmp/qaing-model-fixture',
      pipelineFactory: factory,
      verifyModelFile: 'skip',
    })
    try {
      importStructuredQa(store, '[{"question":"库存是多少？","answer":"不管理库存。"}]', 'json')
      const result = await new HybridRetriever({
        store,
        index: new InMemoryExactVectorIndex(),
        provider,
      }).retrieve('库存是多少？')
      expect(result.mode).toBe('keyword_fallback')
      expect(provider.readiness).toBe('not_loaded')
    } finally {
      store.close()
    }
  })

  it('deletes a tampered q4 cache artifact and locks failed until an explicit retry', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'qaing-bge-integrity-'))
    const revision = 'abcdef1234567890'
    const modelPath = localBgeModelPath(cacheDir, revision, 'q4')
    await mkdir(dirname(modelPath), { recursive: true })
    await writeFile(modelPath, 'tampered-model-fixture')
    const { factory, calls } = fixtureFactory()
    const provider = new LocalBgeWorkerRuntime({
      revision,
      cacheDir,
      pipelineFactory: factory,
      verifyModelFile: 'default',
    })
    try {
      await expect(provider.prepare({ signal: new AbortController().signal })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      })
      expect(provider.readiness).toBe('failed')
      await expect(access(modelPath)).rejects.toThrow()
      await expect(provider.prepare({ signal: new AbortController().signal })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      })
      expect(calls).toHaveBeenCalledTimes(1)
      provider.retryPreparation()
      expect(provider.readiness).toBe('not_loaded')
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
