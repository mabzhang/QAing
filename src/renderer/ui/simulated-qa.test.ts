import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIMULATED_QA_TARGET,
  SIMULATED_QA_TECHNICAL_LIMIT,
  parseSimulatedQaTarget,
  simulationEventMatchesJob,
  simulationCursorTransition,
  simulationJobCanReplace,
  simulationJobMeetsEvent,
  simulationPageMatchesJob,
  simulatedQaScopeMatches,
} from './simulated-qa'

describe('simulated QA renderer guards', () => {
  it('defaults to 30 and accepts user-selected counts without imposing a 50-item product cap', () => {
    expect(DEFAULT_SIMULATED_QA_TARGET).toBe(30)
    expect(parseSimulatedQaTarget('50')).toEqual({
      value: 50,
      error: null,
      requiresRiskConfirmation: true,
    })
    expect(parseSimulatedQaTarget('100')).toEqual({ value: 100, error: null, requiresRiskConfirmation: true })
    expect(parseSimulatedQaTarget(String(SIMULATED_QA_TECHNICAL_LIMIT))).toEqual({
      value: SIMULATED_QA_TECHNICAL_LIMIT,
      error: null,
      requiresRiskConfirmation: true,
    })
  })

  it('rejects zero, fractions, signs, exponents and unsafe integers', () => {
    for (const value of ['', '0', '-2', '2.5', '+3', '1e3', '10001', '9007199254740992']) {
      expect(parseSimulatedQaTarget(value).value).toBeNull()
    }
  })

  it('requires the high-volume acknowledgement only above 40', () => {
    expect(parseSimulatedQaTarget('40').requiresRiskConfirmation).toBe(false)
    expect(parseSimulatedQaTarget('41').requiresRiskConfirmation).toBe(true)
  })

  it('rejects stale project, source revision and generation scopes', () => {
    const scope = { projectId: 'project-1', generation: 4, knowledgeVersion: 12 }
    expect(simulatedQaScopeMatches(scope, 'project-1', 12, 4)).toBe(true)
    expect(simulatedQaScopeMatches(scope, 'project-2', 12, 4)).toBe(false)
    expect(simulatedQaScopeMatches(scope, 'project-1', 13, 4)).toBe(false)
    expect(simulatedQaScopeMatches(scope, 'project-1', 12, 5)).toBe(false)
  })

  it('fences events and pages by project, job, generation, knowledge and data revision', () => {
    const job = {
      id: 'job-1', projectId: 'project-1', generation: 3, knowledgeVersion: 8,
      state: 'review_required', targetCount: 30, completedBatches: 3, totalBatches: 3,
      reliableCount: 28, gapCount: 2, approvedCount: 7, dataRevision: 11, createdAt: 1, updatedAt: 2,
      completedAt: null, errorCode: null,
    } as const
    expect(simulationEventMatchesJob({ projectId: 'project-1', jobId: 'job-1', generation: 3, knowledgeVersion: 8, dataRevision: 12 }, job)).toBe(true)
    expect(simulationEventMatchesJob({ projectId: 'project-1', jobId: 'job-1', generation: 2, knowledgeVersion: 8, dataRevision: 12 }, job)).toBe(false)
    const event = { projectId: 'project-1', jobId: 'job-1', generation: 3, knowledgeVersion: 8, dataRevision: 12 }
    expect(simulationJobMeetsEvent({ ...job, dataRevision: 13 }, event)).toBe(true)
    expect(simulationJobMeetsEvent(job, event)).toBe(false)
    expect(simulationJobCanReplace(job, { ...job, dataRevision: 12 })).toBe(true)
    expect(simulationJobCanReplace(job, { ...job, dataRevision: 10 })).toBe(false)
    const page = { projectId: 'project-1', jobId: 'job-1', generation: 3, knowledgeVersion: 8, dataRevision: 11, totalItems: 28, items: [], gaps: [], nextCursor: null }
    expect(simulationPageMatchesJob(page, job)).toBe(true)
    expect(simulationPageMatchesJob({ ...page, dataRevision: 10 }, job)).toBe(false)
  })

  it('keeps exact request cursors across next-next-previous-previous navigation', () => {
    const first = simulationCursorTransition([], 'next', 'cursor-2')
    expect(first).toEqual({ requestCursor: 'cursor-2', nextStack: ['cursor-2'] })
    const second = simulationCursorTransition(first?.nextStack ?? [], 'next', 'cursor-3')
    expect(second).toEqual({ requestCursor: 'cursor-3', nextStack: ['cursor-2', 'cursor-3'] })
    const backToSecond = simulationCursorTransition(second?.nextStack ?? [], 'previous', null)
    expect(backToSecond).toEqual({ requestCursor: 'cursor-2', nextStack: ['cursor-2'] })
    const backToFirst = simulationCursorTransition(backToSecond?.nextStack ?? [], 'previous', null)
    expect(backToFirst).toEqual({ requestCursor: null, nextStack: [] })
    expect(simulationCursorTransition([], 'previous', null)).toBeNull()
  })

  it('refuses a page after the job revision advances during pagination', () => {
    const job = {
      id: 'job-1', projectId: 'project-1', generation: 3, knowledgeVersion: 8,
      state: 'review_required', targetCount: 30, completedBatches: 3, totalBatches: 3,
      reliableCount: 28, gapCount: 2, approvedCount: 7, dataRevision: 12, createdAt: 1,
      updatedAt: 2, completedAt: null, errorCode: null,
    } as const
    const delayedPage = {
      projectId: 'project-1', jobId: 'job-1', generation: 3, knowledgeVersion: 8,
      dataRevision: 11, totalItems: 28, items: [], gaps: [], nextCursor: null,
    } as const
    expect(simulationPageMatchesJob(delayedPage, job)).toBe(false)
    expect(simulationPageMatchesJob(delayedPage, job, 11)).toBe(true)
  })
})
