import { normalizeContent } from './hash'

export const BGE_MAX_INPUT_TOKENS = 512
export const DEFAULT_CHUNK_TARGET_TOKENS = 480
export const DEFERRED_IMPORT_COUNTER_ID = 'qaing/conservative-bge-import-counter'
export const DEFERRED_IMPORT_COUNTER_REVISION = '1'

/**
 * The counter must use the same tokenizer and special-token policy as the
 * production embedding model. Character estimates are intentionally not part
 * of this production contract.
 */
export interface TokenCounter {
  readonly modelId: string
  readonly modelRevision: string
  readonly maxInputTokens: number
  countTokens(text: string): number
}

export interface TextChunk {
  readonly content: string
  readonly tokenCount: number
}

export interface ChunkTextOptions {
  readonly targetTokens?: number
}

/**
 * A model-free upper-bound counter used only to persist imports before the
 * embedding worker is available. BGE's worker tokenizer remains authoritative
 * and revalidates every chunk before inference.
 *
 * NFKD expands compatibility characters before counting Unicode scalars. The
 * two reserved positions account for BERT's CLS/SEP tokens. This deliberately
 * produces smaller chunks than the real tokenizer rather than loading ORT in
 * the Electron main process.
 */
export class DeferredImportTokenCounter implements TokenCounter {
  readonly modelId = DEFERRED_IMPORT_COUNTER_ID
  readonly modelRevision = DEFERRED_IMPORT_COUNTER_REVISION
  readonly maxInputTokens = BGE_MAX_INPUT_TOKENS

  countTokens(text: string): number {
    return [...text.normalize('NFKD')].length + 2
  }
}

function assertTokenCount(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('TokenCounter returned an invalid token count')
  }
  return count
}

function semanticUnits(content: string): readonly string[] {
  const units: string[] = []
  for (const paragraph of content.split(/\n{2,}/u)) {
    for (const line of paragraph.split('\n')) {
      const normalizedLine = line.trim()
      if (!normalizedLine) continue
      const sentences = normalizedLine.match(/[^\u3002\uff01\uff1f!?\uff1b;]+[\u3002\uff01\uff1f!?\uff1b;]*/gu)
      if (!sentences) {
        units.push(normalizedLine)
        continue
      }
      for (const sentence of sentences) {
        const unit = sentence.trim()
        if (unit) units.push(unit)
      }
    }
  }
  return units
}

function preferredBoundary(characters: readonly string[], upperBound: number): number {
  const minimum = Math.max(1, Math.floor(upperBound * 0.6))
  for (let index = upperBound; index >= minimum; index -= 1) {
    const character = characters[index - 1]
    if (character && /[\s\u3002\uff01\uff1f!?\uff1b;,\uff0c\u3001:]/u.test(character)) return index
  }
  return upperBound
}

function splitOversizedUnit(unit: string, targetTokens: number, counter: TokenCounter): readonly TextChunk[] {
  const output: TextChunk[] = []
  let remaining = [...unit]

  while (remaining.length > 0) {
    let low = 1
    let high = remaining.length
    let best = 0
    let bestCount = 0

    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = remaining.slice(0, middle).join('')
      const count = assertTokenCount(counter.countTokens(candidate))
      if (count <= targetTokens) {
        best = middle
        bestCount = count
        low = middle + 1
      } else {
        high = middle - 1
      }
    }

    if (best === 0) {
      throw new Error('The tokenizer cannot fit one Unicode code point within the embedding limit')
    }

    const boundary = preferredBoundary(remaining, best)
    const content = remaining.slice(0, boundary).join('').trim()
    const tokenCount =
      boundary === best && content === remaining.slice(0, best).join('')
        ? bestCount
        : assertTokenCount(counter.countTokens(content))
    if (!content || tokenCount < 1 || tokenCount > targetTokens) {
      throw new Error('Unable to produce a valid deterministic text chunk')
    }
    output.push({ content, tokenCount })
    remaining = remaining.slice(boundary)
    while (remaining[0] && /\s/u.test(remaining[0])) remaining = remaining.slice(1)
  }

  return output
}

/** Produces stable chunks and verifies every chunk with the real provider tokenizer. */
export function chunkText(
  rawContent: string,
  counter: TokenCounter,
  options: ChunkTextOptions = {},
): readonly TextChunk[] {
  const content = normalizeContent(rawContent)
  if (!content) throw new Error('Document content must not be empty')
  if (!Number.isSafeInteger(counter.maxInputTokens) || counter.maxInputTokens < 1) {
    throw new Error('TokenCounter.maxInputTokens must be a positive integer')
  }
  if (counter.maxInputTokens > BGE_MAX_INPUT_TOKENS) {
    throw new Error(`Embedding providers must cap input at ${BGE_MAX_INPUT_TOKENS} tokens`)
  }

  const requestedTarget = options.targetTokens ?? Math.min(DEFAULT_CHUNK_TARGET_TOKENS, counter.maxInputTokens)
  if (!Number.isSafeInteger(requestedTarget) || requestedTarget < 1 || requestedTarget > counter.maxInputTokens) {
    throw new Error('targetTokens must be a positive integer within the provider input limit')
  }

  const units = semanticUnits(content)
  const chunks: TextChunk[] = []
  let pending = ''

  const flush = (): void => {
    if (!pending) return
    const tokenCount = assertTokenCount(counter.countTokens(pending))
    if (tokenCount < 1 || tokenCount > requestedTarget) throw new Error('Chunking invariant violated')
    chunks.push({ content: pending, tokenCount })
    pending = ''
  }

  for (const unit of units) {
    const unitCount = assertTokenCount(counter.countTokens(unit))
    if (unitCount > requestedTarget) {
      flush()
      chunks.push(...splitOversizedUnit(unit, requestedTarget, counter))
      continue
    }

    const candidate = pending ? `${pending}\n${unit}` : unit
    const candidateCount = assertTokenCount(counter.countTokens(candidate))
    if (candidateCount <= requestedTarget) {
      pending = candidate
    } else {
      flush()
      pending = unit
    }
  }
  flush()

  if (chunks.length === 0) throw new Error('Document content did not produce any chunks')
  for (const chunk of chunks) {
    if (chunk.tokenCount > counter.maxInputTokens || chunk.tokenCount > BGE_MAX_INPUT_TOKENS) {
      throw new Error('A generated chunk exceeds the embedding provider input limit')
    }
  }
  return chunks
}

/**
 * Deterministically chunks an import without touching the local model runtime.
 * The stored token count is a conservative import bound, not a semantic-model
 * measurement; EmbeddingIndexer asks the isolated worker to validate again.
 */
export function chunkTextForDeferredEmbedding(
  rawContent: string,
  options: ChunkTextOptions = {},
): readonly TextChunk[] {
  return chunkText(rawContent, new DeferredImportTokenCounter(), options)
}
