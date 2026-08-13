import type {
  QaSimulationChangedEvent,
  QaSimulationJobSummary,
  QaSimulationPage,
} from '../../core/contracts'

export const DEFAULT_SIMULATED_QA_TARGET = 30
export const SIMULATED_QA_HIGH_VOLUME_THRESHOLD = 40
/**
 * Workflow v1 materializes the coverage plan before batching. Keep the UI
 * aligned with the backend's explicit technical boundary so a huge integer is
 * rejected before it can allocate an unbounded plan. This is not a 50-item
 * product cap: normal user-selected counts remain unchanged.
 */
export const SIMULATED_QA_TECHNICAL_LIMIT = 10_000

export interface SimulatedQaTargetValidation {
  readonly value: number | null
  readonly error: string | null
  readonly requiresRiskConfirmation: boolean
}

export function simulationEventMatchesJob(
  event: QaSimulationChangedEvent,
  job: QaSimulationJobSummary,
): boolean {
  return event.projectId === job.projectId
    && event.jobId === job.id
    && event.generation === job.generation
    && event.knowledgeVersion === job.knowledgeVersion
    && event.dataRevision >= job.dataRevision
}

/** A fetched snapshot may satisfy the triggering event or be even newer. */
export function simulationJobMeetsEvent(
  job: QaSimulationJobSummary,
  event: QaSimulationChangedEvent,
): boolean {
  return job.projectId === event.projectId
    && job.id === event.jobId
    && job.generation === event.generation
    && job.knowledgeVersion === event.knowledgeVersion
    && job.dataRevision >= event.dataRevision
}

/** Never let a delayed response replace a newer snapshot from the same job. */
export function simulationJobCanReplace(
  current: QaSimulationJobSummary,
  candidate: QaSimulationJobSummary,
): boolean {
  return candidate.projectId === current.projectId
    && candidate.id === current.id
    && candidate.generation === current.generation
    && candidate.knowledgeVersion === current.knowledgeVersion
    && candidate.dataRevision >= current.dataRevision
}

export function simulationPageMatchesJob(
  page: QaSimulationPage,
  job: QaSimulationJobSummary,
  expectedDataRevision = job.dataRevision,
): boolean {
  return page.projectId === job.projectId
    && page.jobId === job.id
    && page.generation === job.generation
    && page.knowledgeVersion === job.knowledgeVersion
    && page.dataRevision === expectedDataRevision
}

export interface SimulationCursorStackTransition {
  readonly requestCursor: string | null
  readonly nextStack: readonly (string | null)[]
}

export function simulationCursorTransition(
  currentStack: readonly (string | null)[],
  direction: 'previous' | 'next',
  nextCursor: string | null,
): SimulationCursorStackTransition | null {
  if (direction === 'next') {
    if (nextCursor === null) return null
    return { requestCursor: nextCursor, nextStack: [...currentStack, nextCursor] }
  }
  if (currentStack.length === 0) return null
  const nextStack = currentStack.slice(0, -1)
  return { requestCursor: nextStack.at(-1) ?? null, nextStack }
}

export function parseSimulatedQaTarget(raw: string): SimulatedQaTargetValidation {
  const normalized = raw.trim()
  if (!/^[1-9]\d*$/u.test(normalized)) {
    return { value: null, error: '请输入大于 0 的整数', requiresRiskConfirmation: false }
  }
  try {
    const parsed = BigInt(normalized)
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { value: null, error: '数量超出安全整数范围', requiresRiskConfirmation: false }
    }
    const value = Number(parsed)
    if (value > SIMULATED_QA_TECHNICAL_LIMIT) {
      return {
        value: null,
        error: `单次任务最多 ${SIMULATED_QA_TECHNICAL_LIMIT.toLocaleString('zh-CN')} 条，请拆分为多个任务`,
        requiresRiskConfirmation: false,
      }
    }
    return {
      value,
      error: null,
      requiresRiskConfirmation: value > SIMULATED_QA_HIGH_VOLUME_THRESHOLD,
    }
  } catch {
    return { value: null, error: '请输入有效整数', requiresRiskConfirmation: false }
  }
}

export function simulatedQaScopeMatches(
  scope: Pick<QaSimulationJobSummary, 'projectId' | 'generation' | 'knowledgeVersion'>
    | Pick<QaSimulationPage, 'projectId' | 'generation' | 'knowledgeVersion'>,
  projectId: string,
  knowledgeVersion: number,
  generation?: number,
): boolean {
  return scope.projectId === projectId
    && scope.knowledgeVersion === knowledgeVersion
    && (generation === undefined || scope.generation === generation)
}
