import {
  QaSimulationApplicationService,
  type SimulationApplicationDataPort,
  type SimulationPublicationGateway,
} from './application'
import {
  DataStoreSimulationKnowledge,
  DataStoreSimulationRepository,
  type SimulationDataStorePort,
} from './data-repository'
import { QaSimulationService } from './service'
import type { SimulationProviderPort } from './types'

export type QaSimulationDataStore = SimulationDataStorePort & SimulationApplicationDataPort

export interface CreateQaSimulationApplicationOptions {
  readonly store: QaSimulationDataStore
  readonly provider: SimulationProviderPort
  readonly publicationGateway: SimulationPublicationGateway
  readonly operationTimeoutMs?: number
  readonly maxAttempts?: number
  readonly retryDelayMs?: number
  readonly maxRawCharacters?: number
  readonly publicationTimeoutMs?: number
}

export function createQaSimulationApplication(
  options: CreateQaSimulationApplicationOptions,
): QaSimulationApplicationService {
  const service = new QaSimulationService({
    repository: new DataStoreSimulationRepository(options.store),
    knowledge: new DataStoreSimulationKnowledge(options.store),
    provider: options.provider,
    ...(options.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: options.operationTimeoutMs }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.maxRawCharacters === undefined ? {} : { maxRawCharacters: options.maxRawCharacters }),
  })
  return new QaSimulationApplicationService({
    service,
    data: options.store,
    publicationGateway: options.publicationGateway,
    ...(options.publicationTimeoutMs === undefined ? {} : { publicationTimeoutMs: options.publicationTimeoutMs }),
  })
}
