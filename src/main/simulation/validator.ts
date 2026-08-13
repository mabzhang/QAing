import { z } from 'zod'
import { SimulationWorkflowError } from './errors'
import type {
  QaCoverageGap,
  QaCoverageSlot,
  QaSimulationCommittedItem,
  QaSlotEvidence,
  SimulationEvidence,
  SimulationProjectFence,
  SimulationSourceReference,
} from './types'

const MAX_EVIDENCE_CHARACTERS = 16_000

const sourceReferenceSchema = z.object({
  sourceId: z.string().trim().min(1).max(256).nullable(),
  sourceRevisionId: z.string().trim().min(1).max(256).nullable(),
  documentId: z.string().trim().min(1).max(256),
  chunkId: z.string().trim().min(1).max(256),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

const providerItemSchema = z.object({
  slotId: z.string().trim().min(1).max(256),
  question: z.string().trim().min(3).max(500),
  answer: z.string().trim().min(1).max(8_000),
  sourceReferences: z.array(sourceReferenceSchema).min(1).max(20),
}).strict()

const providerBatchSchema = z.object({
  items: z.array(providerItemSchema).max(10),
}).strict()

interface ProviderItem {
  readonly slotId: string
  readonly question: string
  readonly answer: string
  readonly sourceReferences: readonly SimulationSourceReference[]
}

export interface ValidatedProviderBatch {
  readonly items: readonly QaSimulationCommittedItem[]
  readonly gaps: readonly QaCoverageGap[]
  readonly acceptedIdentities: readonly string[]
}

function referenceKey(reference: SimulationSourceReference): string {
  return [
    reference.sourceRevisionId,
    reference.sourceId,
    reference.documentId,
    reference.chunkId,
    reference.contentHash,
  ].join('\0')
}

function normalizeComparable(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replaceAll(/\s+/gu, '')
}

function normalizePolicyText(value: string): string {
  return normalizeComparable(value).replaceAll(/[^\p{Script=Han}\p{Letter}\p{Number}]+/gu, '')
}

function matchesExcludedTopic(
  question: string,
  answer: string,
  excludedTopics: readonly string[],
): boolean {
  const generated = [normalizePolicyText(question), normalizePolicyText(answer)]
  return excludedTopics.some((topic) => {
    const normalized = normalizePolicyText(topic)
    return normalized.length > 0 && generated.some((value) => value.includes(normalized))
  })
}

export function normalizeGeneratedQuestion(value: string): string {
  return normalizeComparable(value)
    .replace(/^(?:请问|请介绍一下|请说明一下|请说明|想了解|麻烦(?:你)?|请帮(?:我)?)/u, '')
    .replaceAll(/[，。！？、；：,.!?;:'"“”‘’（）()[\]【】《》<>—_-]/gu, '')
    .replace(/(?:呢|啊|呀|嘛)$/u, '')
}

function bigrams(value: string): ReadonlySet<string> {
  if (value.length < 2) return new Set([value])
  const result = new Set<string>()
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2))
  return result
}

function nearDuplicate(left: string, right: string): boolean {
  if (left === right) return true
  const leftNumbers = new Set(left.match(/\d+(?:\.\d+)?/gu) ?? [])
  const rightNumbers = new Set(right.match(/\d+(?:\.\d+)?/gu) ?? [])
  if (leftNumbers.size !== rightNumbers.size || [...leftNumbers].some((token) => !rightNumbers.has(token))) return false
  const leftPairs = bigrams(left)
  const rightPairs = bigrams(right)
  let overlap = 0
  for (const pair of leftPairs) if (rightPairs.has(pair)) overlap += 1
  const union = new Set([...leftPairs, ...rightPairs]).size
  return union > 0 && overlap / union >= 0.94
}

function tokenSet(value: string, expression: RegExp): ReadonlySet<string> {
  expression.lastIndex = 0
  return new Set([...value.matchAll(expression)].map((match) => normalizeComparable(match[0])))
}

const NUMBER_PATTERN = /(?:\d{1,4}(?:[.,]\d+)?%?)|(?:[零一二三四五六七八九十百千万亿两〇]+(?:元|万元|亿元|个|人|天|年|月|日|次|项|家))/gu
const ENTITY_PATTERN = /(?:[\p{Script=Han}A-Za-z0-9·-]{1,20}(?:公司|集团|品牌|产品|项目|平台|系统|型号))|(?:[A-Z][A-Z0-9-]{1,20})|(?<![\p{Script=Han}A-Za-z0-9·-])[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·-]{1,19}(?=(?:在|的)?(?:20\d{2}年|预算|营收|收入|净利润|利润|成本|价格|费用|销量|周期|风险))/gu
const NEGATION_PATTERN = /(?:不是|不能|不可|不会|不应|不需要|不含|不支持|不包含|不包括|不提供|不允许|不得|没有|无法|无需|未|禁止|否)/gu
const METRIC_PATTERN = /(?:营收|收入|净利润|利润|毛利率|市占率|增长率|退货率|成交额|结算金额|预算|成本|费用|价格|金额|周期|时间|进度|负责人|目标|风险|销量|销售额|用户数|人数|同比|环比|roi|roas|gmv|ctr|cvr|cpm|cpc)/giu

function protectedClaimsSupported(answer: string, evidence: string): boolean {
  for (const expression of [NUMBER_PATTERN, ENTITY_PATTERN, NEGATION_PATTERN, METRIC_PATTERN]) {
    const evidenceTokens = tokenSet(evidence, expression)
    const answerTokens = tokenSet(answer, expression)
    for (const token of answerTokens) if (!evidenceTokens.has(token)) return false
    // Dropping a cited negation can invert a claim while adding no new token to
    // the answer. For the deliberately small per-slot evidence bundle, require
    // exact polarity preservation rather than allowing that silent inversion.
    if (expression === NEGATION_PATTERN) {
      for (const token of evidenceTokens) if (!answerTokens.has(token)) return false
    }
  }
  return true
}

function gap(slot: QaCoverageSlot, reason: QaCoverageGap['reason']): QaCoverageGap {
  return { slotId: slot.id, ordinal: slot.ordinal, topic: slot.topic, reason }
}

function assertEvidence(evidence: SimulationEvidence, fence: SimulationProjectFence): void {
  if (
    evidence.projectId !== fence.projectId
    || evidence.knowledgeVersion !== fence.knowledgeVersion
    || evidence.sourceManifestHash !== fence.sourceManifestHash
    || !evidence.excerpt.trim()
    || !evidence.title.trim()
    || evidence.excerpt.length > MAX_EVIDENCE_CHARACTERS
    || !sourceReferenceSchema.safeParse(evidence.reference).success
    || (evidence.reference.sourceId === null) !== (evidence.reference.sourceRevisionId === null)
  ) {
    throw new SimulationWorkflowError('INVALID_RESPONSE', false)
  }
}

export function normalizeEvidenceBundles(
  bundles: readonly QaSlotEvidence[],
  slots: readonly QaCoverageSlot[],
  fence: SimulationProjectFence,
): readonly QaSlotEvidence[] {
  const expected = new Set(slots.map((slot) => slot.id))
  const seen = new Set<string>()
  const bySlot = new Map<string, readonly SimulationEvidence[]>()
  for (const bundle of bundles) {
    if (!expected.has(bundle.slotId) || seen.has(bundle.slotId)) {
      throw new SimulationWorkflowError('INVALID_RESPONSE', false)
    }
    seen.add(bundle.slotId)
    const references = new Set<string>()
    const normalized: SimulationEvidence[] = []
    for (const evidence of bundle.evidence) {
      assertEvidence(evidence, fence)
      const key = referenceKey(evidence.reference)
      if (references.has(key)) continue
      references.add(key)
      normalized.push(evidence)
    }
    bySlot.set(bundle.slotId, normalized)
  }
  return slots.map((slot) => ({ slotId: slot.id, evidence: bySlot.get(slot.id) ?? [] }))
}

export function parseProviderBatch(rawJson: string): readonly ProviderItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new SimulationWorkflowError('INVALID_RESPONSE', true)
  }
  const result = providerBatchSchema.safeParse(parsed)
  if (!result.success) throw new SimulationWorkflowError('INVALID_RESPONSE', true)
  const seen = new Set<string>()
  for (const item of result.data.items) {
    if (seen.has(item.slotId)) throw new SimulationWorkflowError('INVALID_RESPONSE', true)
    seen.add(item.slotId)
  }
  return result.data.items
}

export function validateProviderBatch(input: {
  readonly providerItems: readonly ProviderItem[]
  readonly slots: readonly QaCoverageSlot[]
  readonly evidence: readonly QaSlotEvidence[]
  readonly existingQuestionIdentities: ReadonlySet<string>
  readonly excludedTopics: readonly string[]
}): ValidatedProviderBatch {
  const slots = new Map(input.slots.map((slot) => [slot.id, slot]))
  const evidence = new Map(input.evidence.map((bundle) => [bundle.slotId, bundle.evidence]))
  const providerItems = new Map<string, ProviderItem>()
  for (const item of input.providerItems) {
    if (!slots.has(item.slotId)) throw new SimulationWorkflowError('INVALID_RESPONSE', true)
    providerItems.set(item.slotId, item)
  }

  const acceptedIdentities = [...input.existingQuestionIdentities]
  const accepted: QaSimulationCommittedItem[] = []
  const gaps: QaCoverageGap[] = []

  for (const slot of input.slots) {
    const item = providerItems.get(slot.id)
    if (!item) {
      gaps.push(gap(slot, 'provider_omission'))
      continue
    }
    if (matchesExcludedTopic(item.question, item.answer, input.excludedTopics)) {
      gaps.push(gap(slot, 'excluded_topic'))
      continue
    }
    const availableEvidence = evidence.get(slot.id) ?? []
    const evidenceByReference = new Map(availableEvidence.map((entry) => [referenceKey(entry.reference), entry]))
    const cited: SimulationEvidence[] = []
    const citedKeys = new Set<string>()
    let invalidCitation = false
    for (const reference of item.sourceReferences) {
      const key = referenceKey(reference)
      const match = evidenceByReference.get(key)
      if (!match || citedKeys.has(key)) {
        invalidCitation = true
        break
      }
      citedKeys.add(key)
      cited.push(match)
    }
    if (invalidCitation || cited.length === 0) {
      gaps.push(gap(slot, 'invalid_citation'))
      continue
    }
    if (!protectedClaimsSupported(item.answer, cited.map((entry) => entry.excerpt).join('\n'))) {
      gaps.push(gap(slot, 'unsupported_claim'))
      continue
    }
    const identity = normalizeGeneratedQuestion(item.question)
    if (!identity || acceptedIdentities.some((existing) => nearDuplicate(identity, normalizeGeneratedQuestion(existing)))) {
      gaps.push(gap(slot, 'duplicate_question'))
      continue
    }
    acceptedIdentities.push(identity)
    accepted.push({
      slotId: slot.id,
      ordinal: slot.ordinal,
      question: item.question,
      questionIdentity: identity,
      answer: item.answer,
      sourceReferences: item.sourceReferences,
      citations: cited.map((entry) => ({ ...entry.reference, excerpt: entry.excerpt })),
    })
  }
  return {
    items: accepted,
    gaps,
    acceptedIdentities: accepted.map((item) => item.questionIdentity),
  }
}
