import type { ChunkTextOptions, TokenCounter } from './chunking'
import type { DataStore, DocumentUpsertResult, PresetQaUpsertResult } from './database'
import {
  importSourceDocument,
  importSourceDocumentDeferred,
  importSourceDocumentsDeferred,
  prepareProjectFrontDocumentDeferred,
  importStructuredQa,
  importStructuredQaBatch,
  validateAndDedupeQa,
  type SourceDocumentImport,
  type StructuredQaFormat,
  type StructuredQaSource,
} from './importers'
import type {
  CloseQaRoundResult,
  CloseQaRoundInput,
  CommitQaRoundInput,
  CommitQaRoundResult,
  EnsureQaRoundInput,
  PresetQaInput,
  QaWorkspacePage,
  QaWorkspacePageInput,
  LegacyQaWorkspacePageInput,
  QaWorkspaceExportPageInput,
  QaWorkspaceExportSnapshot,
  DeleteQaWorkspaceRoundResult,
  ClearQaWorkspaceProjectResult,
  CommitProjectFrontDocumentInput,
  AssignLegacyQaSessionResult,
  QaWorkspaceRound,
  SaveQaAnswerVersionInput,
  SaveQaAnswerVersionResult,
  CancelSimulationPublicationInput,
  CommitSimulationBatchInput,
  CompleteSimulationPublicationInput,
  CreateSimulationJobInput,
  PrepareSimulationPublicationInput,
  ReviewSimulationItemsInput,
  ResolveSimulationPublicationMappingsInput,
  SimulationBatchCommitResult,
  SimulationEvidenceHit,
  SimulationGapPage,
  SimulationItemPage,
  SimulationItemRecord,
  SimulationJobPage,
  SimulationJobRecord,
  SimulationPageInput,
  SimulationProjectFence,
  SimulationPublicationBundle,
  SimulationPublicationDraftBundle,
  SimulationPublicationMapping,
  SimulationResultPageInput,
  TransitionSimulationJobInput,
  UpdateSimulationItemInput,
  UpdateSimulationItemResult,
} from './types'
import type { VectorIndex } from './vector'

/**
 * Mutation boundary that keeps the canonical SQLite store and rebuildable
 * in-memory index consistent in the same event-loop turn.
 */
export class KnowledgeRepository {
  readonly #store: DataStore
  readonly #index: VectorIndex

  constructor(store: DataStore, index: VectorIndex) {
    this.#store = store
    this.#index = index
  }

  importSourceDocument(
    input: SourceDocumentImport,
    counter: TokenCounter,
    chunkOptions: ChunkTextOptions = {},
    now = Date.now(),
  ): DocumentUpsertResult {
    const result = importSourceDocument(this.#store, input, counter, chunkOptions, now)
    for (const chunkId of result.removedChunkIds) this.#index.delete('chunk', chunkId)
    return result
  }

  importSourceDocumentDeferred(
    input: SourceDocumentImport,
    chunkOptions: ChunkTextOptions = {},
    now = Date.now(),
  ): DocumentUpsertResult {
    const result = importSourceDocumentDeferred(this.#store, input, chunkOptions, now)
    for (const chunkId of result.removedChunkIds) this.#index.delete('chunk', chunkId)
    return result
  }

  importSourceDocumentsDeferred(
    inputs: readonly SourceDocumentImport[],
    chunkOptions: ChunkTextOptions = {},
    now = Date.now(),
  ): readonly DocumentUpsertResult[] {
    const results = importSourceDocumentsDeferred(this.#store, inputs, chunkOptions, now)
    for (const result of results) {
      for (const chunkId of result.removedChunkIds) this.#index.delete('chunk', chunkId)
    }
    return results
  }

  commitProjectFrontDocument(
    input: CommitProjectFrontDocumentInput,
    now = Date.now(),
  ): DocumentUpsertResult {
    const result = this.#store.commitProjectFrontDocument(input, now)
    for (const chunkId of result.removedChunkIds) this.#index.delete('chunk', chunkId)
    return result
  }

  prepareProjectFrontDocumentDeferred(
    input: Parameters<typeof prepareProjectFrontDocumentDeferred>[0],
    options: ChunkTextOptions = {},
  ): CommitProjectFrontDocumentInput['document'] {
    return prepareProjectFrontDocumentDeferred(input, options)
  }

  importStructuredQa(
    rawContent: string,
    format: StructuredQaFormat,
    now = Date.now(),
  ): readonly PresetQaUpsertResult[] {
    const results = importStructuredQa(this.#store, rawContent, format, now)
    for (const result of results) {
      if (result.contentChanged) this.#index.delete('preset_qa', result.record.id)
    }
    return results
  }

  importStructuredQaBatch(
    sources: readonly StructuredQaSource[],
    now = Date.now(),
  ): readonly PresetQaUpsertResult[] {
    const results = importStructuredQaBatch(this.#store, sources, now)
    for (const result of results) {
      if (result.contentChanged) this.#index.delete('preset_qa', result.record.id)
    }
    return results
  }

  /**
   * Commits the already-previewed batch. Duplicate questions are rejected here
   * rather than silently changing the number of records the user confirmed.
   */
  importPreparedStructuredQaBatch(
    items: readonly PresetQaInput[],
    now = Date.now(),
  ): readonly PresetQaUpsertResult[] {
    const prepared = validateAndDedupeQa(items)
    if (prepared.length !== items.length) {
      throw new Error('Prepared QA batch must not contain duplicate questions')
    }
    const results = this.#store.upsertPresetQaBatchIfNoConflicts(prepared, now)
    for (const result of results) {
      if (result.contentChanged) this.#index.delete('preset_qa', result.record.id)
    }
    return results
  }

  ensureQaRound(input: EnsureQaRoundInput): QaWorkspaceRound {
    return this.#store.ensureQaRound(input)
  }

  saveQaAnswerVersion(input: SaveQaAnswerVersionInput): SaveQaAnswerVersionResult {
    return this.#store.saveQaAnswerVersion(input)
  }

  commitQaRound(input: CommitQaRoundInput): CommitQaRoundResult {
    return this.#store.commitQaRound(input)
  }

  closeQaRound(input: CloseQaRoundInput): CloseQaRoundResult {
    return this.#store.closeQaRound(input)
  }

  getQaWorkspacePage(input: QaWorkspacePageInput): QaWorkspacePage {
    return this.#store.getQaWorkspacePage(input)
  }

  getLegacyQaWorkspacePage(input?: LegacyQaWorkspacePageInput): QaWorkspacePage {
    return this.#store.getLegacyQaWorkspacePage(input)
  }

  qaWorkspaceDataRevision(projectId: string): number {
    return this.#store.qaWorkspaceDataRevision(projectId)
  }

  deleteQaWorkspaceRound(input: {
    readonly projectId: string
    readonly roundId: string
  }): DeleteQaWorkspaceRoundResult {
    return this.#store.deleteQaWorkspaceRound(input)
  }

  clearQaWorkspaceProject(projectId: string): ClearQaWorkspaceProjectResult {
    return this.#store.clearQaWorkspaceProject(projectId)
  }

  assignLegacyQaSessionToProject(input: {
    readonly sessionId: string
    readonly projectId: string
  }): AssignLegacyQaSessionResult {
    return this.#store.assignLegacyQaSessionToProject(input)
  }

  beginQaWorkspaceExport(projectId: string): QaWorkspaceExportSnapshot {
    return this.#store.beginQaWorkspaceExport(projectId)
  }

  getQaWorkspaceExportPage(input: QaWorkspaceExportPageInput): QaWorkspacePage {
    return this.#store.getQaWorkspaceExportPage(input)
  }

  getProjectSimulationFence(projectId: string): SimulationProjectFence {
    return this.#store.getProjectSimulationFence(projectId)
  }

  searchProjectSimulationEvidence(input: {
    readonly projectId: string
    readonly knowledgeVersion: number
    readonly sourceManifestHash?: string
    readonly query: string
    readonly limit?: number
  }): readonly SimulationEvidenceHit[] {
    return this.#store.searchProjectSimulationEvidence(input)
  }

  getProjectSimulationSummary(projectId: string): ReturnType<DataStore['getProjectSimulationSummary']> {
    return this.#store.getProjectSimulationSummary(projectId)
  }

  createSimulationJob(
    input: CreateSimulationJobInput,
    now = Date.now(),
  ): { readonly job: SimulationJobRecord; readonly inserted: boolean } {
    return this.#store.createSimulationJob(input, now)
  }

  getSimulationJob(projectId: string, jobId: string): SimulationJobRecord | null {
    return this.#store.getSimulationJob(projectId, jobId)
  }

  getLatestSimulationJob(projectId: string): SimulationJobRecord | null {
    return this.#store.getLatestSimulationJob(projectId)
  }

  getSimulationJobPage(input: SimulationPageInput): SimulationJobPage {
    return this.#store.getSimulationJobPage(input)
  }

  transitionSimulationJob(
    input: TransitionSimulationJobInput,
    now = Date.now(),
  ): { readonly job: SimulationJobRecord; readonly inserted: boolean } {
    return this.#store.transitionSimulationJob(input, now)
  }

  commitSimulationBatch(input: CommitSimulationBatchInput, now = Date.now()): SimulationBatchCommitResult {
    return this.#store.commitSimulationBatch(input, now)
  }

  getSimulationItemPage(input: SimulationResultPageInput): SimulationItemPage {
    return this.#store.getSimulationItemPage(input)
  }

  getSimulationGapPage(input: SimulationResultPageInput): SimulationGapPage {
    return this.#store.getSimulationGapPage(input)
  }

  updateSimulationItem(
    input: UpdateSimulationItemInput,
    now = Date.now(),
  ): UpdateSimulationItemResult {
    return this.#store.updateSimulationItem(input, now)
  }

  reviewSimulationItems(
    input: ReviewSimulationItemsInput,
    now = Date.now(),
  ): {
    readonly job: SimulationJobRecord
    readonly items: readonly SimulationItemRecord[]
    readonly inserted: boolean
  } {
    return this.#store.reviewSimulationItems(input, now)
  }

  prepareSimulationPublication(
    input: PrepareSimulationPublicationInput,
    now = Date.now(),
  ): SimulationPublicationDraftBundle {
    return this.#store.prepareSimulationPublication(input, now)
  }

  completeSimulationPublication(
    input: CompleteSimulationPublicationInput,
    now = Date.now(),
  ): SimulationPublicationBundle {
    return this.#store.completeSimulationPublication(input, now)
  }

  resolveSimulationPublicationMappings(
    input: ResolveSimulationPublicationMappingsInput,
  ): readonly SimulationPublicationMapping[] {
    return this.#store.resolveSimulationPublicationMappings(input)
  }

  cancelSimulationPublication(
    input: CancelSimulationPublicationInput,
    now = Date.now(),
  ): SimulationPublicationBundle {
    return this.#store.cancelSimulationPublication(input, now)
  }

  recoverInterruptedSimulationJobs(now = Date.now()): readonly SimulationJobRecord[] {
    return this.#store.recoverInterruptedSimulationJobs(now)
  }

  deleteDocument(documentId: string): boolean {
    const chunkIds = this.#store.deleteDocument(documentId)
    for (const chunkId of chunkIds) this.#index.delete('chunk', chunkId)
    return chunkIds.length > 0
  }

  deletePresetQa(id: string): boolean {
    const deleted = this.#store.deletePresetQa(id)
    if (deleted) this.#index.delete('preset_qa', id)
    return deleted
  }
}
