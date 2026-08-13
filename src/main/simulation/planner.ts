import { createHash } from 'node:crypto'
import { SimulationWorkflowError } from './errors'
import {
  SIMULATION_BATCH_SIZE,
  SIMULATION_MATERIALIZED_SLOT_LIMIT,
  SIMULATION_WORKFLOW_VERSION,
  type QaCoverageLens,
  type QaCoveragePlan,
  type QaCoverageSlot,
  type QaSimulationBrief,
  type SimulationProjectFence,
} from './types'

const MAX_BRIEF_FIELD_CHARACTERS = 2_000
const MAX_FOCUS_TOPICS = 100

const COVERAGE_LENSES: readonly QaCoverageLens[] = [
  'overview',
  'value',
  'evidence',
  'implementation',
  'metrics',
  'risk',
  'challenge',
  'comparison',
  'timeline',
  'responsibility',
]

const LENS_INTENTS: Readonly<Record<QaCoverageLens, string>> = {
  overview: '澄清背景、目标与范围',
  value: '说明价值、受益对象与差异',
  evidence: '核实资料中的事实依据',
  implementation: '说明执行路径与关键步骤',
  metrics: '解释指标、数字与衡量方式',
  risk: '识别风险、限制与应对方案',
  challenge: '回应质疑、反例与困难问题',
  comparison: '比较方案、对象或替代路径',
  timeline: '说明时间、阶段与交付节奏',
  responsibility: '明确角色、职责与协作关系',
}

function digest(...parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\0')
  return hash.digest('hex')
}

function normalizedText(value: string, required: boolean): string {
  const normalized = value.normalize('NFC').replaceAll(/\s+/gu, ' ').trim()
  if ((required && !normalized) || normalized.length > MAX_BRIEF_FIELD_CHARACTERS || /[\0\r\n]/u.test(normalized)) {
    throw new SimulationWorkflowError('INVALID_INPUT', false)
  }
  return normalized
}

function normalizedList(values: readonly string[], required: boolean): readonly string[] {
  if (values.length > MAX_FOCUS_TOPICS) {
    throw new SimulationWorkflowError('INVALID_INPUT', false)
  }
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    const item = normalizedText(value, true)
    const identity = item.toLocaleLowerCase('zh-CN')
    if (seen.has(identity)) continue
    seen.add(identity)
    normalized.push(item)
  }
  if (required && normalized.length === 0) throw new SimulationWorkflowError('INVALID_INPUT', false)
  return normalized
}

export function validateRequestedCount(requestedCount: number): number {
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1) {
    throw new SimulationWorkflowError('INVALID_INPUT', false)
  }
  if (requestedCount > SIMULATION_MATERIALIZED_SLOT_LIMIT) {
    throw new SimulationWorkflowError('CAPACITY_EXCEEDED', false)
  }
  return requestedCount
}

export function normalizeSimulationBrief(brief: QaSimulationBrief): QaSimulationBrief {
  if (!brief || typeof brief !== 'object') throw new SimulationWorkflowError('INVALID_INPUT', false)
  if (!['concise', 'standard', 'detailed'].includes(brief.answerStyle)) {
    throw new SimulationWorkflowError('INVALID_INPUT', false)
  }
  return {
    intervieweeIdentity: normalizedText(brief.intervieweeIdentity, true),
    audience: normalizedText(brief.audience, true),
    focusTopics: normalizedList(brief.focusTopics, true),
    scenario: normalizedText(brief.scenario, true),
    answerStyle: brief.answerStyle,
    excludedTopics: normalizedList(brief.excludedTopics, false),
  }
}

export function simulationBriefHash(brief: QaSimulationBrief): string {
  const normalized = normalizeSimulationBrief(brief)
  return digest(
    normalized.intervieweeIdentity,
    normalized.audience,
    ...normalized.focusTopics,
    normalized.scenario,
    normalized.answerStyle,
    ...normalized.excludedTopics,
  )
}

export function createCoveragePlan(brief: QaSimulationBrief, requestedCount: number): QaCoveragePlan {
  const normalizedBrief = normalizeSimulationBrief(brief)
  const count = validateRequestedCount(requestedCount)
  const briefHash = simulationBriefHash(normalizedBrief)
  const slots = Array.from({ length: count }, (_, index): QaCoverageSlot => {
    const ordinal = index + 1
    const topic = normalizedBrief.focusTopics[index % normalizedBrief.focusTopics.length] as string
    const lens = COVERAGE_LENSES[Math.floor(index / normalizedBrief.focusTopics.length) % COVERAGE_LENSES.length] as QaCoverageLens
    const id = `slot_${digest(briefHash, String(ordinal), topic, lens).slice(0, 24)}`
    return { id, ordinal, topic, lens, intent: LENS_INTENTS[lens] }
  })
  const planHash = digest(
    SIMULATION_WORKFLOW_VERSION,
    String(count),
    briefHash,
    ...slots.flatMap((slot) => [slot.id, String(slot.ordinal), slot.topic, slot.lens, slot.intent]),
  )
  return {
    workflowVersion: SIMULATION_WORKFLOW_VERSION,
    requestedCount: count,
    briefHash,
    planHash,
    slots,
  }
}

export function coverageBatches(plan: QaCoveragePlan): readonly (readonly QaCoverageSlot[])[] {
  const batches: QaCoverageSlot[][] = []
  for (let offset = 0; offset < plan.slots.length; offset += SIMULATION_BATCH_SIZE) {
    batches.push(plan.slots.slice(offset, offset + SIMULATION_BATCH_SIZE))
  }
  return batches
}

/** Stable across retry/resume. Generation remains a separate stale-result fence. */
export function simulationOperationId(input: {
  readonly jobId: string
  readonly fence: SimulationProjectFence
  readonly briefHash: string
  readonly batchIndex: number
  readonly slotIds: readonly string[]
}): string {
  return `simop_${digest(
    SIMULATION_WORKFLOW_VERSION,
    input.jobId,
    input.fence.projectId,
    String(input.fence.knowledgeVersion),
    String(input.fence.projectDataRevision),
    input.fence.sourceManifestHash,
    input.briefHash,
    String(input.batchIndex),
    ...input.slotIds,
  ).slice(0, 32)}`
}
