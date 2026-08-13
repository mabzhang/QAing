import { describe, expect, it } from 'vitest'
import { LOCAL_BGE_DIMENSION, LocalBgeWorkerRuntime } from './local-bge-provider'

const runRealModel = process.env['QAING_RUN_REAL_BGE'] === '1'
const cacheDir = process.env['QAING_BGE_CACHE_DIR']

describe.runIf(runRealModel)('LocalBgeEmbeddingProvider real Apple Silicon smoke', () => {
  it('loads the checksum-pinned q4 artifact and emits normalized 1024-d vectors', async () => {
    if (!cacheDir) throw new Error('QAING_BGE_CACHE_DIR is required for the real-model smoke test')
    const provider = new LocalBgeWorkerRuntime({ cacheDir })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Real BGE smoke timed out')), 120_000)
    try {
      await provider.prepare({ signal: controller.signal })
      const vectors = await provider.embed(
        ['QAing 是一款实时语音知识助手。', '退款期限是多少？'],
        { signal: controller.signal },
      )
      expect(provider.readiness).toBe('ready')
      expect(provider.countTokens('QAing 是一款实时语音知识助手。')).toBeGreaterThan(2)
      expect(vectors).toHaveLength(2)
      for (const vector of vectors) {
        expect(vector).toHaveLength(LOCAL_BGE_DIMENSION)
        const squaredNorm = vector.reduce((sum, value) => sum + value * value, 0)
        expect(Math.sqrt(squaredNorm)).toBeCloseTo(1, 4)
        expect(vector.every(Number.isFinite)).toBe(true)
      }
    } finally {
      clearTimeout(timeout)
    }
  }, 125_000)
})
