import { describe, expect, it, vi } from 'vitest'
import type {
  CancelSimulationPublicationInput,
  CompleteSimulationPublicationInput,
  PrepareSimulationPublicationInput,
  ReviewSimulationItemsInput,
  SimulationGapRecord,
  SimulationItemRecord,
  SimulationJobRecord as DataSimulationJobRecord,
} from '../data/types'
import {
  QaSimulationApplicationService,
  SimulationPublicationGatewayError,
  type SimulationApplicationDataPort,
  type SimulationPublicationGateway,
} from './application'
import { QaSimulationService } from './service'
import type {
  QaSimulationBrief,
  SimulationKnowledgePort,
  SimulationProviderPort,
  SimulationRepositoryPort,
} from './types'

const BRIEF: QaSimulationBrief = {
  intervieweeIdentity: '项目负责人',
  audience: '评审专家',
  focusTopics: ['预算'],
  scenario: '项目评审',
  answerStyle: 'standard',
  excludedTopics: [],
}
const FENCE = {
  projectId: 'project-a', knowledgeVersion: 3, projectDataRevision: 4,
  sourceManifestHash: 'a'.repeat(64), sourceCount: 1,
} as const

function dataJob(overrides: Partial<DataSimulationJobRecord> = {}): DataSimulationJobRecord {
  return {
    jobId: 'job-a', projectId: 'project-a', createOperationId: 'create-a', generation: 1,
    knowledgeVersion: 3, projectDataRevision: 4, sourceManifestHash: 'a'.repeat(64), sourceCount: 1,
    targetCount: 3, brief: BRIEF, briefFingerprint: 'b'.repeat(64), status: 'completed_with_gaps',
    reliableCount: 2, gapCount: 1, approvedCount: 2, publishedCount: 0, nextBatchOrdinal: 1,
    dataRevision: 5, largeRunAcknowledgedAt: null, errorCode: null,
    createdAt: 100, updatedAt: 200, completedAt: 200,
    ...overrides,
  }
}

function item(id: string, ordinal: number): SimulationItemRecord {
  return {
    itemId: id, jobId: 'job-a', batchId: 'batch-a', ordinal,
    question: `预算问题${ordinal}？`, answer: `预算答案${ordinal}。`, category: '预算',
    reviewState: 'approved', contentFingerprint: String(ordinal).repeat(64),
    citations: [{
      citationId: `citation-${ordinal}`, itemId: id, ordinal: 0,
      chunkId: `chunk-${ordinal}`, documentId: 'document-a', sourceId: 'source-a',
      sourceRevisionId: 'revision-a', title: '预算资料', contentHash: 'c'.repeat(64),
      excerpt: `预算证据${ordinal}。`,
    }],
    editedAt: null, reviewedAt: 180, publishedAt: null, createdAt: 150,
  }
}

const GAP: SimulationGapRecord = {
  gapId: 'gap-a', jobId: 'job-a', batchId: 'batch-a', ordinal: 0,
  topic: '风险', reason: 'NO_RELEVANT_EVIDENCE', missingCount: 1,
  suggestedMaterial: '补充风险资料', checkedSourceCount: 1, createdAt: 160,
}

class FakeApplicationData implements SimulationApplicationDataPort {
  job = dataJob()
  items = [item('item-a', 0), item('item-b', 1)]
  readonly cancels: CancelSimulationPublicationInput[] = []
  readonly prepares: PrepareSimulationPublicationInput[] = []
  readonly completes: CompleteSimulationPublicationInput[] = []
  readonly reviews: ReviewSimulationItemsInput[] = []
  recoverCalls = 0

  recoverInterruptedSimulationJobs(): readonly DataSimulationJobRecord[] {
    this.recoverCalls += 1
    return []
  }

  getSimulationJob(projectId: string, jobId: string): DataSimulationJobRecord | null {
    return projectId === this.job.projectId && jobId === this.job.jobId ? this.job : null
  }

  getLatestSimulationJob(projectId: string): DataSimulationJobRecord | null {
    return projectId === this.job.projectId ? this.job : null
  }

  getSimulationItemPage(input: Parameters<SimulationApplicationDataPort['getSimulationItemPage']>[0]) {
    if (input.expectedDataRevision !== undefined && input.expectedDataRevision !== this.job.dataRevision) {
      throw new Error('SIMULATION_CURSOR_STALE')
    }
    const offset = input.cursor ? Number(input.cursor) : 0
    const limit = input.limit ?? 20
    const pageItems = this.items.slice(offset, offset + limit)
    const next = offset + pageItems.length
    return {
      projectId: input.projectId,
      jobId: input.jobId,
      items: pageItems,
      nextCursor: next < this.items.length ? String(next) : null,
      dataRevision: this.job.dataRevision,
    }
  }

  getSimulationGapPage(input: Parameters<SimulationApplicationDataPort['getSimulationGapPage']>[0]) {
    if (input.expectedDataRevision !== undefined && input.expectedDataRevision !== this.job.dataRevision) {
      throw new Error('SIMULATION_CURSOR_STALE')
    }
    const items = input.cursor ? [] : [GAP]
    return {
      projectId: input.projectId, jobId: input.jobId, items,
      nextCursor: null, dataRevision: this.job.dataRevision,
    }
  }

  updateSimulationItem(input: Parameters<SimulationApplicationDataPort['updateSimulationItem']>[0]) {
    const current = this.items.find((entry) => entry.itemId === input.itemId)!
    const updated = { ...current, question: input.question, answer: input.answer, editedAt: 250, reviewState: 'draft' as const }
    this.items = this.items.map((entry) => entry.itemId === updated.itemId ? updated : entry)
    this.job = { ...this.job, dataRevision: this.job.dataRevision + 1, approvedCount: this.job.approvedCount - 1 }
    return { job: this.job, item: updated, inserted: true }
  }

  reviewSimulationItems(input: ReviewSimulationItemsInput) {
    this.reviews.push(input)
    const decisions = new Map(input.decisions.map((entry) => [entry.itemId, entry.decision]))
    this.items = this.items.map((entry) => decisions.has(entry.itemId)
      ? { ...entry, reviewState: decisions.get(entry.itemId)!, reviewedAt: 260 }
      : entry)
    const approvedCount = this.items.filter((entry) => entry.reviewState === 'approved').length
    this.job = { ...this.job, dataRevision: this.job.dataRevision + 1, approvedCount }
    return { job: this.job, items: this.items, inserted: true }
  }

  prepareSimulationPublication(input: PrepareSimulationPublicationInput) {
    this.prepares.push(input)
    this.items = this.items.map((entry) => input.itemIds.includes(entry.itemId)
      ? { ...entry, reviewState: 'publishing' as const }
      : entry)
    this.job = { ...this.job, dataRevision: this.job.dataRevision + 1 }
    return {
      publication: {
        publicationId: 'publication-a', jobId: this.job.jobId, operationId: input.operationId,
        status: 'prepared' as const, contentFingerprint: 'd'.repeat(64), itemIds: input.itemIds,
        presetQaIds: [], createdAt: 300, updatedAt: 300, completedAt: null,
      },
      job: this.job,
      items: this.items.filter((entry) => input.itemIds.includes(entry.itemId)),
      inserted: true,
      canonicalMarkdown: '# 预设 QA\n',
      canonicalBodySha256: 'e'.repeat(64),
    }
  }

  completeSimulationPublication(input: CompleteSimulationPublicationInput) {
    this.completes.push(input)
    this.items = this.items.map((entry) => input.mappings.some((mapping) => mapping.itemId === entry.itemId)
      ? { ...entry, reviewState: 'published' as const, publishedAt: 350 }
      : entry)
    this.job = {
      ...this.job, dataRevision: this.job.dataRevision + 1,
      publishedCount: this.items.filter((entry) => entry.reviewState === 'published').length,
    }
    return {
      publication: {
        publicationId: input.publicationId, jobId: input.jobId, operationId: input.operationId,
        status: 'completed' as const, contentFingerprint: 'd'.repeat(64),
        itemIds: input.mappings.map((entry) => entry.itemId),
        presetQaIds: input.mappings.map((entry) => entry.presetQaId),
        createdAt: 300, updatedAt: 350, completedAt: 350,
      },
      job: this.job,
      items: this.items,
      inserted: true,
    }
  }

  cancelSimulationPublication(input: CancelSimulationPublicationInput) {
    this.cancels.push(input)
    this.items = this.items.map((entry) => entry.reviewState === 'publishing'
      ? { ...entry, reviewState: 'approved' as const }
      : entry)
    this.job = { ...this.job, dataRevision: this.job.dataRevision + 1 }
    return {
      publication: {
        publicationId: input.publicationId, jobId: input.jobId, operationId: input.operationId,
        status: 'cancelled' as const, contentFingerprint: 'd'.repeat(64), itemIds: [], presetQaIds: [],
        createdAt: 300, updatedAt: 350, completedAt: 350,
      },
      job: this.job, items: [], inserted: true,
    }
  }

  resolveSimulationPublicationMappings(input: Parameters<SimulationApplicationDataPort['resolveSimulationPublicationMappings']>[0]) {
    return input.items.map((entry, index) => ({ itemId: entry.itemId, presetQaId: `preset-${index}` }))
  }
}

function coreService(): QaSimulationService {
  const repository: SimulationRepositoryPort = {
    createJob: async () => { throw new Error('unused') },
    getJob: async () => null,
    getLatestJob: async () => null,
    transition: async () => null,
    advanceGeneration: async () => null,
    saveCoveragePlan: async () => undefined,
    getCoveragePlan: async () => null,
    listBatches: async () => [],
    acceptedQuestionIdentities: async () => [],
    commitBatch: async () => { throw new Error('unused') },
  }
  const knowledge: SimulationKnowledgePort = {
    getProjectFence: async (projectId) => projectId === 'project-a' ? FENCE : null,
    retrieveEvidence: async () => [],
  }
  const provider: SimulationProviderPort = {
    generateBatch: async () => { throw new Error('unused') },
  }
  return new QaSimulationService({ repository, knowledge, provider })
}

function fixture(gateway?: SimulationPublicationGateway, publicationTimeoutMs = 100) {
  const data = new FakeApplicationData()
  const publicationGateway = gateway ?? {
    publish: async (input) => ({
      mappings: input.itemIds.map((itemId, index) => ({ itemId, presetQaId: `preset-${index}` })),
    }),
  }
  const application = new QaSimulationApplicationService({
    service: coreService(), data, publicationGateway, publicationTimeoutMs,
  })
  return { application, data, publicationGateway }
}

describe('QA simulation application boundary', () => {
  it('applies the caller default of 30 and exposes the complete knowledge fence', async () => {
    const { application, data } = fixture()
    expect(data.recoverCalls).toBe(1)
    await expect(application.preflight({ projectId: 'project-a', brief: BRIEF })).resolves.toMatchObject({
      fence: FENCE, targetCount: 30, estimatedBatches: 3, evidenceSourceCount: 1,
    })
    await application.dispose()
  })

  it('returns the latest project job and paginates item bodies before gaps without scope drift', async () => {
    const { application } = fixture()
    await expect(application.getLatestJob('project-a')).resolves.toMatchObject({ id: 'job-a', state: 'review_required' })
    const first = await application.getPage({ projectId: 'project-a', jobId: 'job-a', limit: 1 })
    expect(first.items).toEqual([expect.objectContaining({ id: 'item-a', citations: [expect.objectContaining({ title: '预算资料' })] })])
    expect(first.gaps).toEqual([])
    const second = await application.getPage({ projectId: 'project-a', jobId: 'job-a', limit: 1, cursor: first.nextCursor })
    expect(second.items[0]?.id).toBe('item-b')
    const third = await application.getPage({ projectId: 'project-a', jobId: 'job-a', limit: 1, cursor: second.nextCursor })
    expect(third).toMatchObject({ items: [], gaps: [{ id: 'gap-a' }], nextCursor: null })
    await application.dispose()
  })

  it('persists edits and reviews through CAS and isolates changed-listener failures', async () => {
    const { application, data } = fixture()
    const healthy = vi.fn()
    application.subscribe(() => { throw new Error('listener failed') })
    application.subscribe(healthy)
    const edited = await application.updateItem({
      projectId: 'project-a', jobId: 'job-a', itemId: 'item-a', expectedDataRevision: 5,
      question: '新问题？', answer: '新答案。',
    })
    expect(edited.dataRevision).toBe(6)
    await application.reviewItems({
      projectId: 'project-a', jobId: 'job-a', itemIds: ['item-a'],
      expectedDataRevision: 6, decision: 'approve',
    })
    expect(data.reviews[0]?.decisions).toEqual([{ itemId: 'item-a', decision: 'approved' }])
    expect(healthy).toHaveBeenCalledTimes(2)
    await application.dispose()
  })

  it('publishes only through prepare, the idempotent project gateway, and complete', async () => {
    const gateway = { publish: vi.fn(async (input: Parameters<SimulationPublicationGateway['publish']>[0]) => ({
      mappings: input.itemIds.map((itemId, index) => ({ itemId, presetQaId: `preset-${index}` })),
    })) }
    const { application, data } = fixture(gateway)
    const result = await application.publish({ projectId: 'project-a', jobId: 'job-a', expectedDataRevision: 5 })
    expect(data.prepares).toHaveLength(1)
    expect(gateway.publish).toHaveBeenCalledWith(expect.objectContaining({
      canonicalMarkdown: '# 预设 QA\n', canonicalBodySha256: 'e'.repeat(64), itemIds: ['item-a', 'item-b'],
      items: [
        { itemId: 'item-a', question: '预算问题0？', answer: '预算答案0。' },
        { itemId: 'item-b', question: '预算问题1？', answer: '预算答案1。' },
      ],
    }))
    expect(data.completes[0]?.mappings).toEqual([
      { itemId: 'item-a', presetQaId: 'preset-0' },
      { itemId: 'item-b', presetQaId: 'preset-1' },
    ])
    expect(result).toMatchObject({ state: 'completed_with_gaps', reliableCount: 2, gapCount: 1 })
    await application.dispose()
  })

  it('cancels a prepared publication only for a guaranteed zero-commit gateway failure', async () => {
    const safeFailure: SimulationPublicationGateway = {
      publish: async () => { throw new SimulationPublicationGatewayError('WRITE_REJECTED', true) },
    }
    const safe = fixture(safeFailure)
    await expect(safe.application.publish({ projectId: 'project-a', jobId: 'job-a', expectedDataRevision: 5 })).rejects.toThrow('WRITE_REJECTED')
    expect(safe.data.cancels).toHaveLength(1)
    await safe.application.dispose()

    const uncertainFailure: SimulationPublicationGateway = {
      publish: async () => { throw new SimulationPublicationGatewayError('COMMIT_UNKNOWN', false) },
    }
    const uncertain = fixture(uncertainFailure)
    await expect(uncertain.application.publish({ projectId: 'project-a', jobId: 'job-a', expectedDataRevision: 5 })).rejects.toThrow('COMMIT_UNKNOWN')
    expect(uncertain.data.cancels).toHaveLength(0)
    expect(uncertain.data.items.every((entry) => entry.reviewState === 'publishing')).toBe(true)
    await uncertain.application.dispose()
  })

  it('bounds a publication gateway that ignores abort and leaves the prepared operation recoverable', async () => {
    const gateway: SimulationPublicationGateway = { publish: async () => new Promise(() => undefined) }
    const { application, data } = fixture(gateway, 5)
    await expect(application.publish({ projectId: 'project-a', jobId: 'job-a', expectedDataRevision: 5 })).rejects.toThrow('PUBLICATION_TIMEOUT')
    expect(data.cancels).toHaveLength(0)
    await application.dispose()
  })
})
