import { BGE_MAX_INPUT_TOKENS, type TokenCounter } from './chunking'
import type { DataStore, EmbeddingWrite, StoredVectorSource } from './database'
import type { EmbeddingMetadata, IndexOwnerType, StoredVector } from './types'

export interface EmbedOptions {
  readonly signal: AbortSignal
}

export interface EmbeddingProvider extends TokenCounter {
  readonly usage: 'production' | 'test-only'
  readonly readiness?: 'not_loaded' | 'loading' | 'ready' | 'failed'
  readonly metadata: EmbeddingMetadata
  readonly maxBatchSize: number
  prepare?(options: EmbedOptions): Promise<void>
  embed(texts: readonly string[], options: EmbedOptions): Promise<readonly Float32Array[]>
}

export interface VectorSearchHit {
  readonly ownerType: IndexOwnerType
  readonly ownerId: string
  readonly documentId: string
  readonly title: string
  readonly excerpt: string
  readonly score: number
}

export interface VectorIndex {
  readonly size: number
  readonly dimension: number | null
  readonly capacity: number
  clear(): void
  replaceAll(records: readonly StoredVector[]): void
  upsert(records: readonly StoredVector[]): void
  delete(ownerType: IndexOwnerType, ownerId: string): boolean
  search(
    query: Float32Array,
    limit: number,
    minimumScore?: number,
    ownerType?: IndexOwnerType,
    allowedOwnerIds?: ReadonlySet<string>,
  ): readonly VectorSearchHit[]
}

interface IndexedVector {
  readonly ownerType: IndexOwnerType
  readonly ownerId: string
  readonly documentId: string
  readonly title: string
  readonly excerpt: string
  readonly vector: Float32Array
}

interface CompiledVectors {
  readonly dimension: number
  readonly records: readonly IndexedVector[]
  readonly matrix: Float32Array
  readonly ranges: Readonly<Partial<Record<IndexOwnerType, { readonly start: number; readonly end: number }>>>
}

function ownerTypeRanges(
  records: readonly IndexedVector[],
): Readonly<Partial<Record<IndexOwnerType, { readonly start: number; readonly end: number }>>> {
  const ranges: Partial<Record<IndexOwnerType, { start: number; end: number }>> = {}
  for (let index = 0; index < records.length; index += 1) {
    const ownerType = records[index]?.ownerType
    if (ownerType === undefined) continue
    const current = ranges[ownerType]
    if (current === undefined) ranges[ownerType] = { start: index, end: index + 1 }
    else current.end = index + 1
  }
  return ranges
}

export class EmbeddingProviderError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE' | 'INVALID_PROVIDER' | 'INVALID_RESPONSE' | 'TIMEOUT',
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'EmbeddingProviderError'
  }
}

function vectorKey(ownerType: IndexOwnerType, ownerId: string): string {
  return `${ownerType}:${ownerId}`
}

function compareVectorKeys(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function assertProvider(provider: EmbeddingProvider, allowTestProvider: boolean): void {
  if (provider.usage === 'test-only' && !allowTestProvider) {
    throw new EmbeddingProviderError(
      'INVALID_PROVIDER',
      'A test-only embedding provider cannot be used by the production runtime',
      false,
    )
  }
  if (provider.maxInputTokens !== BGE_MAX_INPUT_TOKENS) {
    throw new EmbeddingProviderError(
      'INVALID_PROVIDER',
      `The embedding provider must enforce a ${BGE_MAX_INPUT_TOKENS}-token input limit`,
      false,
    )
  }
  if (
    !provider.metadata.normalized ||
    !Number.isSafeInteger(provider.metadata.dimension) ||
    provider.metadata.dimension < 1 ||
    !provider.metadata.modelId ||
    !provider.metadata.modelRevision ||
    !Number.isSafeInteger(provider.maxBatchSize) ||
    provider.maxBatchSize < 1
  ) {
    throw new EmbeddingProviderError('INVALID_PROVIDER', 'The embedding provider metadata is invalid', false)
  }
}

function vectorNormalizationMultiplier(vector: Float32Array, expectedDimension?: number): number {
  if (vector.length === 0 || (expectedDimension !== undefined && vector.length !== expectedDimension)) {
    throw new EmbeddingProviderError('INVALID_RESPONSE', 'Embedding dimension mismatch', false)
  }
  let normSquared = 0
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] as number
    if (!Number.isFinite(value)) {
      throw new EmbeddingProviderError('INVALID_RESPONSE', 'Embedding contains a non-finite value', false)
    }
    normSquared += value * value
  }
  if (normSquared <= Number.EPSILON) {
    throw new EmbeddingProviderError('INVALID_RESPONSE', 'Embedding has zero magnitude', false)
  }
  return 1 / Math.sqrt(normSquared)
}

export function normalizeVector(vector: Float32Array, expectedDimension?: number): Float32Array {
  const multiplier = vectorNormalizationMultiplier(vector, expectedDimension)
  const normalized = new Float32Array(vector.length)
  for (let index = 0; index < vector.length; index += 1) normalized[index] = (vector[index] ?? 0) * multiplier
  return normalized
}

/**
 * An exact cosine index for the <=20k MVP corpus. It compiles map entries into
 * one contiguous Float32Array so the query hot path does not chase objects.
 */
export class InMemoryExactVectorIndex implements VectorIndex {
  readonly #capacity: number
  #records = new Map<string, IndexedVector>()
  #dimension: number | null = null
  #compiled: CompiledVectors | null = null

  constructor(capacity = 20_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Vector index capacity must be positive')
    this.#capacity = capacity
  }

  get size(): number {
    return this.#records.size
  }

  get dimension(): number | null {
    return this.#dimension
  }

  get capacity(): number {
    return this.#capacity
  }

  clear(): void {
    this.#records.clear()
    this.#dimension = null
    this.#compiled = null
  }

  replaceAll(records: readonly StoredVector[]): void {
    if (records.length === 0) {
      this.#records = new Map()
      this.#dimension = null
      this.#compiled = null
      return
    }

    const expectedDimension = records[0]?.metadata.dimension
    if (!expectedDimension || !Number.isSafeInteger(expectedDimension)) {
      throw new Error('Vector records must have a positive dimension')
    }

    // Validate the complete replacement before allocating or publishing its
    // matrix. Keeping the old fields untouched until the final assignments is
    // what gives replaceAll its rollback semantics on malformed input or OOM.
    const latestByKey = new Map<
      string,
      { readonly source: StoredVector; readonly normalizationMultiplier: number }
    >()
    for (const record of records) {
      if (record.metadata.dimension !== expectedDimension || record.vector.length !== expectedDimension) {
        throw new Error('All exact-index vectors must have the same dimension')
      }
      const key = vectorKey(record.ownerType, record.ownerId)
      if (!latestByKey.has(key) && latestByKey.size >= this.#capacity) {
        throw new Error(`Exact vector index capacity of ${this.#capacity} records exceeded`)
      }
      latestByKey.set(key, {
        source: record,
        normalizationMultiplier: vectorNormalizationMultiplier(record.vector, expectedDimension),
      })
    }

    const ordered = [...latestByKey.entries()].sort(([left], [right]) => compareVectorKeys(left, right))
    const matrix = new Float32Array(ordered.length * expectedDimension)
    const nextRecords = new Map<string, IndexedVector>()
    const compiledRecords = new Array<IndexedVector>(ordered.length)
    for (let recordIndex = 0; recordIndex < ordered.length; recordIndex += 1) {
      const [key, prepared] = ordered[recordIndex] as [
        string,
        { readonly source: StoredVector; readonly normalizationMultiplier: number },
      ]
      const offset = recordIndex * expectedDimension
      for (let dimensionIndex = 0; dimensionIndex < expectedDimension; dimensionIndex += 1) {
        matrix[offset + dimensionIndex] =
          (prepared.source.vector[dimensionIndex] as number) * prepared.normalizationMultiplier
      }
      const indexed: IndexedVector = {
        ownerType: prepared.source.ownerType,
        ownerId: prepared.source.ownerId,
        documentId: prepared.source.documentId,
        title: prepared.source.title,
        excerpt: prepared.source.excerpt,
        vector: matrix.subarray(offset, offset + expectedDimension),
      }
      nextRecords.set(key, indexed)
      compiledRecords[recordIndex] = indexed
    }

    this.#records = nextRecords
    this.#dimension = expectedDimension
    this.#compiled = {
      dimension: expectedDimension,
      records: compiledRecords,
      matrix,
      ranges: ownerTypeRanges(compiledRecords),
    }
  }

  upsert(records: readonly StoredVector[]): void {
    if (records.length === 0) return
    const incomingKeys = new Set(records.map((record) => vectorKey(record.ownerType, record.ownerId)))
    let newCount = 0
    for (const key of incomingKeys) if (!this.#records.has(key)) newCount += 1
    if (this.#records.size + newCount > this.#capacity) {
      throw new Error(`Exact vector index capacity of ${this.#capacity} records exceeded`)
    }

    const expectedDimension = this.#dimension ?? records[0]?.metadata.dimension
    if (!expectedDimension) throw new Error('Vector records must have a positive dimension')
    const prepared = records.map((record): IndexedVector => {
      if (record.metadata.dimension !== expectedDimension || record.vector.length !== expectedDimension) {
        throw new Error('All exact-index vectors must have the same dimension')
      }
      return {
        ownerType: record.ownerType,
        ownerId: record.ownerId,
        documentId: record.documentId,
        title: record.title,
        excerpt: record.excerpt,
        vector: normalizeVector(record.vector, expectedDimension),
      }
    })

    this.#dimension = expectedDimension
    for (const record of prepared) this.#records.set(vectorKey(record.ownerType, record.ownerId), record)
    this.#compiled = null
  }

  delete(ownerType: IndexOwnerType, ownerId: string): boolean {
    const deleted = this.#records.delete(vectorKey(ownerType, ownerId))
    if (deleted) {
      this.#compiled = null
      if (this.#records.size === 0) this.#dimension = null
    }
    return deleted
  }

  search(
    query: Float32Array,
    limit: number,
    minimumScore = -1,
    ownerType?: IndexOwnerType,
    allowedOwnerIds?: ReadonlySet<string>,
  ): readonly VectorSearchHit[] {
    if (this.#records.size === 0 || allowedOwnerIds?.size === 0) return []
    const integerLimit = Math.floor(limit)
    const boundedLimit = Number.isNaN(integerLimit) ? 1 : Math.max(1, Math.min(100, integerLimit))
    const compiled = this.#getCompiled()
    const normalizedQuery = normalizeVector(query, compiled.dimension)
    const dimension = compiled.dimension
    const matrix = compiled.matrix
    const compiledRecords = compiled.records
    const range = ownerType === undefined
      ? { start: 0, end: compiledRecords.length }
      : (compiled.ranges[ownerType] ?? { start: 0, end: 0 })
    const bestRecordIndices = new Int32Array(boundedLimit)
    const bestScores = new Float64Array(boundedLimit)
    const unrolledDimension = dimension - (dimension % 4)
    let bestCount = 0

    for (let recordIndex = range.start; recordIndex < range.end; recordIndex += 1) {
      if (allowedOwnerIds && !allowedOwnerIds.has((compiledRecords[recordIndex] as IndexedVector).ownerId)) continue
      let score = 0
      const offset = recordIndex * dimension
      let dimensionIndex = 0
      for (; dimensionIndex < unrolledDimension; dimensionIndex += 4) {
        score += (matrix[offset + dimensionIndex] as number) * (normalizedQuery[dimensionIndex] as number)
        score +=
          (matrix[offset + dimensionIndex + 1] as number) * (normalizedQuery[dimensionIndex + 1] as number)
        score +=
          (matrix[offset + dimensionIndex + 2] as number) * (normalizedQuery[dimensionIndex + 2] as number)
        score +=
          (matrix[offset + dimensionIndex + 3] as number) * (normalizedQuery[dimensionIndex + 3] as number)
      }
      for (; dimensionIndex < dimension; dimensionIndex += 1) {
        score += (matrix[offset + dimensionIndex] as number) * (normalizedQuery[dimensionIndex] as number)
      }
      if (score < minimumScore) continue

      if (bestCount === boundedLimit) {
        const worstSlot = boundedLimit - 1
        const worstScore = bestScores[worstSlot] as number
        const worstRecordIndex = bestRecordIndices[worstSlot] as number
        if (score < worstScore || (score === worstScore && recordIndex > worstRecordIndex)) continue
      }

      let position = bestCount < boundedLimit ? bestCount : boundedLimit - 1
      if (bestCount < boundedLimit) bestCount += 1
      while (position > 0) {
        const precedingPosition = position - 1
        const precedingScore = bestScores[precedingPosition] as number
        const precedingRecordIndex = bestRecordIndices[precedingPosition] as number
        if (
          precedingScore > score ||
          (precedingScore === score && precedingRecordIndex < recordIndex)
        ) {
          break
        }
        bestScores[position] = precedingScore
        bestRecordIndices[position] = precedingRecordIndex
        position -= 1
      }
      bestScores[position] = score
      bestRecordIndices[position] = recordIndex
    }

    const hits = new Array<VectorSearchHit>(bestCount)
    for (let index = 0; index < bestCount; index += 1) {
      const record = compiledRecords[bestRecordIndices[index] as number] as IndexedVector
      hits[index] = {
        ownerType: record.ownerType,
        ownerId: record.ownerId,
        documentId: record.documentId,
        title: record.title,
        excerpt: record.excerpt,
        score: bestScores[index] as number,
      }
    }
    return hits
  }

  #getCompiled(): CompiledVectors {
    if (this.#compiled) return this.#compiled
    if (!this.#dimension) throw new Error('Cannot compile an empty vector index')
    const dimension = this.#dimension
    const sourceRecords = [...this.#records.values()].sort((left, right) =>
      compareVectorKeys(vectorKey(left.ownerType, left.ownerId), vectorKey(right.ownerType, right.ownerId)),
    )
    const matrix = new Float32Array(sourceRecords.length * dimension)
    for (const [index, record] of sourceRecords.entries()) matrix.set(record.vector, index * dimension)
    const records = sourceRecords.map((record, index): IndexedVector => ({
      ownerType: record.ownerType,
      ownerId: record.ownerId,
      documentId: record.documentId,
      title: record.title,
      excerpt: record.excerpt,
      vector: matrix.subarray(index * dimension, (index + 1) * dimension),
    }))
    // Repoint map entries at views into the contiguous matrix. This keeps one
    // steady-state vector allocation instead of retaining a second 80 MiB copy.
    const compiledRecordMap = new Map<string, IndexedVector>()
    for (const record of records) compiledRecordMap.set(vectorKey(record.ownerType, record.ownerId), record)
    this.#records = compiledRecordMap
    this.#compiled = { dimension, records, matrix, ranges: ownerTypeRanges(records) }
    return this.#compiled
  }
}

interface TimedSignal {
  readonly signal: AbortSignal
  cleanup(): void
  didTimeout(): boolean
}

function createTimedSignal(parent: AbortSignal | undefined, timeoutMs: number): TimedSignal {
  const controller = new AbortController()
  let timedOut = false
  const abortFromParent = (): void => controller.abort(parent?.reason)
  if (parent?.aborted) abortFromParent()
  else parent?.addEventListener('abort', abortFromParent, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('Embedding request timed out'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      parent?.removeEventListener('abort', abortFromParent)
    },
    didTimeout: () => timedOut,
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason as unknown
  return reason instanceof Error ? reason : new Error('Embedding request was aborted')
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export async function embedTexts(
  provider: EmbeddingProvider,
  texts: readonly string[],
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly allowTestProvider?: boolean } = {},
): Promise<readonly Float32Array[]> {
  assertProvider(provider, options.allowTestProvider ?? false)
  if (texts.length === 0) return []
  if (texts.length > provider.maxBatchSize) throw new Error('Embedding batch exceeds the provider maximum')
  for (const text of texts) {
    const count = provider.countTokens(text)
    if (!Number.isSafeInteger(count) || count < 1 || count > provider.maxInputTokens) {
      throw new Error('Embedding input is empty or exceeds the provider token limit')
    }
  }

  const timed = createTimedSignal(options.signal, options.timeoutMs ?? 30_000)
  try {
    const vectors = await raceWithAbort(provider.embed(texts, { signal: timed.signal }), timed.signal)
    if (vectors.length !== texts.length) {
      throw new EmbeddingProviderError('INVALID_RESPONSE', 'Embedding response count mismatch', false)
    }
    return vectors.map((vector) => normalizeVector(vector, provider.metadata.dimension))
  } catch (error) {
    if (error instanceof EmbeddingProviderError) throw error
    if (timed.didTimeout()) {
      throw new EmbeddingProviderError('TIMEOUT', 'Embedding provider timed out', true, { cause: error })
    }
    if (options.signal?.aborted) throw options.signal.reason ?? error
    throw new EmbeddingProviderError('UNAVAILABLE', 'Embedding provider is unavailable', true, { cause: error })
  } finally {
    timed.cleanup()
  }
}

export interface IndexingResult {
  readonly mode: 'hybrid' | 'keyword_fallback' | 'index_loading'
  readonly indexed: number
  readonly remaining: number
  readonly failed: number
}

export class EmbeddingIndexer {
  readonly #store: DataStore
  readonly #index: VectorIndex
  readonly #provider: EmbeddingProvider | null
  readonly #allowTestProvider: boolean
  readonly #timeoutMs: number
  readonly #prepareTimeoutMs: number
  #capacityExceeded = false

  constructor(options: {
    readonly store: DataStore
    readonly index: VectorIndex
    readonly provider?: EmbeddingProvider
    readonly allowTestProvider?: boolean
    readonly timeoutMs?: number
    readonly prepareTimeoutMs?: number
  }) {
    this.#store = options.store
    this.#index = options.index
    this.#provider = options.provider ?? null
    this.#allowTestProvider = options.allowTestProvider ?? false
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#prepareTimeoutMs = options.prepareTimeoutMs ?? 15 * 60_000
    if (!Number.isSafeInteger(this.#prepareTimeoutMs) || this.#prepareTimeoutMs < 1) {
      throw new Error('Embedding provider preparation timeout must be a positive integer')
    }
    if (this.#provider) assertProvider(this.#provider, this.#allowTestProvider)
  }

  get mode(): IndexingResult['mode'] {
    if (this.#capacityExceeded) return 'keyword_fallback'
    if (!this.#provider || this.#provider.readiness === 'failed') return 'keyword_fallback'
    if (this.#provider.readiness !== undefined && this.#provider.readiness !== 'ready') return 'index_loading'
    return 'hybrid'
  }

  initialize(): IndexingResult {
    if (!this.#provider) {
      this.#index.clear()
      return { mode: 'keyword_fallback', indexed: 0, remaining: 0, failed: 0 }
    }
    this.#store.recoverInterruptedIndexJobs()
    this.#store.prepareEmbeddingJobs(this.#provider.metadata)
    const pending = this.#store.listUnembeddedOwners(this.#provider.metadata, 20_001)
    const remaining = pending.length
    const storedCount = this.#store.countStoredVectors()
    this.#capacityExceeded =
      storedCount > this.#index.capacity ||
      (storedCount >= this.#index.capacity && pending.some((source) => !source.hasEmbedding))
    if (this.#capacityExceeded) {
      this.#index.clear()
      return { mode: 'keyword_fallback', indexed: 0, remaining, failed: 0 }
    }
    const stored = this.#store.loadStoredVectors(this.#provider.metadata)
    this.#index.replaceAll(stored)
    return { mode: this.mode, indexed: stored.length, remaining, failed: 0 }
  }

  async indexPending(options: { readonly limit?: number; readonly signal?: AbortSignal } = {}): Promise<IndexingResult> {
    if (!this.#provider) return { mode: 'keyword_fallback', indexed: 0, remaining: 0, failed: 0 }
    if (this.#provider.prepare) {
      const timed = createTimedSignal(options.signal, this.#prepareTimeoutMs)
      try {
        await raceWithAbort(this.#provider.prepare({ signal: timed.signal }), timed.signal)
      } catch (error) {
        if (timed.didTimeout()) {
          throw new EmbeddingProviderError('TIMEOUT', 'Embedding provider initialization timed out', true, {
            cause: error,
          })
        }
        throw error
      } finally {
        timed.cleanup()
      }
    }
    const limit = Math.max(1, Math.min(20_000, options.limit ?? this.#provider.maxBatchSize))
    this.#store.prepareEmbeddingJobs(this.#provider.metadata)
    const candidates = this.#store.listUnembeddedOwners(this.#provider.metadata, limit)
    const sources: StoredVectorSource[] = []
    let failed = 0
    let availableSlots = Math.max(0, this.#index.capacity - this.#store.countStoredVectors())
    let capacityExceeded = false
    for (const source of candidates) {
      const tokenCount = this.#provider.countTokens(source.text)
      if (Number.isSafeInteger(tokenCount) && tokenCount >= 1 && tokenCount <= this.#provider.maxInputTokens) {
        if (source.hasEmbedding || availableSlots > 0) {
          sources.push(source)
          if (!source.hasEmbedding) availableSlots -= 1
        } else {
          capacityExceeded = true
        }
      } else {
        this.#store.failOwnerIndexing(
          source.ownerType,
          source.ownerId,
          source.contentHash,
          'INPUT_TOKEN_LIMIT',
          this.#provider.metadata,
        )
        failed += 1
      }
    }
    let indexed = 0
    for (let offset = 0; offset < sources.length; offset += this.#provider.maxBatchSize) {
      const batch = sources.slice(offset, offset + this.#provider.maxBatchSize)
      const vectors = await embedTexts(
        this.#provider,
        batch.map((source) => source.text),
        {
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: this.#timeoutMs,
          allowTestProvider: this.#allowTestProvider,
        },
      )
      const records = batch.map((source, index) => this.#toStoredVector(source, vectors[index] as Float32Array))
      const writes: EmbeddingWrite[] = records.map((record) => ({
        ownerType: record.ownerType,
        ownerId: record.ownerId,
        contentHash: record.contentHash,
        vector: record.vector,
        metadata: record.metadata,
      }))
      this.#store.storeEmbeddings(writes, Date.now(), this.#index.capacity)
      indexed += records.length
    }
    const remaining = this.#store.listUnembeddedOwners(this.#provider.metadata, 20_001).length
    this.#capacityExceeded = capacityExceeded
    if (this.#capacityExceeded) this.#index.clear()
    else this.#index.replaceAll(this.#store.loadStoredVectors(this.#provider.metadata))
    return { mode: this.mode, indexed, remaining, failed }
  }

  #toStoredVector(source: StoredVectorSource, vector: Float32Array): StoredVector {
    if (!this.#provider) throw new Error('Embedding provider is not configured')
    return {
      ownerType: source.ownerType,
      ownerId: source.ownerId,
      documentId: source.documentId,
      title: source.title,
      excerpt: source.excerpt,
      contentHash: source.contentHash,
      vector,
      metadata: this.#provider.metadata,
    }
  }
}
