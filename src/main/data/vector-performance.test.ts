import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { StoredVector } from './types'
import { InMemoryExactVectorIndex } from './vector'

describe('exact vector performance gate', () => {
  it('keeps warmed 20k x 1024 cosine search p95 within 100 ms', () => {
    const dimension = 1_024
    const count = 20_000
    const metadata = { modelId: 'fixture/performance', modelRevision: 'v1', dimension, normalized: true } as const
    let records: StoredVector[] = Array.from({ length: count }, (_unused, index) => {
      const vector = new Float32Array(dimension)
      let state = Math.imul(index + 1, 0x9e3779b1) >>> 0
      for (let dimensionIndex = 0; dimensionIndex < dimension; dimensionIndex += 1) {
        state = (Math.imul(state ^ dimensionIndex, 1_664_525) + 1_013_904_223) >>> 0
        vector[dimensionIndex] = (state & 0x8000_0000) === 0 ? -0.03125 : 0.03125
      }
      return {
        ownerType: 'chunk',
        ownerId: `chunk-${index.toString().padStart(5, '0')}`,
        documentId: `document-${Math.floor(index / 10)}`,
        title: 'performance fixture',
        excerpt: 'performance fixture',
        contentHash: `hash-${index}`,
        vector,
        metadata,
      }
    })
    const index = new InMemoryExactVectorIndex(count)
    index.replaceAll(records)
    records = []

    const query = new Float32Array(dimension)
    for (let index = 0; index < dimension; index += 1) query[index] = ((index * 19) % 31) - 15
    const samples: number[] = []
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const started = performance.now()
      const hits = index.search(query, 10)
      const duration = performance.now() - started
      expect(hits).toHaveLength(10)
      if (iteration >= 10) samples.push(duration)
    }
    samples.sort((left, right) => left - right)
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
    expect(p95).toBeLessThanOrEqual(100)
  }, 30_000)
})
