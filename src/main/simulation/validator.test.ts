import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SimulationWorkflowError } from './errors'
import { createCoveragePlan } from './planner'
import type {
  QaSimulationBrief,
  QaSlotEvidence,
  SimulationEvidence,
  SimulationProjectFence,
} from './types'
import {
  normalizeEvidenceBundles,
  normalizeGeneratedQuestion,
  parseProviderBatch,
  validateProviderBatch,
} from './validator'

const BRIEF: QaSimulationBrief = {
  intervieweeIdentity: '负责人',
  audience: '评审专家',
  focusTopics: ['预算'],
  scenario: '评审',
  answerStyle: 'standard',
  excludedTopics: [],
}
const FENCE: SimulationProjectFence = {
  projectId: 'project-a', knowledgeVersion: 3, projectDataRevision: 4,
  sourceManifestHash: 'a'.repeat(64), sourceCount: 1,
}
const SLOT = createCoveragePlan(BRIEF, 1).slots[0]!

function evidence(excerpt = '测试项目2026年预算为100万元，不包含税费。'): SimulationEvidence {
  return {
    projectId: FENCE.projectId,
    knowledgeVersion: FENCE.knowledgeVersion,
    projectDataRevision: FENCE.projectDataRevision,
    sourceManifestHash: FENCE.sourceManifestHash,
    reference: {
      sourceId: 'source-1',
      sourceRevisionId: 'revision-1',
      documentId: 'document-1',
      chunkId: 'chunk-1',
      contentHash: createHash('sha256').update(excerpt).digest('hex'),
    },
    title: '测试资料',
    excerpt,
  }
}

function bundle(entry = evidence()): QaSlotEvidence {
  return { slotId: SLOT.id, evidence: [entry] }
}

function parsedItem(overrides: Record<string, unknown> = {}) {
  const source = evidence()
  return parseProviderBatch(JSON.stringify({
    items: [{
      slotId: SLOT.id,
      question: '测试项目2026年预算是多少？',
      answer: '测试项目2026年预算为100万元，不包含税费。',
      sourceReferences: [source.reference],
      ...overrides,
    }],
  }))
}

describe('simulation response validation', () => {
  it('accepts a grounded item and persists only stable references', () => {
    const result = validateProviderBatch({
      providerItems: parsedItem(),
      slots: [SLOT],
      evidence: [bundle()],
      existingQuestionIdentities: new Set(),
      excludedTopics: [],
    })
    expect(result.gaps).toEqual([])
    expect(result.items).toEqual([
      expect.objectContaining({
        slotId: SLOT.id,
        ordinal: 1,
        questionIdentity: '测试项目2026年预算是多少',
        sourceReferences: [evidence().reference],
      }),
    ])
    expect(result.items[0]).not.toHaveProperty('excerpt')
  })

  it('normalizes polite and punctuation-only question differences', () => {
    expect(normalizeGeneratedQuestion('请问，项目预算是多少？')).toBe('项目预算是多少')
    expect(normalizeGeneratedQuestion('项目预算是多少')).toBe('项目预算是多少')
  })

  it('fails closed when evidence escapes the frozen project or has inconsistent source provenance', () => {
    const wrongProject = { ...evidence(), projectId: 'project-b' }
    expect(() => normalizeEvidenceBundles([bundle(wrongProject)], [SLOT], FENCE)).toThrowError(
      expect.objectContaining<Partial<SimulationWorkflowError>>({ code: 'INVALID_RESPONSE' }),
    )
    const inconsistent = {
      ...evidence(),
      reference: { ...evidence().reference, sourceRevisionId: null },
    }
    expect(() => normalizeEvidenceBundles([bundle(inconsistent)], [SLOT], FENCE)).toThrowError(SimulationWorkflowError)
  })

  it('fills an omitted evidence bundle with an empty, ordered bundle', () => {
    expect(normalizeEvidenceBundles([], [SLOT], FENCE)).toEqual([{ slotId: SLOT.id, evidence: [] }])
  })

  it('accepts evidence when only non-content project metadata revision advances', () => {
    const advanced = { ...evidence(), projectDataRevision: FENCE.projectDataRevision + 1 }
    expect(normalizeEvidenceBundles([bundle(advanced)], [SLOT], FENCE)).toHaveLength(1)
  })

  it('turns an unknown citation into a coverage gap', () => {
    const result = validateProviderBatch({
      providerItems: parsedItem({ sourceReferences: [{ ...evidence().reference, chunkId: 'unknown' }] }),
      slots: [SLOT],
      evidence: [bundle()],
      existingQuestionIdentities: new Set(),
      excludedTopics: [],
    })
    expect(result.items).toEqual([])
    expect(result.gaps).toEqual([expect.objectContaining({ reason: 'invalid_citation' })])
  })

  it.each([
    ['数字', '测试项目2026年预算为200万元，不包含税费。'],
    ['年份', '测试项目2027年预算为100万元，不包含税费。'],
    ['实体', '其他项目2026年预算为100万元，不包含税费。'],
    ['无后缀中文实体', '华为2026年预算为100万元，不包含税费。'],
    ['否定', '测试项目2026年预算为100万元，包含税费。'],
    ['指标', '测试项目2026年收入为100万元，不包含税费。'],
  ])('rejects an answer whose protected %s claim is absent from cited evidence', (_kind, answer) => {
    const result = validateProviderBatch({
      providerItems: parsedItem({ answer }),
      slots: [SLOT],
      evidence: [bundle()],
      existingQuestionIdentities: new Set(),
      excludedTopics: [],
    })
    expect(result.items).toEqual([])
    expect(result.gaps).toEqual([expect.objectContaining({ reason: 'unsupported_claim' })])
  })

  it('rejects exact and very-near duplicate questions across batches', () => {
    const exact = validateProviderBatch({
      providerItems: parsedItem(),
      slots: [SLOT],
      evidence: [bundle()],
      existingQuestionIdentities: new Set(['测试项目2026年预算是多少']),
      excludedTopics: [],
    })
    expect(exact.gaps[0]?.reason).toBe('duplicate_question')
    const near = validateProviderBatch({
      providerItems: parsedItem({ question: '测试项目2026年预算是多少呢？' }),
      slots: [SLOT],
      evidence: [bundle()],
      existingQuestionIdentities: new Set(['测试项目2026年预算是多少啊']),
      excludedTopics: [],
    })
    expect(near.gaps[0]?.reason).toBe('duplicate_question')
  })

  it('records a provider omission as a gap rather than inventing an answer', () => {
    const result = validateProviderBatch({
      providerItems: [],
      slots: [SLOT],
      evidence: [bundle()],
      existingQuestionIdentities: new Set(),
      excludedTopics: [],
    })
    expect(result).toMatchObject({ items: [], gaps: [{ reason: 'provider_omission' }] })
  })

  it.each([
    '',
    'not json',
    '{}',
    '{"items":[{"slotId":"x"}]}',
    '{"items":[],"unexpected":true}',
  ])('rejects malformed or non-strict provider JSON without partial persistence', (raw) => {
    expect(() => parseProviderBatch(raw)).toThrowError(
      expect.objectContaining<Partial<SimulationWorkflowError>>({ code: 'INVALID_RESPONSE' }),
    )
  })

  it('rejects duplicate slot payloads for deterministic one-slot ownership', () => {
    const item = {
      slotId: SLOT.id,
      question: '预算是多少？',
      answer: '预算为100万元。',
      sourceReferences: [evidence().reference],
    }
    expect(() => parseProviderBatch(JSON.stringify({ items: [item, item] }))).toThrowError(SimulationWorkflowError)
  })

  it.each([
    ['question', ['预 算'], parsedItem()],
    ['answer', ['税-费'], parsedItem({ question: '测试项目的资金安排是什么？' })],
  ])('turns a normalized excluded-topic match in the %s into a gap without a draft', (_field, excludedTopics, providerItems) => {
    const result = validateProviderBatch({
      providerItems,
      slots: [SLOT],
      evidence: [bundle()],
      existingQuestionIdentities: new Set(),
      excludedTopics,
    })
    expect(result.items).toEqual([])
    expect(result.acceptedIdentities).toEqual([])
    expect(result.gaps).toEqual([expect.objectContaining({ reason: 'excluded_topic' })])
  })

  it('does not reject a grounded answer for an unrelated excluded topic', () => {
    const result = validateProviderBatch({
      providerItems: parsedItem(),
      slots: [SLOT],
      evidence: [bundle()],
      existingQuestionIdentities: new Set(),
      excludedTopics: ['薪酬'],
    })
    expect(result.items).toHaveLength(1)
    expect(result.gaps).toEqual([])
  })
})
