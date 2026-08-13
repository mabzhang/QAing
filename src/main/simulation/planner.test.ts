import { describe, expect, it } from 'vitest'
import { SimulationWorkflowError } from './errors'
import {
  coverageBatches,
  createCoveragePlan,
  normalizeSimulationBrief,
  simulationOperationId,
} from './planner'
import type { QaSimulationBrief } from './types'

const BRIEF: QaSimulationBrief = {
  intervieweeIdentity: ' 项目负责人 ',
  audience: '评审专家',
  focusTopics: ['商业模式', '实施计划'],
  scenario: '项目评审',
  answerStyle: 'standard',
  excludedTopics: ['个人隐私'],
}

describe('simulation coverage planner', () => {
  it('normalizes and deduplicates the required intake without losing its meaning', () => {
    expect(normalizeSimulationBrief({
      ...BRIEF,
      focusTopics: [' 商业模式 ', '商业模式', '实施   计划'],
    })).toEqual({
      ...BRIEF,
      intervieweeIdentity: '项目负责人',
      focusTopics: ['商业模式', '实施 计划'],
    })
  })

  it('builds the exact requested count and never silently caps a large plan', () => {
    const plan = createCoveragePlan(BRIEF, 101)
    expect(plan.slots).toHaveLength(101)
    expect(new Set(plan.slots.map((slot) => slot.id))).toHaveLength(101)
    expect(plan.slots.at(-1)?.ordinal).toBe(101)
  })

  it('is deterministic for the same frozen brief and request', () => {
    expect(createCoveragePlan(BRIEF, 30)).toEqual(createCoveragePlan(BRIEF, 30))
    expect(createCoveragePlan(BRIEF, 31).planHash).not.toBe(createCoveragePlan(BRIEF, 30).planHash)
  })

  it('splits work into bounded batches of at most ten', () => {
    const batches = coverageBatches(createCoveragePlan(BRIEF, 41))
    expect(batches.map((batch) => batch.length)).toEqual([10, 10, 10, 10, 1])
  })

  it('keeps the operation id stable across retry and dependent on the frozen inputs', () => {
    const plan = createCoveragePlan(BRIEF, 10)
    const input = {
      jobId: 'job-1',
      fence: {
        projectId: 'project-a', knowledgeVersion: 7, projectDataRevision: 9,
        sourceManifestHash: 'a'.repeat(64), sourceCount: 2,
      },
      briefHash: plan.briefHash,
      batchIndex: 0,
      slotIds: plan.slots.map((slot) => slot.id),
    }
    expect(simulationOperationId(input)).toBe(simulationOperationId(input))
    expect(simulationOperationId({ ...input, batchIndex: 1 })).not.toBe(simulationOperationId(input))
  })

  it.each([
    { ...BRIEF, intervieweeIdentity: '' },
    { ...BRIEF, audience: '' },
    { ...BRIEF, focusTopics: [] },
    { ...BRIEF, scenario: '' },
  ])('fails closed on an incomplete brief', (brief) => {
    expect(() => createCoveragePlan(brief, 30)).toThrowError(SimulationWorkflowError)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid requested count %s', (count) => {
    expect(() => createCoveragePlan(BRIEF, count)).toThrowError(
      expect.objectContaining<Partial<SimulationWorkflowError>>({ code: 'INVALID_INPUT' }),
    )
  })
})
