import type { RetrievalResult, RetrievalRoute, SourceReference } from '../../core/types'
import type { DataStore } from './database'
import { normalizeContent, normalizeQuestion } from './hash'
import {
  EmbeddingProviderError,
  embedTexts,
  type EmbeddingProvider,
  type VectorIndex,
  type VectorSearchHit,
} from './vector'
import type { IndexOwnerType, KeywordHit, PresetQaRecord } from './types'

const DEFAULT_RRF_K = 60
const DEFAULT_NEAR_COSINE = 0.985
const DEFAULT_NEAR_MARGIN = 0.08
const DEFAULT_NEAR_LEXICAL = 0.72
const DEFAULT_KEYWORD_NEAR_LEXICAL = 0.88
const DEFAULT_KEYWORD_NEAR_MARGIN = 0.08

interface RankableHit {
  readonly ownerType: IndexOwnerType
  readonly ownerId: string
  readonly documentId: string
  readonly title: string
  readonly excerpt: string
}

interface RankedChannel {
  readonly weight: number
  readonly hits: readonly RankableHit[]
}

interface AccumulatedHit extends RankableHit {
  reciprocalRank: number
}

export interface RetrieveOptions {
  readonly projectId?: string
  readonly signal?: AbortSignal
  readonly limit?: number
}

export interface WaterfallRetrievalResult extends RetrievalResult {
  readonly route: RetrievalRoute
  /** A reviewed preset answer. Null means the document route must generate an answer. */
  readonly directAnswer: string | null
}

export interface StrictNearQaOptions {
  readonly enabled?: boolean
  readonly minimumCosine?: number
  readonly minimumMargin?: number
  readonly minimumLexicalScore?: number
}

/**
 * The selected project is part of the retrieval authorization boundary. A
 * request that crosses an asynchronous project/data-revision change must be
 * discarded instead of combining evidence from two scopes.
 */
export class RetrievalScopeChangedError extends Error {
  constructor() {
    super('Retrieval scope changed while the request was in progress')
    this.name = 'RetrievalScopeChangedError'
  }
}

function keyOf(hit: RankableHit): string {
  return `${hit.ownerType}:${hit.ownerId}`
}

function clipExcerpt(excerpt: string, maximumCharacters = 1_600): string {
  const characters = [...normalizeContent(excerpt)]
  if (characters.length <= maximumCharacters) return characters.join('')
  return `${characters.slice(0, maximumCharacters - 1).join('')}…`
}

function fromKeyword(hit: KeywordHit): RankableHit {
  return hit
}

function fromVector(hit: VectorSearchHit): RankableHit {
  return hit
}

function presetReference(record: PresetQaRecord, score: number): SourceReference {
  return {
    id: record.id,
    documentId: `preset:${record.id}`,
    title: clipExcerpt(record.question, 300),
    kind: 'preset_qa',
    excerpt: clipExcerpt(record.answer),
    score,
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Retrieval was aborted')
}

/**
 * Exact QA canonicalization deliberately removes only trailing sentence marks.
 * Years, numbers, negation, entities, metrics, and all internal punctuation
 * remain part of the identity and can therefore never be silently conflated.
 */
export function canonicalExactQuestion(value: string): string {
  return normalizeQuestion(value).replace(/[\s?？。.]+$/gu, '').trim()
}

function lexicalCharacters(value: string): readonly string[] {
  return [...canonicalExactQuestion(value).replace(/[\p{P}\p{S}\s]/gu, '')]
}

function characterBigrams(value: string): ReadonlySet<string> {
  const characters = lexicalCharacters(value)
  if (characters.length < 2) return new Set(characters)
  const result = new Set<string>()
  for (let index = 0; index < characters.length - 1; index += 1) {
    result.add(`${characters[index] as string}${characters[index + 1] as string}`)
  }
  return result
}

export function qaLexicalSimilarity(left: string, right: string): number {
  const leftBigrams = characterBigrams(left)
  const rightBigrams = characterBigrams(right)
  if (leftBigrams.size === 0 || rightBigrams.size === 0) {
    return canonicalExactQuestion(left) === canonicalExactQuestion(right) ? 1 : 0
  }
  let intersection = 0
  for (const token of leftBigrams) if (rightBigrams.has(token)) intersection += 1
  return (2 * intersection) / (leftBigrams.size + rightBigrams.size)
}

function tokenSet(value: string, expression: RegExp): ReadonlySet<string> {
  const normalized = normalizeQuestion(value).replace(
    /^(?:(?:嗯+|啊+|那个|请问|请介绍(?:一下)?|请说明(?:一下)?|请解释(?:一下)?|请告诉我|我想问(?:一下)?|想问(?:一下)?|麻烦(?:你)?|关于|针对)+)/gu,
    '',
  )
  return new Set([...normalized.matchAll(expression)].map((match) => match[0]))
}

function sameProtectedTokens(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const token of left) if (!right.has(token)) return false
  return true
}

const NUMBER_PATTERN = /(?:\d+(?:[.,]\d+)?(?:%|年|月|日|天|周|个|位|人|件|次|期|阶段|季度|亿元|万元|元)?|百分之[〇○零一二两三四五六七八九十百千万亿]+|[〇○零一二两三四五六七八九十百千万亿]+(?:年|月|日|天|周|个|位|人|件|次|期|阶段|季度|亿元|万元|元|%))/gu
const NEGATION_PATTERN = /(?:不是|不能|不可|不会|不应该|不需要|不含|不支持|不包含|不包括|不提供|不允许|不得|没有|无法|无需|未|禁止|否)/gu
const METRIC_PATTERN = /(?:营收|收入|净利润|利润|毛利率|市占率|增长率|退货率|成交额|结算金额|预算|成本|费用|价格|金额|周期|时间|进度|负责人|目标|风险|销量|销售额|用户数|人数|同比|环比|roi|roas|gmv|ctr|cvr|cpm|cpc)/giu
const ENTITY_PATTERN = /(?:[一-鿿A-Za-z0-9·]{1,24}(?:公司|集团|品牌|产品|项目|平台|系统|型号))|(?:[A-Z][A-Z0-9-]{1,20})/giu

const QUESTION_SLOT_PATTERNS = [
  ['quantity', /(?:多少|几(?:个|位|人|件|次|天|年|元)?)/gu],
  ['time_point', /(?:何时|什么时候|哪年|哪月|哪天)/gu],
  ['duration', /(?:多久|多长时间)/gu],
  ['reason', /(?:为何|为什么|原因(?:是什么)?)/gu],
  ['method', /(?:如何|怎么|怎样)/gu],
  ['yes_no', /(?:是否|能否|可否|有无|有没有|吗)/gu],
  ['identity', /(?:什么|哪个|哪些|谁)/gu],
] as const

function questionSlots(value: string): ReadonlySet<string> {
  const normalized = normalizeQuestion(value)
  const slots = new Set<string>()
  let identityRemainder = normalized
  for (const [slot, expression] of QUESTION_SLOT_PATTERNS) {
    const target = slot === 'identity' ? identityRemainder : normalized
    expression.lastIndex = 0
    if (expression.test(target)) slots.add(slot)
    if (slot === 'time_point' || slot === 'reason') {
      expression.lastIndex = 0
      identityRemainder = identityRemainder.replace(expression, '')
    }
  }
  return slots
}

/** Fail closed when any answer-changing protected token differs. */
export function qaCriticalTermsCompatible(query: string, candidate: string): boolean {
  for (const expression of [NUMBER_PATTERN, NEGATION_PATTERN, METRIC_PATTERN, ENTITY_PATTERN]) {
    if (!sameProtectedTokens(tokenSet(query, expression), tokenSet(candidate, expression))) return false
  }
  return sameProtectedTokens(questionSlots(query), questionSlots(candidate))
}

interface LexicalQaCandidate {
  readonly record: PresetQaRecord
  readonly score: number
}

function strictKeywordQaCandidate(
  store: DataStore,
  query: string,
  candidateLimit: number,
): LexicalQaCandidate | null {
  const ranked = store.searchPresetQaKeywords(query, candidateLimit)
    .map((hit) => ({ record: store.getPresetQa(hit.ownerId), score: qaLexicalSimilarity(query, hit.title) }))
    .filter((candidate): candidate is LexicalQaCandidate => candidate.record !== null)
    .sort((left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id))
  const first = ranked[0]
  if (!first || first.score < DEFAULT_KEYWORD_NEAR_LEXICAL) return null
  const secondScore = ranked[1]?.score ?? 0
  if (first.score - secondScore < DEFAULT_KEYWORD_NEAR_MARGIN) return null
  if (!qaCriticalTermsCompatible(query, first.record.question)) return null
  return first
}

/**
 * Fuses ranks only. BM25 and cosine values never enter the same arithmetic;
 * cosine is used solely as a channel filter before vector rank is assigned.
 */
export function reciprocalRankFusion(
  channels: readonly RankedChannel[],
  limit: number,
  rrfK = DEFAULT_RRF_K,
): readonly SourceReference[] {
  if (!Number.isFinite(rrfK) || rrfK <= 0) throw new Error('RRF k must be positive')
  const accumulated = new Map<string, AccumulatedHit>()
  for (const channel of channels) {
    if (!Number.isFinite(channel.weight) || channel.weight <= 0) throw new Error('RRF channel weight must be positive')
    for (const [index, hit] of channel.hits.entries()) {
      const key = keyOf(hit)
      const contribution = channel.weight / (rrfK + index + 1)
      const current = accumulated.get(key)
      if (current) current.reciprocalRank += contribution
      else accumulated.set(key, { ...hit, reciprocalRank: contribution })
    }
  }

  const ranked = [...accumulated.values()]
    .map((hit) => ({ hit, score: hit.reciprocalRank, key: keyOf(hit) }))
    .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
    .slice(0, Math.max(1, Math.min(20, limit)))
  const maximum = ranked[0]?.score ?? 1
  return ranked.map(({ hit, score }) => ({
    id: hit.ownerId,
    documentId: hit.documentId,
    title: clipExcerpt(hit.title, 300),
    kind: hit.ownerType === 'preset_qa' ? 'preset_qa' : 'source_document',
    excerpt: clipExcerpt(hit.excerpt),
    score: score / maximum,
  }))
}

export class HybridRetriever {
  readonly #store: DataStore
  readonly #index: VectorIndex
  readonly #provider: EmbeddingProvider | null
  readonly #allowTestProvider: boolean
  readonly #semanticTimeoutMs: number
  readonly #minimumVectorScore: number
  readonly #candidateLimit: number
  readonly #nearEnabled: boolean
  readonly #nearMinimumCosine: number
  readonly #nearMinimumMargin: number
  readonly #nearMinimumLexicalScore: number

  constructor(options: {
    readonly store: DataStore
    readonly index: VectorIndex
    readonly provider?: EmbeddingProvider
    readonly allowTestProvider?: boolean
    readonly semanticTimeoutMs?: number
    readonly minimumVectorScore?: number
    readonly candidateLimit?: number
    readonly strictNearQa?: StrictNearQaOptions
  }) {
    this.#store = options.store
    this.#index = options.index
    this.#provider = options.provider ?? null
    this.#allowTestProvider = options.allowTestProvider ?? false
    this.#semanticTimeoutMs = options.semanticTimeoutMs ?? 10_000
    this.#minimumVectorScore = options.minimumVectorScore ?? 0.35
    this.#candidateLimit = Math.max(1, Math.min(100, options.candidateLimit ?? 20))
    this.#nearEnabled = options.strictNearQa?.enabled ?? true
    this.#nearMinimumCosine = options.strictNearQa?.minimumCosine ?? DEFAULT_NEAR_COSINE
    this.#nearMinimumMargin = options.strictNearQa?.minimumMargin ?? DEFAULT_NEAR_MARGIN
    this.#nearMinimumLexicalScore = options.strictNearQa?.minimumLexicalScore ?? DEFAULT_NEAR_LEXICAL
    for (const [name, value] of [
      ['minimumCosine', this.#nearMinimumCosine],
      ['minimumMargin', this.#nearMinimumMargin],
      ['minimumLexicalScore', this.#nearMinimumLexicalScore],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > (name === 'minimumMargin' ? 2 : 1)) {
        throw new Error(`strictNearQa.${name} is invalid`)
      }
    }
  }

  async retrieve(rawQuery: string, options: RetrieveOptions = {}): Promise<WaterfallRetrievalResult> {
    const query = normalizeContent(rawQuery)
    const scopeProjectId = this.#store.getActiveProjectId()
    if (options.projectId !== undefined && scopeProjectId !== options.projectId) {
      throw new RetrievalScopeChangedError()
    }
    const scopeRevision = this.#store.projectDataRevision()
    const assertScopeCurrent = (): void => {
      if (
        this.#store.getActiveProjectId() !== scopeProjectId ||
        (options.projectId !== undefined && scopeProjectId !== options.projectId) ||
        this.#store.projectDataRevision() !== scopeRevision
      ) throw new RetrievalScopeChangedError()
    }
    const allowedQaOwnerIds = this.#store.getRetrievalOwnerIds('preset_qa')
    const allowedDocumentOwnerIds = this.#store.getRetrievalOwnerIds('chunk')
    const semanticReady = Boolean(
      this.#provider &&
      this.#index.size > 0 &&
      (allowedQaOwnerIds.size > 0 || allowedDocumentOwnerIds.size > 0) &&
      (this.#provider.readiness === undefined || this.#provider.readiness === 'ready'),
    )
    let mode: RetrievalResult['mode'] = semanticReady ? 'hybrid' : 'keyword_fallback'
    if (!query) return { query: '', references: [], mode, route: 'source_document', directAnswer: null }
    throwIfAborted(options.signal)
    const resultLimit = Math.max(1, Math.min(20, options.limit ?? 8))

    const exact = this.#store.findExactPresetQa(query, 2)
    if (exact.length === 1) {
      const record = exact[0] as PresetQaRecord
      throwIfAborted(options.signal)
      return {
        query,
        references: [presetReference(record, 1)],
        mode,
        route: 'preset_qa_exact',
        directAnswer: record.answer,
      }
    }

    const keywordQa = this.#nearEnabled
      ? strictKeywordQaCandidate(this.#store, query, 100)
      : null
    if (keywordQa) {
      throwIfAborted(options.signal)
      return {
        query,
        references: [presetReference(keywordQa.record, keywordQa.score)],
        mode,
        route: 'preset_qa_semantic',
        directAnswer: keywordQa.record.answer,
      }
    }

    let vectorHits: readonly VectorSearchHit[] = []
    if (semanticReady && this.#provider) {
      try {
        const [queryVector] = await embedTexts(this.#provider, [query], {
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: this.#semanticTimeoutMs,
          allowTestProvider: this.#allowTestProvider,
        })
        throwIfAborted(options.signal)
        assertScopeCurrent()
        const vector = queryVector as Float32Array
        const qaVectorHits = this.#index.search(vector, 2, -1, 'preset_qa', allowedQaOwnerIds)
        const documentVectorHits = this.#index.search(
          vector,
          this.#candidateLimit,
          this.#minimumVectorScore,
          'chunk',
          allowedDocumentOwnerIds,
        )
        vectorHits = [...qaVectorHits, ...documentVectorHits]
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error
        assertScopeCurrent()
        if (error instanceof EmbeddingProviderError && (error.code === 'UNAVAILABLE' || error.code === 'TIMEOUT')) {
          mode = 'keyword_fallback'
        } else {
          throw error
        }
      }
    }

    if (this.#nearEnabled && mode === 'hybrid') {
      const qaHits = vectorHits.filter((hit) => hit.ownerType === 'preset_qa')
      const first = qaHits[0]
      if (first) {
        const secondScore = qaHits[1]?.score ?? -1
        const record = this.#store.getPresetQa(first.ownerId)
        if (
          record &&
          first.score >= this.#nearMinimumCosine &&
          first.score - secondScore >= this.#nearMinimumMargin &&
          qaLexicalSimilarity(query, record.question) >= this.#nearMinimumLexicalScore &&
          qaCriticalTermsCompatible(query, record.question)
        ) {
          throwIfAborted(options.signal)
          return {
            query,
            references: [presetReference(record, first.score)],
            mode,
            route: 'preset_qa_semantic',
            directAnswer: record.answer,
          }
        }
      }
    }

    // QA candidates that miss the fail-closed direct-answer gate are excluded:
    // the fallback prompt receives source documents only.
    const keywordDocuments = this.#store
      .searchDocumentKeywords(query, this.#candidateLimit)
      .map(fromKeyword)
    const vectorDocuments = mode === 'hybrid'
      ? vectorHits
          .filter((hit) => hit.ownerType === 'chunk' && hit.score >= this.#minimumVectorScore)
          .slice(0, this.#candidateLimit)
          .map(fromVector)
      : []
    const references = reciprocalRankFusion(
      [
        { weight: 1, hits: keywordDocuments },
        ...(mode === 'hybrid' ? [{ weight: 1, hits: vectorDocuments }] : []),
      ],
      resultLimit,
    ).filter((reference) => reference.kind === 'source_document')
    throwIfAborted(options.signal)
    return { query, references, mode, route: 'source_document', directAnswer: null }
  }
}
