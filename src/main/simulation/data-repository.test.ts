import { describe, expect, it } from 'vitest'
import type {
  CommitSimulationBatchInput as DataCommitSimulationBatchInput,
  CreateSimulationJobInput as DataCreateSimulationJobInput,
  SimulationBatchCommitResult,
  SimulationItemPage,
  SimulationJobPage,
  SimulationJobRecord as DataSimulationJobRecord,
  SimulationProjectFence as DataSimulationProjectFence,
  TransitionSimulationJobInput as DataTransitionSimulationJobInput,
} from '../data/types'
import type { SimulationWorkflowError } from './errors'
import {
  DataStoreSimulationKnowledge,
  DataStoreSimulationRepository,
  type SimulationDataStorePort,
} from './data-repository'
import { createCoveragePlan, simulationBriefHash } from './planner'
import { SIMULATION_WORKFLOW_VERSION, type CreateSimulationJobInput, type QaSimulationBrief } from './types'

const BRIEF: QaSimulationBrief = {
  intervieweeIdentity: '项目负责人',
  audience: '评审专家',
  focusTopics: ['预算'],
  scenario: '项目评审',
  answerStyle: 'standard',
  excludedTopics: [],
}
const FENCE: DataSimulationProjectFence = {
  projectId: 'project-a',
  knowledgeVersion: 7,
  projectDataRevision: 11,
  sourceManifestHash: 'a'.repeat(64),
  sourceCount: 2,
}

function dataJob(overrides: Partial<DataSimulationJobRecord> = {}): DataSimulationJobRecord {
  return {
    jobId: 'job-a',
    projectId: FENCE.projectId,
    createOperationId: 'create-a',
    generation: 1,
    knowledgeVersion: FENCE.knowledgeVersion,
    projectDataRevision: FENCE.projectDataRevision,
    sourceManifestHash: FENCE.sourceManifestHash,
    sourceCount: FENCE.sourceCount,
    targetCount: 1,
    brief: BRIEF,
    briefFingerprint: 'b'.repeat(64),
    status: 'draft',
    reliableCount: 0,
    gapCount: 0,
    approvedCount: 0,
    publishedCount: 0,
    nextBatchOrdinal: 0,
    dataRevision: 0,
    largeRunAcknowledgedAt: null,
    errorCode: null,
    createdAt: 100,
    updatedAt: 100,
    completedAt: null,
    ...overrides,
  }
}

class FakeStore implements SimulationDataStorePort {
  job: DataSimulationJobRecord | null = null
  readonly creates: DataCreateSimulationJobInput[] = []
  readonly transitions: DataTransitionSimulationJobInput[] = []
  readonly commits: DataCommitSimulationBatchInput[] = []
  readonly evidenceQueries: Parameters<SimulationDataStorePort['searchProjectSimulationEvidence']>[0][] = []
  evidenceExcerpt = '项目预算为100万元。'

  getProjectSimulationFence(): DataSimulationProjectFence {
    return FENCE
  }

  searchProjectSimulationEvidence(
    input: Parameters<SimulationDataStorePort['searchProjectSimulationEvidence']>[0],
  ): ReturnType<SimulationDataStorePort['searchProjectSimulationEvidence']> {
    this.evidenceQueries.push(input)
    return [{
      chunkId: 'front-chunk',
      documentId: 'front-document',
      sourceId: null,
      sourceRevisionId: null,
      title: '前置记录',
      excerpt: this.evidenceExcerpt,
      contentHash: 'c'.repeat(64),
    }]
  }

  createSimulationJob(input: DataCreateSimulationJobInput): { readonly job: DataSimulationJobRecord; readonly inserted: boolean } {
    this.creates.push(input)
    this.job ??= dataJob({
      jobId: input.jobId,
      projectId: input.projectId,
      targetCount: input.targetCount,
      brief: input.brief,
      largeRunAcknowledgedAt: input.largeRunAcknowledgedAt ?? null,
    })
    return { job: this.job, inserted: this.creates.length === 1 }
  }

  getSimulationJob(projectId: string, jobId: string): DataSimulationJobRecord | null {
    return this.job?.projectId === projectId && this.job.jobId === jobId ? this.job : null
  }

  getLatestSimulationJob(projectId: string): DataSimulationJobRecord | null {
    return this.job?.projectId === projectId ? this.job : null
  }

  getSimulationJobPage(input: Parameters<SimulationDataStorePort['getSimulationJobPage']>[0]): SimulationJobPage {
    return {
      projectId: input.projectId,
      items: this.job?.projectId === input.projectId ? [this.job] : [],
      nextCursor: null,
      dataRevision: this.job?.dataRevision ?? 0,
    }
  }

  updateSimulationItem(): ReturnType<SimulationDataStorePort['updateSimulationItem']> {
    throw new Error('unused')
  }

  transitionSimulationJob(input: DataTransitionSimulationJobInput): {
    readonly job: DataSimulationJobRecord
    readonly inserted: boolean
  } {
    this.transitions.push(input)
    const current = this.job
    if (
      !current || current.status !== input.expectedStatus || current.generation !== input.expectedGeneration ||
      current.dataRevision !== input.expectedDataRevision
    ) throw new Error('SIMULATION_CAS_MISMATCH')
    const resumed = current.status === 'paused' && (input.nextStatus === 'queued' || input.nextStatus === 'running')
    this.job = {
      ...current,
      status: input.nextStatus,
      generation: resumed ? current.generation + 1 : current.generation,
      dataRevision: current.dataRevision + 1,
      errorCode: input.errorCode ?? null,
      updatedAt: current.updatedAt + 1,
      completedAt: ['completed', 'completed_with_gaps', 'failed', 'cancelled', 'stale'].includes(input.nextStatus)
        ? current.updatedAt + 1
        : null,
    }
    return { job: this.job, inserted: true }
  }

  commitSimulationBatch(input: DataCommitSimulationBatchInput): SimulationBatchCommitResult {
    this.commits.push(input)
    const current = this.job
    if (
      !current || current.status !== 'running' || current.generation !== input.expectedGeneration ||
      current.dataRevision !== input.expectedDataRevision
    ) throw new Error('SIMULATION_CAS_MISMATCH')
    const gapCount = input.gaps.reduce((sum, gap) => sum + gap.missingCount, 0)
    this.job = {
      ...current,
      reliableCount: current.reliableCount + input.items.length,
      gapCount: current.gapCount + gapCount,
      nextBatchOrdinal: current.nextBatchOrdinal + 1,
      dataRevision: current.dataRevision + 1,
    }
    return {
      batch: {
        batchId: 'batch-a', jobId: current.jobId, operationId: input.operationId,
        ordinal: current.nextBatchOrdinal, plannedCount: input.plannedCount,
        reliableCount: input.items.length, gapCount, contentFingerprint: 'd'.repeat(64), createdAt: 200,
      },
      job: this.job,
      items: [],
      gaps: [],
      inserted: true,
    }
  }

  getSimulationItemPage(input: Parameters<SimulationDataStorePort['getSimulationItemPage']>[0]): SimulationItemPage {
    return {
      projectId: input.projectId,
      jobId: input.jobId,
      items: [],
      nextCursor: null,
      dataRevision: this.job?.dataRevision ?? 0,
    }
  }
}

function createInput(): CreateSimulationJobInput {
  return {
    id: 'job-a',
    fence: FENCE,
    generation: 1,
    requestedCount: 1,
    brief: BRIEF,
    briefHash: simulationBriefHash(BRIEF),
    workflowVersion: SIMULATION_WORKFLOW_VERSION,
    createdAt: 100,
    largeBatchAcknowledgedAt: null,
  }
}

describe('simulation DataStore adapters', () => {
  it('creates and starts a job with full-fence and generation CAS transitions', async () => {
    const store = new FakeStore()
    const repository = new DataStoreSimulationRepository(store)
    const job = await repository.createJob(createInput())
    expect(job).toMatchObject({ state: 'planning', generation: 1, dataRevision: 2 })
    expect(store.creates[0]).toMatchObject({ projectId: 'project-a', fence: FENCE, targetCount: 1 })
    expect(store.transitions.map((entry) => [entry.expectedStatus, entry.nextStatus, entry.expectedGeneration])).toEqual([
      ['draft', 'queued', 1],
      ['queued', 'running', 1],
    ])
    await expect(repository.getLatestJob('project-a')).resolves.toMatchObject({ id: 'job-a' })
  })

  it('commits the canonical chunk hash and durable excerpt, then completes exactly once', async () => {
    const store = new FakeStore()
    const repository = new DataStoreSimulationRepository(store)
    const running = await repository.createJob(createInput())
    const slot = createCoveragePlan(BRIEF, 1).slots[0]!
    const committed = await repository.commitBatch({
      projectId: 'project-a',
      jobId: 'job-a',
      generation: running.generation,
      batchIndex: 0,
      operationId: 'batch-operation',
      slotIds: [slot.id],
      items: [{
        slotId: slot.id,
        ordinal: slot.ordinal,
        question: '项目预算是多少？',
        questionIdentity: '项目预算是多少',
        answer: '项目预算为100万元。',
        sourceReferences: [{
          sourceId: null, sourceRevisionId: null, documentId: 'front-document',
          chunkId: 'front-chunk', contentHash: 'c'.repeat(64),
        }],
        citations: [{
          sourceId: null, sourceRevisionId: null, documentId: 'front-document',
          chunkId: 'front-chunk', contentHash: 'c'.repeat(64), excerpt: '项目预算为100万元。',
        }],
      }],
      gaps: [],
      payloadHash: 'e'.repeat(64),
      usage: null,
      committedAt: 200,
    })
    expect(committed.job).toMatchObject({ fulfilledCount: 1, nextBatchOrdinal: 1 })
    expect(store.commits[0]?.items[0]?.citations[0]).toMatchObject({
      sourceId: null,
      sourceRevisionId: null,
      contentHash: 'c'.repeat(64),
      excerpt: '项目预算为100万元。',
    })
    const completed = await repository.transition({
      projectId: 'project-a', jobId: 'job-a', expectedGeneration: 1,
      expectedStates: ['generating'], nextState: 'review_required',
    })
    expect(completed).toMatchObject({ state: 'review_required', fulfilledCount: 1, gapCount: 0 })
    expect(store.transitions.at(-1)?.nextStatus).toBe('completed')
  })

  it('increments generation only on paused resume and rejects the old provider generation', async () => {
    const store = new FakeStore()
    const repository = new DataStoreSimulationRepository(store)
    await repository.createJob(createInput())
    const paused = await repository.transition({
      projectId: 'project-a', jobId: 'job-a', expectedGeneration: 1,
      expectedStates: ['generating'], nextState: 'interrupted', errorCode: 'CANCELLED',
    })
    expect(paused?.state).toBe('interrupted')
    const resumed = await repository.advanceGeneration({
      projectId: 'project-a', jobId: 'job-a', expectedGeneration: 1,
      expectedStates: ['interrupted'], nextState: 'retrieving',
    })
    expect(resumed).toMatchObject({ generation: 2, state: 'retrieving' })
    await expect(repository.commitBatch({
      projectId: 'project-a', jobId: 'job-a', generation: 1, batchIndex: 0,
      operationId: 'old-generation', slotIds: ['slot'], items: [],
      gaps: [], payloadHash: '0'.repeat(64), usage: null, committedAt: 300,
    })).rejects.toMatchObject({ code: 'SUPERSEDED' } satisfies Partial<SimulationWorkflowError>)
  })

  it('retrieves project-scoped front evidence using the complete frozen manifest fence', async () => {
    const store = new FakeStore()
    store.evidenceExcerpt = '预算'.repeat(1_000)
    const knowledge = new DataStoreSimulationKnowledge(store)
    const slot = createCoveragePlan(BRIEF, 1).slots[0]!
    const result = await knowledge.retrieveEvidence({
      fence: FENCE,
      brief: BRIEF,
      slots: [slot],
      signal: new AbortController().signal,
    })
    expect(store.evidenceQueries[0]).toMatchObject({
      projectId: 'project-a',
      knowledgeVersion: 7,
      sourceManifestHash: 'a'.repeat(64),
    })
    expect(result[0]?.evidence[0]).toMatchObject({
      reference: { sourceId: null, sourceRevisionId: null, contentHash: 'c'.repeat(64) },
      title: '前置记录',
    })
    expect(result[0]?.evidence[0]?.excerpt.length).toBe(1_600)
  })
})
