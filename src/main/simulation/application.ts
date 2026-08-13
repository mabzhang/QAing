import { createHash } from 'node:crypto'
import type {
  PublishQaSimulationInput,
  QaSimulationChangedEvent,
  QaSimulationCitation,
  QaSimulationGap,
  QaSimulationItem,
  QaSimulationJobState as PublicJobState,
  QaSimulationJobSummary,
  QaSimulationPage,
  QaSimulationPageInput,
  QaSimulationPreflight,
  QaSimulationPreflightInput,
  ReviewQaSimulationItemsInput,
  StartQaSimulationInput,
  UpdateQaSimulationItemInput,
} from '../../core/contracts'
import type {
  CancelSimulationPublicationInput,
  CompleteSimulationPublicationInput,
  PrepareSimulationPublicationInput,
  ReviewSimulationItemsInput,
  SimulationGapPage,
  SimulationGapRecord,
  SimulationItemPage,
  SimulationItemRecord,
  SimulationJobRecord as DataSimulationJobRecord,
  SimulationPublicationBundle,
  SimulationPublicationDraftBundle,
} from '../data/types'
import { SimulationWorkflowError } from './errors'
import type { QaSimulationService } from './service'
import type { QaSimulationJobRecord, QaSimulationJobState } from './types'

const DEFAULT_TARGET_COUNT = 30
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const DEFAULT_PUBLICATION_TIMEOUT_MS = 60_000

type ChangedListener = (event: QaSimulationChangedEvent) => void

interface UpdateSimulationItemDataInput {
  readonly operationId: string
  readonly projectId: string
  readonly jobId: string
  readonly itemId: string
  readonly expectedDataRevision: number
  readonly question: string
  readonly answer: string
}

export interface SimulationApplicationDataPort {
  recoverInterruptedSimulationJobs(): readonly DataSimulationJobRecord[]
  getSimulationJob(projectId: string, jobId: string): DataSimulationJobRecord | null
  getLatestSimulationJob(projectId: string): DataSimulationJobRecord | null
  getSimulationItemPage(input: {
    readonly projectId: string
    readonly jobId: string
    readonly cursor?: string | null
    readonly limit?: number
    readonly expectedDataRevision?: number
  }): SimulationItemPage
  getSimulationGapPage(input: {
    readonly projectId: string
    readonly jobId: string
    readonly cursor?: string | null
    readonly limit?: number
    readonly expectedDataRevision?: number
  }): SimulationGapPage
  updateSimulationItem(input: UpdateSimulationItemDataInput): {
    readonly job: DataSimulationJobRecord
    readonly item: SimulationItemRecord
    readonly inserted: boolean
  }
  reviewSimulationItems(input: ReviewSimulationItemsInput): {
    readonly job: DataSimulationJobRecord
    readonly items: readonly SimulationItemRecord[]
    readonly inserted: boolean
  }
  prepareSimulationPublication(input: PrepareSimulationPublicationInput): SimulationPublicationDraftBundle
  completeSimulationPublication(input: CompleteSimulationPublicationInput): SimulationPublicationBundle
  cancelSimulationPublication(input: CancelSimulationPublicationInput): SimulationPublicationBundle
  resolveSimulationPublicationMappings(input: {
    readonly projectId: string
    readonly items: ReadonlyArray<{
      readonly itemId: string
      readonly question: string
      readonly answer: string
    }>
  }): readonly SimulationPublicationMapping[]
}

export interface SimulationPublicationMapping {
  readonly itemId: string
  readonly presetQaId: string
}

/**
 * The gateway owns the durable FS + ProjectSync saga. Its operationId must be
 * idempotent. If it reports definitelyNotCommitted=true, no managed QA artifact
 * or preset QA row may remain; otherwise the prepared Data row is intentionally
 * retained so the same operation can be replayed after restart.
 */
export interface SimulationPublicationGateway {
  publish(input: {
    readonly operationId: string
    readonly projectId: string
    readonly jobId: string
    readonly publicationId: string
    readonly canonicalMarkdown: string
    readonly canonicalBodySha256: string
    readonly itemIds: readonly string[]
    readonly items: ReadonlyArray<{
      readonly itemId: string
      readonly question: string
      readonly answer: string
    }>
    readonly signal: AbortSignal
  }): Promise<{ readonly mappings: readonly SimulationPublicationMapping[] }>
}

export class SimulationPublicationGatewayError extends Error {
  readonly definitelyNotCommitted: boolean

  constructor(code: string, definitelyNotCommitted: boolean) {
    super(code)
    this.name = 'SimulationPublicationGatewayError'
    this.definitelyNotCommitted = definitelyNotCommitted
  }
}

interface ApplicationOptions {
  readonly service: QaSimulationService
  readonly data: SimulationApplicationDataPort
  readonly publicationGateway: SimulationPublicationGateway
  readonly publicationTimeoutMs?: number
}

interface PageCursor {
  readonly version: 1
  readonly projectId: string
  readonly jobId: string
  readonly dataRevision: number
  readonly itemCursor: string | null
  readonly gapCursor: string | null
  readonly itemsDone: boolean
  readonly gapsDone: boolean
}

function digest(...parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\0')
  return hash.digest('hex')
}

function operationId(kind: string, ...parts: readonly string[]): string {
  return `simapp_${kind}_${digest(kind, ...parts).slice(0, 32)}`
}

function dataState(job: DataSimulationJobRecord): PublicJobState {
  switch (job.status) {
    case 'draft':
    case 'awaiting_large_run_confirmation':
    case 'queued': return 'planning'
    case 'running': return 'generating'
    case 'paused': return 'paused'
    case 'completed':
    case 'completed_with_gaps':
      return job.publishedCount === job.reliableCount && job.reliableCount > 0
        ? (job.gapCount > 0 ? 'completed_with_gaps' : 'completed')
        : 'review_required'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'stale': return 'stale'
  }
}

function summaryFromData(job: DataSimulationJobRecord, state = dataState(job)): QaSimulationJobSummary {
  return {
    id: job.jobId,
    projectId: job.projectId,
    generation: job.generation,
    knowledgeVersion: job.knowledgeVersion,
    state,
    targetCount: job.targetCount,
    completedBatches: job.nextBatchOrdinal,
    totalBatches: Math.ceil(job.targetCount / 10),
    reliableCount: job.reliableCount,
    gapCount: job.gapCount,
    approvedCount: job.approvedCount,
    dataRevision: job.dataRevision,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    errorCode: job.errorCode,
  }
}

function summaryFromCore(job: QaSimulationJobRecord): QaSimulationJobSummary {
  return {
    id: job.id,
    projectId: job.fence.projectId,
    generation: job.generation,
    knowledgeVersion: job.fence.knowledgeVersion,
    state: publicCoreState(job.state),
    targetCount: job.requestedCount,
    completedBatches: job.nextBatchOrdinal,
    totalBatches: Math.ceil(job.requestedCount / 10),
    reliableCount: job.fulfilledCount,
    gapCount: job.gapCount,
    approvedCount: job.approvedCount,
    dataRevision: job.dataRevision,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    errorCode: job.errorCode,
  }
}

function publicCoreState(state: QaSimulationJobState): PublicJobState {
  return state === 'retrieving' ? 'generating' : state
}

function changedFromSummary(job: QaSimulationJobSummary): QaSimulationChangedEvent {
  return {
    projectId: job.projectId,
    jobId: job.id,
    generation: job.generation,
    knowledgeVersion: job.knowledgeVersion,
    dataRevision: job.dataRevision,
  }
}

function citationTitle(citation: SimulationItemRecord['citations'][number]): string {
  const title = citation.title.trim()
  return title || (citation.sourceId === null ? '前置记录' : '项目资料')
}

function citationFromData(citation: SimulationItemRecord['citations'][number]): QaSimulationCitation {
  return {
    sourceId: citation.sourceId,
    sourceRevisionId: citation.sourceRevisionId,
    documentId: citation.documentId,
    chunkId: citation.chunkId,
    title: citationTitle(citation),
    excerpt: citation.excerpt,
    contentHash: citation.contentHash,
  }
}

function itemFromData(item: SimulationItemRecord): QaSimulationItem {
  const status: QaSimulationItem['status'] = item.reviewState === 'draft'
    ? 'machine_validated'
    : item.reviewState === 'approved' || item.reviewState === 'publishing'
      ? 'human_approved'
      : item.reviewState === 'rejected'
        ? 'rejected'
        : 'published_preset'
  return {
    id: item.itemId,
    ordinal: item.ordinal,
    topic: item.category ?? '综合',
    question: item.question,
    answer: item.answer,
    status,
    validationCodes: [],
    citations: item.citations.map(citationFromData),
    editedAt: item.editedAt,
    approvedAt: item.reviewedAt,
  }
}

function gapFromData(gap: SimulationGapRecord): QaSimulationGap {
  return {
    id: gap.gapId,
    ordinal: gap.ordinal,
    topic: gap.topic,
    reason: gap.reason,
    suggestedMaterial: gap.suggestedMaterial,
  }
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string, projectId: string, jobId: string): PageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<PageCursor>
    if (
      parsed.version !== 1 || parsed.projectId !== projectId || parsed.jobId !== jobId ||
      !Number.isSafeInteger(parsed.dataRevision) || (parsed.dataRevision as number) < 0 ||
      typeof parsed.itemsDone !== 'boolean' || typeof parsed.gapsDone !== 'boolean' ||
      (parsed.itemCursor !== null && typeof parsed.itemCursor !== 'string') ||
      (parsed.gapCursor !== null && typeof parsed.gapCursor !== 'string')
    ) throw new Error('invalid')
    return parsed as PageCursor
  } catch {
    throw new SimulationWorkflowError('INVALID_INPUT', false)
  }
}

function validateMappings(itemIds: readonly string[], mappings: readonly SimulationPublicationMapping[]): void {
  if (
    mappings.length !== itemIds.length || new Set(mappings.map((entry) => entry.itemId)).size !== mappings.length ||
    new Set(mappings.map((entry) => entry.presetQaId)).size !== mappings.length ||
    mappings.some((entry, index) => entry.itemId !== itemIds[index] || !entry.presetQaId.trim())
  ) throw new SimulationPublicationGatewayError('INVALID_PUBLICATION_MAPPING', false)
}

export class QaSimulationApplicationService {
  readonly #service: QaSimulationService
  readonly #data: SimulationApplicationDataPort
  readonly #publicationGateway: SimulationPublicationGateway
  readonly #publicationTimeoutMs: number
  readonly #listeners = new Set<ChangedListener>()
  readonly #unsubscribeService: () => void

  constructor(options: ApplicationOptions) {
    this.#service = options.service
    this.#data = options.data
    this.#publicationGateway = options.publicationGateway
    this.#publicationTimeoutMs = options.publicationTimeoutMs ?? DEFAULT_PUBLICATION_TIMEOUT_MS
    if (!Number.isSafeInteger(this.#publicationTimeoutMs) || this.#publicationTimeoutMs < 1) {
      throw new SimulationWorkflowError('INVALID_INPUT', false)
    }
    // A process crash cannot leave a durable job looking live. Recovery keeps
    // its generation unchanged; an explicit resume performs the sole bump.
    this.#data.recoverInterruptedSimulationJobs()
    this.#unsubscribeService = this.#service.subscribe((job) => this.#emit(changedFromSummary(summaryFromCore(job))))
  }

  async preflight(input: QaSimulationPreflightInput): Promise<QaSimulationPreflight> {
    const result = await this.#service.preflight({
      projectId: input.projectId,
      requestedCount: input.targetCount ?? DEFAULT_TARGET_COUNT,
      brief: input.brief,
    })
    return {
      fence: result.fence,
      targetCount: result.requestedCount,
      warnings: result.warnings,
      confirmationRequired: result.confirmationRequired,
      estimatedBatches: result.estimatedBatches,
      evidenceSourceCount: result.fence.sourceCount,
    }
  }

  async start(input: StartQaSimulationInput): Promise<QaSimulationJobSummary> {
    return summaryFromCore(await this.#service.start({
      fence: input.fence,
      requestedCount: input.targetCount,
      brief: input.brief,
      ...(input.largeBatchAcknowledged === undefined ? {} : { largeBatchAcknowledged: input.largeBatchAcknowledged }),
    }))
  }

  async getJob(projectId: string, jobId: string): Promise<QaSimulationJobSummary> {
    const job = this.#data.getSimulationJob(projectId, jobId)
    if (!job) throw new SimulationWorkflowError('JOB_NOT_FOUND', false)
    return summaryFromData(job)
  }

  async getLatestJob(projectId: string): Promise<QaSimulationJobSummary | null> {
    const job = this.#data.getLatestSimulationJob(projectId)
    return job ? summaryFromData(job) : null
  }

  async getPage(input: QaSimulationPageInput): Promise<QaSimulationPage> {
    const job = this.#data.getSimulationJob(input.projectId, input.jobId)
    if (!job) throw new SimulationWorkflowError('JOB_NOT_FOUND', false)
    const cursor = input.cursor ? decodeCursor(input.cursor, input.projectId, input.jobId) : null
    const expectedRevision = cursor?.dataRevision ?? input.expectedDataRevision ?? job.dataRevision
    if (job.dataRevision !== expectedRevision) throw new SimulationWorkflowError('REPOSITORY_CONFLICT', false)
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, input.limit ?? DEFAULT_PAGE_SIZE))
    const itemLimit = cursor?.itemsDone
      ? 0
      : cursor?.gapsDone
        ? limit
        : Math.ceil(limit / 2)
    const gapLimit = cursor?.gapsDone ? 0 : limit - itemLimit
    const itemPage = itemLimit > 0
      ? this.#data.getSimulationItemPage({
          projectId: input.projectId, jobId: input.jobId, expectedDataRevision: expectedRevision,
          cursor: cursor?.itemCursor ?? null, limit: itemLimit,
        })
      : null
    const gapPage = gapLimit > 0
      ? this.#data.getSimulationGapPage({
          projectId: input.projectId, jobId: input.jobId, expectedDataRevision: expectedRevision,
          cursor: cursor?.gapCursor ?? null, limit: gapLimit,
        })
      : null
    const next: PageCursor = {
      version: 1,
      projectId: input.projectId,
      jobId: input.jobId,
      dataRevision: expectedRevision,
      itemCursor: itemPage?.nextCursor ?? cursor?.itemCursor ?? null,
      gapCursor: gapPage?.nextCursor ?? cursor?.gapCursor ?? null,
      itemsDone: cursor?.itemsDone === true || itemPage?.nextCursor === null,
      gapsDone: cursor?.gapsDone === true || gapPage?.nextCursor === null,
    }
    return {
      projectId: input.projectId,
      jobId: input.jobId,
      generation: job.generation,
      knowledgeVersion: job.knowledgeVersion,
      dataRevision: expectedRevision,
      totalItems: job.reliableCount,
      items: (itemPage?.items ?? []).map(itemFromData),
      gaps: (gapPage?.items ?? []).map(gapFromData),
      nextCursor: next.itemsDone && next.gapsDone ? null : encodeCursor(next),
    }
  }

  async updateItem(input: UpdateQaSimulationItemInput): Promise<QaSimulationJobSummary> {
    const result = this.#data.updateSimulationItem({
      operationId: operationId(
        'edit', input.projectId, input.jobId, input.itemId,
        String(input.expectedDataRevision), input.question, input.answer,
      ),
      ...input,
    })
    const summary = summaryFromData(result.job)
    this.#emit(changedFromSummary(summary))
    return summary
  }

  async reviewItems(input: ReviewQaSimulationItemsInput): Promise<QaSimulationJobSummary> {
    const decision = input.decision === 'approve' ? 'approved' : 'rejected'
    const sortedIds = [...new Set(input.itemIds)].sort()
    if (sortedIds.length === 0 || sortedIds.length !== input.itemIds.length) {
      throw new SimulationWorkflowError('INVALID_INPUT', false)
    }
    const result = this.#data.reviewSimulationItems({
      operationId: operationId(
        'review', input.projectId, input.jobId, String(input.expectedDataRevision), decision, ...sortedIds,
      ),
      projectId: input.projectId,
      jobId: input.jobId,
      expectedDataRevision: input.expectedDataRevision,
      decisions: sortedIds.map((itemId) => ({ itemId, decision })),
    })
    const summary = summaryFromData(result.job)
    this.#emit(changedFromSummary(summary))
    return summary
  }

  async cancel(projectId: string, jobId: string): Promise<QaSimulationJobSummary> {
    return summaryFromCore(await this.#service.cancel(projectId, jobId))
  }

  async resume(projectId: string, jobId: string): Promise<QaSimulationJobSummary> {
    return summaryFromCore(await this.#service.resume(projectId, jobId))
  }

  pauseActive(): Promise<void> {
    return this.#service.pauseActive()
  }

  async publish(input: PublishQaSimulationInput): Promise<QaSimulationJobSummary> {
    const selected = this.#publicationItemIds(input.projectId, input.jobId, input.expectedDataRevision)
    if (selected.length === 0) throw new SimulationWorkflowError('INVALID_INPUT', false)
    const prepareOperationId = operationId('publication-prepare', input.projectId, input.jobId, ...selected)
    const draft = this.#data.prepareSimulationPublication({
      operationId: prepareOperationId,
      projectId: input.projectId,
      jobId: input.jobId,
      expectedDataRevision: input.expectedDataRevision,
      itemIds: selected,
    })
    this.#emit(changedFromSummary(summaryFromData(draft.job, 'publishing')))
    const gatewayOperationId = operationId('publication-materialize', draft.publication.publicationId)
    const controller = new AbortController()
    let rejectTimeout: ((error: SimulationPublicationGatewayError) => void) | null = null
    const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject })
    const timeout = setTimeout(() => {
      controller.abort()
      rejectTimeout?.(new SimulationPublicationGatewayError('PUBLICATION_TIMEOUT', false))
    }, this.#publicationTimeoutMs)
    try {
      const result = await Promise.race([this.#publicationGateway.publish({
        operationId: gatewayOperationId,
        projectId: input.projectId,
        jobId: input.jobId,
        publicationId: draft.publication.publicationId,
        canonicalMarkdown: draft.canonicalMarkdown,
        canonicalBodySha256: draft.canonicalBodySha256,
        itemIds: selected,
        items: selected.map((itemId) => {
          const item = draft.items.find((entry) => entry.itemId === itemId)
          if (!item) throw new SimulationPublicationGatewayError('INVALID_PUBLICATION_DRAFT', false)
          return { itemId, question: item.question, answer: item.answer }
        }),
        signal: controller.signal,
      }), timeoutPromise])
      validateMappings(selected, result.mappings)
      const verifiedMappings = this.#data.resolveSimulationPublicationMappings({
        projectId: input.projectId,
        items: draft.items.map((item) => ({
          itemId: item.itemId,
          question: item.question,
          answer: item.answer,
        })),
      })
      validateMappings(selected, verifiedMappings)
      const completed = this.#data.completeSimulationPublication({
        operationId: operationId('publication-complete', draft.publication.publicationId, ...selected),
        projectId: input.projectId,
        jobId: input.jobId,
        publicationId: draft.publication.publicationId,
        expectedDataRevision: draft.job.dataRevision,
        mappings: verifiedMappings,
      })
      const summary = summaryFromData(completed.job)
      this.#emit(changedFromSummary(summary))
      return summary
    } catch (error) {
      if (error instanceof SimulationPublicationGatewayError && error.definitelyNotCommitted) {
        const current = this.#data.getSimulationJob(input.projectId, input.jobId)
        if (current) {
          const cancelled = this.#data.cancelSimulationPublication({
            operationId: operationId('publication-cancel', draft.publication.publicationId),
            projectId: input.projectId,
            jobId: input.jobId,
            publicationId: draft.publication.publicationId,
            expectedDataRevision: current.dataRevision,
          })
          this.#emit(changedFromSummary(summaryFromData(cancelled.job)))
        }
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  subscribe(listener: ChangedListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    this.#unsubscribeService()
    this.#listeners.clear()
    await this.#service.dispose()
  }

  #publicationItemIds(projectId: string, jobId: string, expectedDataRevision: number): readonly string[] {
    let cursor: string | null = null
    const approved: string[] = []
    const publishing: string[] = []
    do {
      const page = this.#data.getSimulationItemPage({
        projectId,
        jobId,
        expectedDataRevision,
        cursor,
        limit: MAX_PAGE_SIZE,
      })
      for (const item of page.items) {
        if (item.reviewState === 'approved') approved.push(item.itemId)
        if (item.reviewState === 'publishing') publishing.push(item.itemId)
      }
      cursor = page.nextCursor
    } while (cursor)
    return publishing.length > 0 ? publishing : approved
  }

  #emit(event: QaSimulationChangedEvent): void {
    for (const listener of this.#listeners) {
      try { listener(event) } catch { /* Durable state remains canonical. */ }
    }
  }
}
