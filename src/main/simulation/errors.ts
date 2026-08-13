import type { QaSimulationErrorCode } from './types'

export class SimulationWorkflowError extends Error {
  constructor(
    readonly code: QaSimulationErrorCode,
    readonly retryable: boolean,
  ) {
    super(code)
    this.name = 'SimulationWorkflowError'
  }
}

export class SimulationProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code)
    this.name = 'SimulationProviderError'
  }
}
