import { describe, expect, it } from 'vitest'
import type { IndexOwnerType, StoredVector } from './types'
import { InMemoryExactVectorIndex, normalizeVector } from './vector'

const METADATA = {
  modelId: 'fixture/vector-index',
  modelRevision: 'v1',
  dimension: 5,
  normalized: true,
} as const

function record(
  ownerId: string,
  values: readonly number[],
  ownerType: IndexOwnerType = 'chunk',
): StoredVector {
  return {
    ownerType,
    ownerId,
    documentId: `document-${ownerId}`,
    title: `title-${ownerId}`,
    excerpt: `excerpt-${ownerId}`,
    contentHash: `hash-${ownerId}`,
    vector: Float32Array.from(values),
    metadata: { ...METADATA, dimension: values.length },
  }
}

function keyOf(value: Pick<StoredVector, 'ownerType' | 'ownerId'>): string {
  return `${value.ownerType}:${value.ownerId}`
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function bruteForce(
  records: readonly StoredVector[],
  query: Float32Array,
  limit: number,
  minimumScore: number,
): readonly { readonly key: string; readonly score: number }[] {
  const normalizedQuery = normalizeVector(query, query.length)
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  return records
    .map((source) => {
      const vector = normalizeVector(source.vector, query.length)
      let score = 0
      for (let index = 0; index < query.length; index += 1) {
        score += (vector[index] as number) * (normalizedQuery[index] as number)
      }
      return { key: keyOf(source), score }
    })
    .filter((candidate) => candidate.score >= minimumScore)
    .sort((left, right) => right.score - left.score || compareKeys(left.key, right.key))
    .slice(0, boundedLimit)
}

function deterministicRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('in-memory exact vector index', () => {
  it('matches an independent brute-force cosine ranking for dense vectors', () => {
    const random = deterministicRandom(0x51a7e)
    const dimension = 31
    const records = Array.from({ length: 257 }, (_unused, recordIndex) =>
      record(
        `dense-${recordIndex.toString().padStart(3, '0')}`,
        Array.from({ length: dimension }, () => random() * 2 - 1),
        recordIndex % 7 === 0 ? 'preset_qa' : 'chunk',
      ),
    )
    const query = Float32Array.from({ length: dimension }, () => random() * 2 - 1)
    const index = new InMemoryExactVectorIndex(records.length)
    index.replaceAll(records)

    for (const limit of [1, 10, 100]) {
      for (const minimumScore of [-1, 0, 0.25]) {
        const expected = bruteForce(records, query, limit, minimumScore)
        const actual = index.search(query, limit, minimumScore)
        expect(actual.map((hit) => `${hit.ownerType}:${hit.ownerId}`)).toEqual(
          expected.map((hit) => hit.key),
        )
        expect(actual).toHaveLength(expected.length)
        for (let resultIndex = 0; resultIndex < actual.length; resultIndex += 1) {
          expect(Math.abs((actual[resultIndex]?.score ?? 0) - (expected[resultIndex]?.score ?? 0))).toBeLessThanOrEqual(
            1e-6,
          )
        }
      }
    }
  })

  it('keeps exact ties in ascending stable owner key order', () => {
    const records = [
      record('z', [1, 0]),
      record('2', [1, 0]),
      record('a', [1, 0]),
      record('0', [1, 0], 'preset_qa'),
      record('A', [1, 0]),
      record('10', [1, 0]),
    ]
    const index = new InMemoryExactVectorIndex(records.length)
    index.replaceAll(records)

    expect(index.search(new Float32Array([1, 0]), 100).map((hit) => `${hit.ownerType}:${hit.ownerId}`)).toEqual([
      'chunk:10',
      'chunk:2',
      'chunk:A',
      'chunk:a',
      'chunk:z',
      'preset_qa:0',
    ])
  })

  it('filters before top-k and preserves limit clamping and query validation', () => {
    const index = new InMemoryExactVectorIndex()
    index.replaceAll([record('positive', [1, 0]), record('zero', [0, 1]), record('negative', [-1, 0])])

    expect(index.search(new Float32Array([1, 0]), 10, 0).map((hit) => hit.ownerId)).toEqual(['positive', 'zero'])
    expect(index.search(new Float32Array([1, 0]), 0)).toHaveLength(1)
    expect(index.search(new Float32Array([1, 0]), Number.NaN)).toHaveLength(1)
    expect(index.search(new Float32Array([1, 0]), 1_000)).toHaveLength(3)
    expect(() => index.search(new Float32Array([1, 0, 0]), 1)).toThrow(/dimension/i)
    expect(() => index.search(new Float32Array([0, 0]), 1)).toThrow(/zero magnitude/i)
    expect(() => index.search(new Float32Array([Number.NaN, 0]), 1)).toThrow(/non-finite/i)
    expect(() => index.search(new Float32Array([Number.POSITIVE_INFINITY, 0]), 1)).toThrow(/non-finite/i)
  })

  it('keeps the old index byte-for-byte observable when replaceAll fails', () => {
    const index = new InMemoryExactVectorIndex(2)
    index.replaceAll([record('old-a', [1, 0]), record('old-b', [0, 1])])
    const query = new Float32Array([1, 0])
    const before = index.search(query, 10)
    const beforeSize = index.size
    const beforeDimension = index.dimension
    const invalidReplacements: readonly (readonly StoredVector[])[] = [
      [record('new-a', [1, 0]), record('new-b', [0, 1]), record('new-c', [-1, 0])],
      [record('new-a', [1, 0]), record('new-b', [1, 0, 0])],
      [record('new-a', [0, 0])],
      [record('new-a', [Number.NaN, 0])],
      [record('new-a', [Number.POSITIVE_INFINITY, 0])],
    ]

    for (const invalid of invalidReplacements) {
      expect(() => index.replaceAll(invalid)).toThrow()
      expect(index.size).toBe(beforeSize)
      expect(index.dimension).toBe(beforeDimension)
      expect(index.search(query, 10)).toEqual(before)
    }
  })

  it('counts unique owners for capacity and keeps upsert, delete, and clear semantics', () => {
    const index = new InMemoryExactVectorIndex(1)
    index.replaceAll([record('same', [1, 0]), record('same', [0, 1])])
    expect(index.size).toBe(1)
    expect(index.search(new Float32Array([0, 1]), 1)[0]).toMatchObject({ ownerId: 'same', score: 1 })

    index.upsert([record('same', [-1, 0])])
    expect(index.size).toBe(1)
    expect(index.search(new Float32Array([-1, 0]), 1)[0]).toMatchObject({ ownerId: 'same', score: 1 })
    expect(() => index.upsert([record('other', [1, 0])])).toThrow(/capacity/i)
    expect(index.search(new Float32Array([-1, 0]), 1)[0]?.ownerId).toBe('same')

    expect(index.delete('chunk', 'missing')).toBe(false)
    expect(index.delete('chunk', 'same')).toBe(true)
    expect(index.size).toBe(0)
    expect(index.dimension).toBeNull()
    expect(index.search(new Float32Array([Number.NaN]), 1)).toEqual([])

    index.upsert([record('restored', [1, 0])])
    index.clear()
    expect(index.size).toBe(0)
    expect(index.dimension).toBeNull()
  })
})
