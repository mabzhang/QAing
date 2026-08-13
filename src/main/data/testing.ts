import { createHash } from 'node:crypto'
import { BGE_MAX_INPUT_TOKENS } from './chunking'
import { normalizeVector, type EmbeddingProvider } from './vector'

/** Test fixture only. Production construction rejects this provider by default. */
export class TestOnlyDeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly usage = 'test-only' as const
  readonly readiness = 'ready' as const
  readonly modelId = 'test-only/deterministic-lexical'
  readonly modelRevision = 'fixture-v1'
  readonly maxInputTokens = BGE_MAX_INPUT_TOKENS
  readonly maxBatchSize = 64
  readonly metadata

  constructor(dimension = 64) {
    if (!Number.isSafeInteger(dimension) || dimension < 8) throw new Error('Test vector dimension must be at least 8')
    this.metadata = {
      modelId: this.modelId,
      modelRevision: this.modelRevision,
      dimension,
      normalized: true,
    } as const
  }

  countTokens(text: string): number {
    return text.trim() ? [...text.normalize('NFKC')].length + 2 : 0
  }

  embed(texts: readonly string[], options: { readonly signal: AbortSignal }): Promise<readonly Float32Array[]> {
    if (options.signal.aborted) return Promise.reject(new Error('Aborted'))
    return Promise.resolve(texts.map((text) => this.#embedOne(text)))
  }

  #embedOne(text: string): Float32Array {
    const normalized = [...text.normalize('NFKC').toLocaleLowerCase('zh-CN')].filter((character) => !/\s/u.test(character))
    const features: string[] = [...normalized]
    for (let index = 0; index + 1 < normalized.length; index += 1) {
      features.push(`${normalized[index] as string}${normalized[index + 1] as string}`)
    }
    if (features.length === 0) features.push('<empty>')

    const vector = new Float32Array(this.metadata.dimension)
    for (const feature of features) {
      const digest = createHash('sha256').update(feature).digest()
      const position = digest.readUInt32LE(0) % vector.length
      const sign = (digest[4] ?? 0) % 2 === 0 ? 1 : -1
      vector[position] = (vector[position] ?? 0) + sign
    }
    return normalizeVector(vector, this.metadata.dimension)
  }
}
