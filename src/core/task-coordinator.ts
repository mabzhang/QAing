export interface RevisionedQuery {
  readonly sessionId: string
  readonly revision: number
  readonly text: string
  readonly isFinal?: boolean
}

export interface CandidateTaskHooks<T> {
  readonly execute: (query: RevisionedQuery, signal: AbortSignal, generationId: number) => Promise<T>
  readonly onAccepted?: (query: RevisionedQuery) => void
  readonly onEquivalent?: (query: RevisionedQuery) => void
  readonly onStarted?: (generationId: number, query: RevisionedQuery) => void
  readonly onResult: (generationId: number, query: RevisionedQuery, result: T) => void
  readonly onError?: (generationId: number, query: RevisionedQuery, error: unknown) => void
  readonly isRetryableError?: (error: unknown) => boolean
}

export interface CandidateTaskOptions {
  readonly minQueryCharacters?: number
  readonly shortQuestionCharacters?: number
  readonly quietPeriodMs?: number
  readonly finalDelayMs?: number
  readonly minStartIntervalMs?: number
  readonly maxFailureRetriesPerQuestion?: number
  readonly now?: () => number
  readonly nextGenerationId?: () => number
}

const QUESTION_SLOT = /(?:多少|几|吗|呢|如何|怎么|怎样|为何|为什么|谁|哪|何时|多久|能否|是否|有无|哪个|哪些|什么|怎么看|怎么做)/u
const REQUEST_INTENT_PREFIX = /^(?:(?:嗯+|啊+|那个|麻烦你?)?)(?:请问|请(?:介绍|说明|解释|分析|告诉|提供|列举|对比|比较|总结|评估|回答|讲|说|谈|不要|别)|不要|别|禁止|介绍|说明|解释|帮我分析|告诉我|提供|列举|对比|比较|总结|谈谈|讲讲|说说|预测|评估|给出建议|回答|我想了解|我想知道|我想问|想了解|想知道|想问)/u
const NESTED_QUESTION_STATEMENT = /(?:正在|还在|在|会|主要)?(?:讨论|研究|说明|描述|复盘|考虑|了解|不知道|不清楚|不明白)[^?？。！!]{0,20}(?:如何|怎么|怎样|为何|为什么|谁|哪|什么|多少|几|何时|多久|能否|是否)/u
const DANGLING_TAIL = /(?:的|了|和|与|及|以及|或|或者|但|但是|因为|如果|关于|针对|然后|首先|其次|就是|是|为|有|把|将|从|到|在|对于|可以|能够|可能|会|要|需要|应该|希望|准备|正在|打算|请问|我想问|我是说|不对我是说|不对我想问|请问[^?？。！!]{0,10}的)$/u
const POLITE_OR_FILLER = /(?:^嗯+|^啊+|^那个|^请问|^我想问(?:一下)?|^想问(?:一下)?|^我想了解|^想了解|^我想知道|^想知道|^麻烦(?:你)?|^请帮我|谢谢$|好吗$|可以吗$)/gu
const TRAILING_DISCOURSE_PARTICLE = /(?:呢|呀|啊|吧|嘛|哈)+$/gu
const LEADING_PUNCTUATION = /^[\s,.!?;:。，！？；：、“”‘’《》]+/gu
const TRAILING_PUNCTUATION = /[\s,.!?;:。，！？；：、“”‘’《》]+$/gu
const NON_MEANINGFUL = /[\s\p{P}\p{S}]/gu
const NUMBER_OR_DATE = /(?:\d+(?:\.\d+)?%?|[〇零一二两三四五六七八九十百千万亿]+(?:年|月|日|元|万|亿|%)?)/gu
const NEGATION = /(?:不是|不要|不含|不包含|没有|未|无|否|而非|除外|改为|更正|不对|不(?=[\p{L}\p{N}]))/gu
const NEGATIVE_COMMAND = /^(?:请)?(?:别|禁止)/gu
const METRIC = /(?:营收|收入|净利润|利润|毛利率|毛利|预算|成本|费用|销售额|销量|用户数|人数|增长率|增长|同比|环比|价格|金额|周期|时间|负责人|目标|风险|方案|进度)/gu
const SUBJECT_KIND = /(?:公司|项目|产品|部门|团队|地区|市场|平台|系统|一期|二期|三期)/gu
const NAMED_SUBJECT_SUFFIX = /(?:公司|项目|产品|部门|团队|平台|系统)/gu
const ENTITY_LEADING_NOISE = /^(?:(?:请问|请|麻烦你?|帮我|我想|想)(?:了解|知道|问|介绍|说明|解释|分析|评估|告诉|提供|对比|总结)?(?:一下子?|下)?|一下子?|关于|针对|如何|为何|为什么|怎么|怎样|谁|哪|什么|多少|几|能否|是否|负责|控制|分析|评估|介绍|说明|了解|讨论|当前|目前|今年|去年|明年|\d{4}年)+/u
const REGION = /(?:北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)(?:省|市|自治区|特别行政区)?/gu
const MATERIAL_CONDITION = /(?:含税|不含税|税前|税后|至少|至多|上限|下限|以上|以下|以内|之前|之后|国内|海外|线上|线下|按月|按年|分别|相比)/gu

function effectiveLength(value: string): number {
  return [...value.replace(NON_MEANINGFUL, '')].length
}

export function normalizeCheckpointQuestion(text: string): string {
  let normalized = text.normalize('NFKC').trim().replace(/\s+/gu, '')
  let previous = ''
  while (previous !== normalized) {
    previous = normalized
    normalized = normalized
      .replace(LEADING_PUNCTUATION, '')
      .replace(POLITE_OR_FILLER, '')
      .replace(TRAILING_DISCOURSE_PARTICLE, '')
      .replace(TRAILING_PUNCTUATION, '')
  }
  normalized = normalized
    .replace(/(?:这个|该)(?=[\p{L}\p{N}]{0,16}(?:项目|公司|产品|方案|平台|系统))/gu, '')
    .replace(/有多少/gu, '是多少')
    .replace(/(?:什么时候|哪年|哪月|哪天)/gu, '何时')
    .replace(/(?:怎么做|怎么|怎样)/gu, '如何')
    .replace(/为什么/gu, '为何')
    .replace(/(?:能不能|可不可以|是否可以|可以吗)/gu, '能否')
    .replace(/的/gu, '')
    .replace(/(?:数额|金额)$/gu, '是多少')
    .replace(/^(?:请|请帮我|麻烦你?|帮我)(?:介绍|说明|分析|评估|解释|了解|告诉|总结)(?:一下子?|下)?/u, '')
    .replace(/^(?:介绍|说明|分析|评估|解释|了解|告诉|总结)(?:一下子?|下)/u, '')
  // Canonicalize two common spoken word-order variants without sorting the
  // whole sentence (which would erase directional meaning such as A对比B).
  normalized = normalized
    .replace(/^(.{2,32})如何(控制|提高|降低|优化|改善|推进|处理|解决|评估|分析)$/u, '如何$2$1')
    .replace(/^(.{1,32})负责人是谁$/u, '谁负责$1')
    .replace(/^谁(?:来)?负责(.{1,32})$/u, '谁负责$1')
  return normalized
}

/**
 * Deterministic equivalence identity used by both scheduling and persistence.
 * Only explicit normalization rules collapse wording. Every other complete
 * wording change is fail-safe material; quiet-period/single-flight throttles
 * provider work instead of a lossy semantic guess.
 */
export function stableCheckpointQuestionIdentity(text: string): string {
  const normalized = normalizeCheckpointQuestion(text)
  const symmetric = /^(.{1,12})(?:与|和)(.{1,12})(有什么(?:区别|差异)|(?:区别|差异)是什么)$/u.exec(normalized)
  if (symmetric?.[1] && symmetric[2] && symmetric[3]) {
    return `symmetric:${[symmetric[1], symmetric[2]].sort().join('|')}:${symmetric[3]}`
  }
  return normalized
}

export function isAnswerableQuestion(text: string, minimumCharacters = 6, shortQuestionCharacters = 3): boolean {
  const normalized = text.normalize('NFKC').trim().replace(/\s+/gu, '')
  const length = effectiveLength(normalized)
  const hasQuestionSlot = QUESTION_SLOT.test(normalized)
  const hasExplicitRequest = REQUEST_INTENT_PREFIX.test(normalized)
  if (length < minimumCharacters && !(hasQuestionSlot && length >= shortQuestionCharacters)) return false
  if (!hasExplicitRequest && NESTED_QUESTION_STATEMENT.test(normalized)) return false
  if (!hasExplicitRequest && /(?:讨论|研究|说明)[^?？。！!]*(?:呢|啊|吧|嘛)$/u.test(normalized)) return false
  if (DANGLING_TAIL.test(normalized)) return false
  return hasQuestionSlot || hasExplicitRequest
}

function values(value: string, pattern: RegExp): string {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  return (value.match(global) ?? []).sort().join('|')
}

function namedSubjectValues(value: string): string {
  const matches: string[] = []
  const pattern = new RegExp(NAMED_SUBJECT_SUFFIX.source, NAMED_SUBJECT_SUFFIX.flags)
  for (const match of value.matchAll(pattern)) {
    const index = match.index
    const suffix = match[0]
    if (index === undefined || suffix === undefined) continue
    const before = value.slice(Math.max(0, index - 24), index)
    const segment = before.slice(Math.max(
      before.lastIndexOf(','),
      before.lastIndexOf('，'),
      before.lastIndexOf('。'),
      before.lastIndexOf('!'),
      before.lastIndexOf('！'),
      before.lastIndexOf('?'),
      before.lastIndexOf('？'),
    ) + 1)
    let candidate = segment.replace(ENTITY_LEADING_NOISE, '')
    // A long predicate immediately before a generic suffix is not a named
    // entity (e.g. “持续管理项目”). Unknown short prefixes are
    // retained conservatively so real organizations/products remain fenced.
    if (
      candidate !== ''
      && /(?:识别|处理|管理|控制|推进|改善|优化|提高|降低)/u.test(candidate)
    ) candidate = ''
    const length = [...candidate].length
    if (length < 1 || length > 12) continue
    matches.push(`${candidate}${suffix}`)
  }
  return matches.sort().join('|')
}

function directionalRelationValues(value: string): string {
  const symmetric = /^(.{1,12})(?:与|和)(.{1,12})(有什么(?:区别|差异)|(?:区别|差异)是什么)$/u.exec(value)
  if (symmetric?.[1] && symmetric[2] && symmetric[3]) {
    return `symmetric:${[symmetric[1], symmetric[2]].sort().join('|')}:${symmetric[3]}`
  }

  // Open-slot relation questions are order-sensitive even when Chinese has no
  // token boundary that can reliably separate two short participants from an
  // unknown predicate. Protect the complete normalized order. Explicitly
  // symmetric comparisons have already returned above.
  if (/(?:什么|哪些|哪个)/u.test(value)) return `directed:${value}`

  // `normalizeCheckpointQuestion` moves supported single-object variants
  // such as “项目风险怎么控制” to an `如何...` prefix. If a
  // participant remains on the left, the sentence expresses an ordered
  // relation. Preserve the complete normalized order instead of guessing an
  // open-ended verb lexicon.
  if (/^.{1,16}如何.{2,32}$/u.test(value)) return `directed:${value}`
  if (/^.{1,16}(?:是否)?(?:对|向).{2,32}$/u.test(value)) return `directed:${value}`

  // Short yes/no subject-predicate-object questions have no reliable generic
  // word boundary in Chinese. Treat their normalized order as protected. This
  // deliberately prefers an occasional extra version over reusing an answer
  // after the participants have been reversed.
  if (/^(?!如何|为何|谁|哪|什么|多少|几|何时|多久|能否|是否).{3,32}吗$/u.test(value)) {
    return `directed:${value}`
  }
  return ''
}

export function isMaterialQuestionChange(previousText: string, nextText: string): boolean {
  const previous = stableCheckpointQuestionIdentity(previousText)
  const next = stableCheckpointQuestionIdentity(nextText)
  if (!next || previous === next) return false
  if (!previous) return true
  return true
}

/**
 * Stable, text-free identity for facts that must always force a new answer
 * version. It is intentionally narrower than the complete question identity:
 * harmless wording/order changes may share a version, while numbers, polarity,
 * metric, subject, region and material conditions never do.
 */
export function protectedQuestionFacetIdentity(text: string): string {
  const normalized = normalizeCheckpointQuestion(text)
  return JSON.stringify([
    values(normalized, NUMBER_OR_DATE),
    values(normalized, NEGATION),
    values(normalized, NEGATIVE_COMMAND),
    values(normalized, METRIC),
    values(normalized, SUBJECT_KIND),
    namedSubjectValues(normalized),
    directionalRelationValues(normalized),
    values(normalized, REGION),
    values(normalized, MATERIAL_CONDITION),
    values(normalized, QUESTION_SLOT),
  ])
}

/**
 * Accepts answerable semantic checkpoints without using wall-clock milestones.
 * A running task is allowed to finish; newer revisions are coalesced into one
 * pending checkpoint and evaluated after the active task settles.
 */
export class CandidateTaskCoordinator<T> {
  readonly #hooks: CandidateTaskHooks<T>
  readonly #options: Required<Omit<CandidateTaskOptions, 'now' | 'nextGenerationId'>> & {
    readonly now: () => number
    readonly nextGenerationId?: () => number
  }
  #timer: ReturnType<typeof setTimeout> | undefined
  #pending: RevisionedQuery | undefined
  #active: { readonly controller: AbortController; readonly token: number; readonly query: RevisionedQuery } | undefined
  #activeEquivalent: RevisionedQuery | undefined
  #lastAcceptedText = ''
  #lastStartedAt = Number.NEGATIVE_INFINITY
  #generationId = 0
  #token = 0
  readonly #failureCounts = new Map<string, number>()
  #disposed = false

  constructor(hooks: CandidateTaskHooks<T>, options: CandidateTaskOptions = {}) {
    this.#hooks = hooks
    this.#options = {
      minQueryCharacters: options.minQueryCharacters ?? 6,
      shortQuestionCharacters: options.shortQuestionCharacters ?? 3,
      quietPeriodMs: options.quietPeriodMs ?? 450,
      finalDelayMs: options.finalDelayMs ?? 0,
      minStartIntervalMs: options.minStartIntervalMs ?? 2_000,
      maxFailureRetriesPerQuestion: options.maxFailureRetriesPerQuestion ?? 1,
      now: options.now ?? Date.now,
      ...(options.nextGenerationId === undefined ? {} : { nextGenerationId: options.nextGenerationId }),
    }
  }

  /** Returns true only when this revision becomes the accepted latest checkpoint. */
  submit(query: RevisionedQuery): boolean {
    if (this.#disposed) return false
    // Preserve the transcript snapshot for display and persistence. Identity
    // and comparison helpers normalize internally; mutating the source text
    // here would silently change full-width punctuation shown to the user.
    const normalized = { ...query, text: query.text.trim() }
    if (!isAnswerableQuestion(
      normalized.text,
      this.#options.minQueryCharacters,
      this.#options.shortQuestionCharacters,
    )) return false

    const baseline = this.#pending?.text ?? this.#active?.query.text ?? this.#lastAcceptedText
    if (!isMaterialQuestionChange(baseline, normalized.text)) {
      if (
        this.#pending?.sessionId === normalized.sessionId
        && normalized.revision >= this.#pending.revision
      ) {
        // Keep the newest ASR revision for the task that has not started yet,
        // without spending another retrieval or persistence operation.
        this.#pending = normalized
      } else if (
        this.#active?.query.sessionId === normalized.sessionId
        && normalized.revision >= (this.#activeEquivalent?.revision ?? this.#active.query.revision)
      ) {
        // The active request is still valid for an equivalent replacement.
        // Publish its result against the latest revision so an unchanged ASR
        // packet cannot strand a completed answer behind the revision fence.
        this.#activeEquivalent = normalized
      } else if (this.#active === undefined && this.#pending === undefined) {
        this.#hooks.onEquivalent?.(normalized)
      }
      this.#lastAcceptedText = normalized.text
      return false
    }

    this.#pending = normalized
    this.#lastAcceptedText = normalized.text
    this.#hooks.onAccepted?.(normalized)
    this.#armPending(normalized.isFinal === true ? this.#options.finalDelayMs : this.#options.quietPeriodMs)
    return true
  }

  cancel(): void {
    this.#pending = undefined
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#token += 1
    this.#active?.controller.abort()
    this.#active = undefined
    this.#activeEquivalent = undefined
    this.#lastAcceptedText = ''
    this.#lastStartedAt = Number.NEGATIVE_INFINITY
    this.#failureCounts.clear()
  }

  dispose(): void {
    this.cancel()
    this.#disposed = true
  }

  #armPending(semanticDelay: number): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    if (!this.#pending || this.#active || this.#disposed) return
    const intervalDelay = Math.max(0, this.#lastStartedAt + this.#options.minStartIntervalMs - this.#options.now())
    this.#timer = setTimeout(() => this.#startPending(), Math.max(semanticDelay, intervalDelay))
  }

  #startPending(): void {
    this.#timer = undefined
    const query = this.#pending
    this.#pending = undefined
    if (!query || this.#disposed || this.#active) return

    const controller = new AbortController()
    const token = ++this.#token
    const generationId = this.#options.nextGenerationId?.() ?? ++this.#generationId
    this.#active = { controller, token, query }
    this.#activeEquivalent = undefined
    this.#lastStartedAt = this.#options.now()
    this.#hooks.onStarted?.(generationId, query)

    void this.#hooks.execute(query, controller.signal, generationId).then(
      (result) => {
        if (!this.#isCurrent(token, controller)) return
        const publicationQuery = this.#activeEquivalent ?? query
        this.#active = undefined
        this.#activeEquivalent = undefined
        this.#failureCounts.delete(normalizeCheckpointQuestion(query.text))
        this.#hooks.onResult(generationId, publicationQuery, result)
        this.#armPending(0)
      },
      (error: unknown) => {
        if (!this.#isCurrent(token, controller)) return
        const retryQuery = this.#activeEquivalent ?? query
        this.#active = undefined
        this.#activeEquivalent = undefined
        if (!controller.signal.aborted) {
          this.#hooks.onError?.(generationId, retryQuery, error)
          const identity = normalizeCheckpointQuestion(retryQuery.text)
          const failures = (this.#failureCounts.get(identity) ?? 0) + 1
          this.#failureCounts.set(identity, failures)
          if (
            (this.#hooks.isRetryableError?.(error) ?? true) &&
            failures <= this.#options.maxFailureRetriesPerQuestion &&
            this.#pending === undefined
          ) {
            this.#pending = retryQuery
          }
        }
        this.#armPending(0)
      },
    )
  }

  #isCurrent(token: number, controller: AbortController): boolean {
    return !this.#disposed && this.#active?.token === token && this.#active.controller === controller
  }
}
