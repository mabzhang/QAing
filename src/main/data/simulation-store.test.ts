import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DataStore } from './database'
import { sha256 } from './hash'
import { validateCanonicalArtifact } from './importers'
import type {
  ProjectScanObservation,
  SimulationInterviewBrief,
  SimulationProjectFence,
} from './types'
import { projectSourceId } from '../project/planner'

const BRIEF: SimulationInterviewBrief = {
  intervieweeIdentity: '品牌负责人',
  audience: '项目评审人',
  focusTopics: ['预算', '进度'],
  scenario: '项目答辩',
  answerStyle: 'concise',
  excludedTopics: ['未公开数据'],
}

function project(id: string) {
  return {
    id,
    displayName: id,
    rootPath: `/tmp/${id}`,
    rootIdentity: `root:${id}`,
    schemaVersion: 1,
  }
}

function observation(
  path: string,
  content: string,
  trustKind: ProjectScanObservation['trustKind'] = 'document',
): ProjectScanObservation {
  return {
    trustKind,
    displayRelativePath: path,
    pathKey: path.normalize('NFC').toLocaleLowerCase('zh-CN'),
    sizeBytes: Buffer.byteLength(content),
    mtimeNs: '1',
    rawSha256: sha256(content),
    detectedType: trustKind === 'document' ? 'text/markdown' : 'text/markdown+qa',
  }
}

function prepareQaArtifact(
  store: DataStore,
  projectId: string,
  runId: string,
  sourcePath: string,
  canonicalContent: string,
  now: number,
) {
  const validated = validateCanonicalArtifact({ trustKind: 'preset_qa', canonicalContent })
  const run = store.beginProjectScan({
    runId,
    projectId,
    rootIdentity: `root:${projectId}`,
    trigger: 'manual',
    startedAt: now,
  })
  const scan = store.applyProjectScanManifest({
    runId,
    projectId,
    generation: run.generation,
    observations: [observation(sourcePath, canonicalContent, 'preset_qa')],
    completedAt: now + 1,
  })
  store.finishProjectSync(runId, 'completed', null, now + 2)
  const sourceId = projectSourceId(
    projectId,
    'preset_qa',
    sourcePath.normalize('NFC').toLocaleLowerCase('zh-CN'),
  )
  const pending = scan.pendingRevisions.find((entry) => entry.sourceId === sourceId)
  if (!pending) throw new Error('Missing fixture QA revision')
  const operationId = `operation-${runId}`
  const artifactId = `artifact-${runId}`
  const fullArtifact = `---\nqaing_schema: "qaing-converted/v1"\ncontent_kind: "preset_qa"\n---\n\n${validated.normalizedContent}\n`
  const outputSha256 = sha256(fullArtifact)
  store.prepareConversionJob({
    operationId,
    projectId,
    sourceId,
    revisionId: pending.revisionId,
    generation: run.generation,
    inputSha256: sha256(canonicalContent),
    tempRelativePath: `转换资料库/预设QA/${runId}.md.tmp`,
    finalRelativePath: `转换资料库/预设QA/${runId}.md`,
    conversionMode: 'local',
    converterId: 'test',
    converterVersion: '1',
    artifactSchemaVersion: 1,
    cacheKey: `cache-${runId}`,
  }, now + 3)
  store.stageConversionArtifact({ operationId, artifactId, outputSha256, contentKind: 'preset_qa' }, now + 4)
  store.markConversionPublished(operationId, outputSha256, now + 5)
  return {
    operationId,
    artifactId,
    outputSha256,
    canonicalBodySha256: sha256(validated.normalizedContent),
    canonicalContent: validated.normalizedContent,
    items: validated.items,
  }
}

function commitQaArtifact(
  store: DataStore,
  projectId: string,
  runId: string,
  sourcePath: string,
  canonicalContent: string,
  now: number,
): string {
  const prepared = prepareQaArtifact(store, projectId, runId, sourcePath, canonicalContent, now)
  const committed = store.commitProjectQaArtifact(prepared, now + 6)
  const presetQaId = committed.items[0]?.id
  if (!presetQaId) throw new Error('Fixture QA artifact did not publish an item')
  return presetQaId
}

function commitDocument(
  store: DataStore,
  projectId: string,
  runId: string,
  sourcePath: string,
  content: string,
  now: number,
): { readonly documentId: string; readonly chunkId: string } {
  const rootIdentity = `root:${projectId}`
  const run = store.beginProjectScan({ runId, projectId, rootIdentity, trigger: 'manual', startedAt: now })
  const scan = store.applyProjectScanManifest({
    runId,
    projectId,
    generation: run.generation,
    observations: [observation(sourcePath, content)],
    completedAt: now + 1,
  })
  store.finishProjectSync(runId, 'completed', null, now + 2)
  const sourceId = projectSourceId(
    projectId,
    'document',
    sourcePath.normalize('NFC').toLocaleLowerCase('zh-CN'),
  )
  const pending = scan.pendingRevisions.find((entry) => entry.sourceId === sourceId)
  if (!pending) throw new Error('Missing fixture revision')
  const operationId = `operation-${runId}`
  const artifactId = `artifact-${runId}`
  const output = `---\nqaing_schema: "qaing-converted/v1"\ncontent_kind: "document"\n---\n\n${content}\n`
  const outputSha256 = sha256(output)
  store.prepareConversionJob({
    operationId,
    projectId,
    sourceId,
    revisionId: pending.revisionId,
    generation: run.generation,
    inputSha256: sha256(content),
    tempRelativePath: `转换资料库/资料/${runId}.md.tmp`,
    finalRelativePath: `转换资料库/资料/${runId}.md`,
    conversionMode: 'local',
    converterId: 'test',
    converterVersion: '1',
    artifactSchemaVersion: 1,
    cacheKey: `cache-${runId}`,
  }, now + 3)
  store.stageConversionArtifact({ operationId, artifactId, outputSha256, contentKind: 'document' }, now + 4)
  store.markConversionPublished(operationId, outputSha256, now + 5)
  const committed = store.commitProjectDocumentArtifact({
    operationId,
    artifactId,
    outputSha256,
    canonicalBodySha256: sha256(content),
    document: {
      title: sourcePath,
      kind: 'markdown',
      content,
      chunks: [{ content, tokenCount: Math.min(512, [...content].length) }],
    },
  }, now + 6)
  return {
    documentId: committed.document.id,
    chunkId: store.listChunks(committed.document.id)[0]?.id as string,
  }
}

function createJob(
  store: DataStore,
  projectId: string,
  targetCount: number,
  operationId = `create-${projectId}-${targetCount}`,
  jobId = `job-${projectId}-${targetCount}`,
  acknowledged = false,
) {
  const fence = store.getProjectSimulationFence(projectId)
  return store.createSimulationJob({
    operationId,
    jobId,
    projectId,
    fence,
    targetCount,
    brief: BRIEF,
    ...(acknowledged ? { largeRunAcknowledgedAt: 100 } : {}),
  }, 100)
}

function startJob(store: DataStore, job: ReturnType<typeof createJob>['job']) {
  const queued = store.transitionSimulationJob({
    operationId: `queue-${job.jobId}`,
    projectId: job.projectId,
    jobId: job.jobId,
    expectedStatus: job.status,
    expectedGeneration: job.generation,
    expectedDataRevision: job.dataRevision,
    nextStatus: 'queued',
  }, 101).job
  return store.transitionSimulationJob({
    operationId: `run-${job.jobId}`,
    projectId: job.projectId,
    jobId: job.jobId,
    expectedStatus: 'queued',
    expectedGeneration: queued.generation,
    expectedDataRevision: queued.dataRevision,
    nextStatus: 'running',
  }, 102).job
}

function evidenceFor(
  store: DataStore,
  fence: SimulationProjectFence,
  query: string,
) {
  const hit = store.searchProjectSimulationEvidence({
    projectId: fence.projectId,
    knowledgeVersion: fence.knowledgeVersion,
    sourceManifestHash: fence.sourceManifestHash,
    query,
    limit: 1,
  })[0]
  if (!hit) throw new Error('Fixture evidence was not found')
  return {
    chunkId: hit.chunkId,
    documentId: hit.documentId,
    sourceId: hit.sourceId,
    sourceRevisionId: hit.sourceRevisionId,
    contentHash: hit.contentHash,
    excerpt: hit.excerpt,
  }
}

describe('v9 simulation persistence', () => {
  it('accepts 30, 40, 41, 100 through 10000 without a fifty-item cap and rejects 10001 explicitly', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '预算为一百万元，周期为三个月。', 10)

      expect(createJob(store, 'project-a', 30).job).toMatchObject({ targetCount: 30, status: 'draft' })
      expect(createJob(store, 'project-a', 40).job).toMatchObject({ targetCount: 40, status: 'draft' })
      const awaiting = createJob(store, 'project-a', 41).job
      expect(awaiting).toMatchObject({
        targetCount: 41,
        status: 'awaiting_large_run_confirmation',
      })
      expect(() => store.transitionSimulationJob({
        operationId: 'ack-missing', projectId: 'project-a', jobId: awaiting.jobId,
        expectedStatus: awaiting.status, expectedGeneration: awaiting.generation,
        expectedDataRevision: awaiting.dataRevision, nextStatus: 'draft',
      }, 101)).toThrow(/CONFIRMATION_REQUIRED/)
      expect(store.transitionSimulationJob({
        operationId: 'ack-present', projectId: 'project-a', jobId: awaiting.jobId,
        expectedStatus: awaiting.status, expectedGeneration: awaiting.generation,
        expectedDataRevision: awaiting.dataRevision, nextStatus: 'draft', largeRunAcknowledgedAt: 102,
      }, 102).job).toMatchObject({ status: 'draft', largeRunAcknowledgedAt: 102 })
      expect(createJob(store, 'project-a', 100, 'create-100', 'job-100', true).job).toMatchObject({
        targetCount: 100,
        status: 'draft',
      })
      expect(createJob(store, 'project-a', 101, 'create-101', 'job-101', true).job).toMatchObject({
        targetCount: 101,
        status: 'draft',
      })
      expect(createJob(store, 'project-a', 1_001, 'create-1001', 'job-1001', true).job.targetCount).toBe(1_001)
      expect(createJob(store, 'project-a', 10_000, 'create-10000', 'job-10000', true).job.targetCount).toBe(10_000)
      expect(() => createJob(store, 'project-a', 10_001, 'create-10001', 'job-10001', true)).toThrow(
        /may not exceed 10000/,
      )
      expect(() => createJob(store, 'project-a', 0, 'bad-zero', 'bad-zero')).toThrow(/positive safe integer/)
      expect(() => createJob(store, 'project-a', 1.5, 'bad-fraction', 'bad-fraction')).toThrow(/positive safe integer/)
      const fence = store.getProjectSimulationFence('project-a')
      expect(() => store.createSimulationJob({
        operationId: 'bad-empty-focus', jobId: 'bad-empty-focus', projectId: 'project-a', fence,
        targetCount: 1, brief: { ...BRIEF, focusTopics: [] },
      }, 103)).toThrow(/at least one/)
      expect(() => store.createSimulationJob({
        operationId: 'bad-answer-style', jobId: 'bad-answer-style', projectId: 'project-a', fence,
        targetCount: 1, brief: { ...BRIEF, answerStyle: 'verbose' as never },
      }, 103)).toThrow(/answerStyle/)
    } finally {
      store.close()
    }
  })

  it('isolates project evidence and excludes reviewed QA, legacy data, and simulation drafts', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      store.createProjectManifest(project('project-b'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '甲项目专属预算证据。', 10)
      commitDocument(store, 'project-b', 'run-b', '原始资料/b.md', '乙项目专属预算证据。', 30)
      store.upsertDocument({
        title: '旧资料', kind: 'text', content: '旧全局预算证据', chunks: [{ content: '旧全局预算证据', tokenCount: 8 }],
      }, 50)
      store.upsertPresetQa({ question: '预算多少？', answer: '已审核答案。' }, 51)

      const fenceA = store.getProjectSimulationFence('project-a')
      const projectEvidence = store.searchProjectSimulationEvidence({
        projectId: 'project-a', knowledgeVersion: fenceA.knowledgeVersion, query: '项目专属预算', limit: 20,
      })
      expect(projectEvidence).toHaveLength(1)
      expect(projectEvidence[0]?.excerpt).toBe('甲项目专属预算证据。')
      expect(typeof projectEvidence[0]?.sourceId).toBe('string')
      const created = createJob(store, 'project-a', 1)
      expect(created.job.projectId).toBe('project-a')
      expect(store.searchDocumentKeywords('旧全局预算', 20)).not.toHaveLength(0)
      expect(store.searchProjectSimulationEvidence({
        projectId: 'project-a', knowledgeVersion: fenceA.knowledgeVersion, query: '旧全局预算', limit: 20,
      })).toEqual([])
      expect(store.listPresetQa()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('bounds durable citation excerpts without losing their canonical chunk hash', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      const content = `长资料关键词${'证'.repeat(2_000)}`
      commitDocument(store, 'project-a', 'run-long', '原始资料/long.md', content, 10)
      const fence = store.getProjectSimulationFence('project-a')
      const hit = store.searchProjectSimulationEvidence({
        projectId: 'project-a', knowledgeVersion: fence.knowledgeVersion,
        sourceManifestHash: fence.sourceManifestHash, query: '长资料关键词', limit: 1,
      })[0]
      if (!hit) throw new Error('Long evidence fixture was not found')
      expect([...hit.excerpt]).toHaveLength(1_600)
      expect(hit.contentHash).toBe(sha256(content))
      const running = startJob(store, createJob(store, 'project-a', 1).job)
      expect(() => store.commitSimulationBatch({
        operationId: 'long-evidence-batch', projectId: 'project-a', jobId: running.jobId,
        expectedGeneration: running.generation, expectedDataRevision: running.dataRevision,
        plannedCount: 1,
        items: [{
          question: '长资料的关键信息是什么？', answer: '长资料中有可核验的内容。',
          citations: [{
            chunkId: hit.chunkId,
            documentId: hit.documentId,
            sourceId: hit.sourceId,
            sourceRevisionId: hit.sourceRevisionId,
            contentHash: hit.contentHash,
            excerpt: hit.excerpt,
          }],
        }],
        gaps: [],
      }, 103)).not.toThrow()
    } finally {
      store.close()
    }
  })

  it('commits a complete batch atomically, replays operation IDs, fences stale generations, and recovers restart', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '预算为一百万元，周期为三个月。', 10)
      const fence = store.getProjectSimulationFence('project-a')
      const running = startJob(store, createJob(store, 'project-a', 3).job)
      const citation = evidenceFor(store, fence, '预算为一百万元')
      const input = {
        operationId: 'batch-1',
        projectId: 'project-a',
        jobId: running.jobId,
        expectedGeneration: running.generation,
        expectedDataRevision: running.dataRevision,
        plannedCount: 3,
        items: [{ question: '预算是多少？', answer: '预算为一百万元。', citations: [citation] }],
        gaps: [{
          topic: '实施人员',
          reason: 'INSUFFICIENT_DETAIL' as const,
          missingCount: 2,
          suggestedMaterial: '请补充人员配置资料。',
          checkedSourceCount: fence.sourceCount,
        }],
      }
      const committed = store.commitSimulationBatch(input, 103)
      expect(committed).toMatchObject({ inserted: true, job: { reliableCount: 1, gapCount: 2 } })
      expect(committed.items[0]?.citations[0]).toMatchObject({
        title: '原始资料/a.md',
        contentHash: citation.contentHash,
      })
      expect(store.commitSimulationBatch({ ...input, expectedDataRevision: 999 }, 999)).toMatchObject({ inserted: false })
      expect(() => store.commitSimulationBatch({
        ...input,
        operationId: 'batch-2',
        expectedDataRevision: committed.job.dataRevision,
        expectedGeneration: running.generation + 1,
      }, 104)).toThrow(/CAS/)
      const paused = store.transitionSimulationJob({
        operationId: 'pause', projectId: 'project-a', jobId: running.jobId,
        expectedStatus: 'running', expectedGeneration: running.generation,
        expectedDataRevision: committed.job.dataRevision, nextStatus: 'paused',
      }, 105).job
      const resumed = store.transitionSimulationJob({
        operationId: 'resume', projectId: 'project-a', jobId: running.jobId,
        expectedStatus: 'paused', expectedGeneration: paused.generation,
        expectedDataRevision: paused.dataRevision, nextStatus: 'running',
      }, 106).job
      expect(resumed.generation).toBe(running.generation + 1)
      expect(() => store.commitSimulationBatch({
        ...input, operationId: 'late-batch', expectedGeneration: running.generation,
        expectedDataRevision: resumed.dataRevision,
      }, 107)).toThrow(/CAS/)

      const other = startJob(store, createJob(store, 'project-a', 1, 'create-other', 'job-other').job)
      expect(store.recoverInterruptedSimulationJobs(200)).toEqual(expect.arrayContaining([
        expect.objectContaining({ jobId: running.jobId, status: 'paused', generation: resumed.generation }),
        expect.objectContaining({ jobId: other.jobId, status: 'paused', generation: other.generation }),
      ]))
    } finally {
      store.close()
    }
  })

  it('does not stale an active job when only the background semantic index becomes ready', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '预算为一百万元。', 10)
      const sourceId = projectSourceId(
        'project-a',
        'document',
        '原始资料/a.md'.normalize('NFC').toLocaleLowerCase('zh-CN'),
      )
      const source = store.getProjectSource(sourceId)
      if (!source?.activeRevisionId) throw new Error('Fixture source revision is missing')
      const before = store.getProjectSimulationFence('project-a')
      const pendingJob = createJob(
        store,
        'project-a',
        1,
        'create-index-transition',
        'job-index-transition',
      ).job
      store.markProjectRevisionIndexed({
        projectId: 'project-a', sourceId, revisionId: source.activeRevisionId,
      }, 100)
      const after = store.getProjectSimulationFence('project-a')
      expect(after).toMatchObject({
        projectId: before.projectId,
        knowledgeVersion: before.knowledgeVersion,
        sourceManifestHash: before.sourceManifestHash,
        sourceCount: before.sourceCount,
      })
      expect(after.projectDataRevision).toBeGreaterThan(before.projectDataRevision)

      const running = startJob(store, pendingJob)
      const citation = evidenceFor(store, pendingJob, '预算为一百万元')
      expect(store.commitSimulationBatch({
        operationId: 'batch-after-index-ready', projectId: 'project-a', jobId: running.jobId,
        expectedGeneration: running.generation, expectedDataRevision: running.dataRevision,
        plannedCount: 1,
        items: [{ question: '预算是多少？', answer: '预算为一百万元。', citations: [citation] }],
        gaps: [],
      }, 103)).toMatchObject({ job: { reliableCount: 1 } })

      const contentJob = startJob(store, createJob(
        store,
        'project-a',
        1,
        'create-content-stale',
        'job-content-stale',
      ).job)
      const staleCitation = evidenceFor(store, after, '预算为一百万元')
      commitDocument(store, 'project-a', 'run-new-content', '原始资料/new.md', '新增项目进度资料。', 200)
      expect(() => store.commitSimulationBatch({
        operationId: 'batch-after-content-change', projectId: 'project-a', jobId: contentJob.jobId,
        expectedGeneration: contentJob.generation, expectedDataRevision: contentJob.dataRevision,
        plannedCount: 1,
        items: [{ question: '预算是多少？', answer: '预算为一百万元。', citations: [staleCitation] }],
        gaps: [],
      }, 203)).toThrow(/SIMULATION_KNOWLEDGE_STALE/)
    } finally {
      store.close()
    }
  })

  it('edits a completed item atomically, resets review, and replays an uncertain response', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      store.createProjectManifest(project('project-b'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '预算为一百万元。', 10)
      const fence = store.getProjectSimulationFence('project-a')
      const running = startJob(store, createJob(store, 'project-a', 1).job)
      const citation = evidenceFor(store, fence, '预算为一百万元')
      const committed = store.commitSimulationBatch({
        operationId: 'edit-batch', projectId: 'project-a', jobId: running.jobId,
        expectedGeneration: running.generation, expectedDataRevision: running.dataRevision,
        plannedCount: 1,
        items: [{ question: '预算是多少？', answer: '预算为一百万元。', citations: [citation] }],
        gaps: [],
      }, 103)
      const completed = store.transitionSimulationJob({
        operationId: 'edit-complete', projectId: 'project-a', jobId: running.jobId,
        expectedStatus: 'running', expectedGeneration: running.generation,
        expectedDataRevision: committed.job.dataRevision, nextStatus: 'completed',
      }, 104).job
      const approved = store.reviewSimulationItems({
        operationId: 'edit-approve', projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: completed.dataRevision,
        decisions: [{ itemId: committed.items[0]?.itemId as string, decision: 'approved' }],
      }, 105)
      const updateInput = {
        operationId: 'edit-operation', projectId: 'project-a', jobId: running.jobId,
        itemId: committed.items[0]?.itemId as string,
        expectedDataRevision: approved.job.dataRevision,
        question: '项目核定预算是多少？', answer: '根据项目资料，核定预算为一百万元。',
      }
      const updated = store.updateSimulationItem(updateInput, 106)
      expect(updated).toMatchObject({
        inserted: true,
        job: { approvedCount: 0, dataRevision: approved.job.dataRevision + 1 },
        item: {
          question: '项目核定预算是多少？',
          answer: '根据项目资料，核定预算为一百万元。',
          reviewState: 'draft', reviewedAt: null, editedAt: 106,
        },
      })
      expect(store.updateSimulationItem({ ...updateInput, expectedDataRevision: 9_999 }, 999)).toMatchObject({
        inserted: false,
        item: { editedAt: 106 },
      })
      expect(() => store.updateSimulationItem({
        ...updateInput, answer: '不同内容', expectedDataRevision: updated.job.dataRevision,
      }, 107)).toThrow(/conflicting content/)
      expect(() => store.updateSimulationItem({
        ...updateInput, operationId: 'cross-project-edit', projectId: 'project-b',
        expectedDataRevision: updated.job.dataRevision,
      }, 108)).toThrow(/does not belong/)

      const reapproved = store.reviewSimulationItems({
        operationId: 'edit-reapprove', projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: updated.job.dataRevision,
        decisions: [{ itemId: updateInput.itemId, decision: 'approved' }],
      }, 109)
      const prepared = store.prepareSimulationPublication({
        operationId: 'edit-prepare', projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: reapproved.job.dataRevision, itemIds: [updateInput.itemId],
      }, 110)
      expect(() => store.updateSimulationItem({
        ...updateInput, operationId: 'edit-while-publishing', expectedDataRevision: prepared.job.dataRevision,
      }, 111)).toThrow(/cannot be edited/)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('rolls back a whole invalid batch and rejects semantic operation conflicts', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '预算为一百万元。', 10)
      const fence = store.getProjectSimulationFence('project-a')
      const running = startJob(store, createJob(store, 'project-a', 2).job)
      const citation = evidenceFor(store, fence, '预算为一百万元')
      expect(() => store.commitSimulationBatch({
        operationId: 'bad-batch', projectId: 'project-a', jobId: running.jobId,
        expectedGeneration: running.generation, expectedDataRevision: running.dataRevision,
        plannedCount: 2,
        items: [
          { question: '预算是多少？', answer: '预算为一百万元。', citations: [citation] },
          { question: '错误引用？', answer: '不应保存。', citations: [{ ...citation, contentHash: sha256('tampered') }] },
        ],
        gaps: [],
      }, 200)).toThrow(/canonical chunk/)
      expect(store.getSimulationItemPage({ projectId: 'project-a', jobId: running.jobId }).items).toEqual([])
      expect(store.getSimulationJob('project-a', running.jobId)).toMatchObject({ reliableCount: 0, gapCount: 0 })

      const valid = {
        operationId: 'batch-valid', projectId: 'project-a', jobId: running.jobId,
        expectedGeneration: running.generation, expectedDataRevision: running.dataRevision,
        plannedCount: 2,
        items: [{ question: '预算是多少？', answer: '预算为一百万元。', citations: [citation] }],
        gaps: [{
          topic: '人员', reason: 'NO_RELEVANT_EVIDENCE' as const, missingCount: 1,
          suggestedMaterial: '补充人员资料。', checkedSourceCount: 1,
        }],
      }
      store.commitSimulationBatch(valid, 201)
      expect(() => store.commitSimulationBatch({
        ...valid,
        expectedDataRevision: 999,
        gaps: [{
          topic: '冲突内容', reason: 'NO_RELEVANT_EVIDENCE', missingCount: 1,
          suggestedMaterial: '补充人员资料。', checkedSourceCount: 1,
        }],
      }, 999)).toThrow(/conflicting content/)
    } finally {
      store.close()
    }
  })

  it('keeps fixed cursors project, job, and revision scoped without omissions', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      store.createProjectManifest(project('project-b'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '预算为一百万元。', 10)
      commitDocument(store, 'project-b', 'run-b', '原始资料/b.md', '预算为两百万元。', 30)
      for (let count = 1; count <= 23; count += 1) {
        createJob(store, 'project-a', count, `create-a-${count}`, `job-a-${count}`)
      }
      const first = store.getSimulationJobPage({ projectId: 'project-a', limit: 20 })
      expect(first.items).toHaveLength(20)
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{44}$/u)
      const second = store.getSimulationJobPage({
        projectId: 'project-a', cursor: first.nextCursor, expectedDataRevision: first.dataRevision, limit: 20,
      })
      expect(second.items).toHaveLength(3)
      expect(new Set([...first.items, ...second.items].map((job) => job.jobId)).size).toBe(23)
      expect(store.getLatestSimulationJob('project-a')?.jobId).toBe('job-a-23')
      expect(store.getLatestSimulationJob('project-b')).toBeNull()
      expect(() => store.getSimulationJobPage({ projectId: 'project-b', cursor: first.nextCursor })).toThrow(/STALE/)
      createJob(store, 'project-a', 24, 'create-a-24', 'job-a-24')
      expect(() => store.getSimulationJobPage({ projectId: 'project-a', cursor: first.nextCursor })).toThrow(/STALE/)
    } finally {
      store.close()
    }
  })

  it('pages more than twenty items and gaps with separate fixed scope cursors', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '预算为一百万元。', 10)
      const fence = store.getProjectSimulationFence('project-a')
      const running = startJob(store, createJob(
        store,
        'project-a',
        42,
        'create-paged-results',
        'job-paged-results',
        true,
      ).job)
      const citation = evidenceFor(store, fence, '预算为一百万元')
      const firstBatch = store.commitSimulationBatch({
        operationId: 'paged-batch-one', projectId: 'project-a', jobId: running.jobId,
        expectedGeneration: running.generation, expectedDataRevision: running.dataRevision,
        plannedCount: 40,
        items: Array.from({ length: 21 }, (_, index) => ({
          question: `第${index + 1}个预算问题？`,
          answer: '预算为一百万元。',
          citations: [citation],
        })),
        gaps: Array.from({ length: 19 }, (_, index) => ({
          topic: `缺口${index + 1}`,
          reason: 'NO_RELEVANT_EVIDENCE' as const,
          missingCount: 1,
          suggestedMaterial: `请补充缺口${index + 1}的资料。`,
          checkedSourceCount: 1,
        })),
      }, 103)
      const secondBatch = store.commitSimulationBatch({
        operationId: 'paged-batch-two', projectId: 'project-a', jobId: running.jobId,
        expectedGeneration: running.generation, expectedDataRevision: firstBatch.job.dataRevision,
        plannedCount: 2,
        items: [],
        gaps: Array.from({ length: 2 }, (_, index) => ({
          topic: `缺口${index + 20}`,
          reason: 'INSUFFICIENT_DETAIL' as const,
          missingCount: 1,
          suggestedMaterial: `请补充缺口${index + 20}的细节。`,
          checkedSourceCount: 1,
        })),
      }, 104)
      const itemFirst = store.getSimulationItemPage({
        projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: secondBatch.job.dataRevision, limit: 20,
      })
      const itemSecond = store.getSimulationItemPage({
        projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: secondBatch.job.dataRevision, cursor: itemFirst.nextCursor, limit: 20,
      })
      expect(itemFirst.items).toHaveLength(20)
      expect(itemSecond.items).toHaveLength(1)
      expect(new Set([...itemFirst.items, ...itemSecond.items].map((item) => item.itemId)).size).toBe(21)
      const gapFirst = store.getSimulationGapPage({
        projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: secondBatch.job.dataRevision, limit: 20,
      })
      const gapSecond = store.getSimulationGapPage({
        projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: secondBatch.job.dataRevision, cursor: gapFirst.nextCursor, limit: 20,
      })
      expect(gapFirst.items).toHaveLength(20)
      expect(gapSecond.items).toHaveLength(1)
      expect(new Set([...gapFirst.items, ...gapSecond.items].map((gap) => gap.gapId)).size).toBe(21)
      expect(() => store.getSimulationGapPage({
        projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: secondBatch.job.dataRevision, cursor: itemFirst.nextCursor,
      })).toThrow(/STALE/)
    } finally {
      store.close()
    }
  })

  it('survives a database restart and discovers the newest project-isolated job', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-simulation-v9-'))
    const path = join(directory, 'qaing.sqlite')
    let store = new DataStore(path)
    try {
      store.createProjectManifest(project('project-a'), 1)
      store.createProjectManifest(project('project-b'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '预算为一百万元。', 10)
      commitDocument(store, 'project-b', 'run-b', '原始资料/b.md', '预算为两百万元。', 30)
      const older = store.createSimulationJob({
        operationId: 'restart-create-old', jobId: 'restart-old', projectId: 'project-a',
        fence: store.getProjectSimulationFence('project-a'), targetCount: 1, brief: BRIEF,
      }, 100).job
      const newer = store.createSimulationJob({
        operationId: 'restart-create-new', jobId: 'restart-new', projectId: 'project-a',
        fence: store.getProjectSimulationFence('project-a'), targetCount: 1, brief: BRIEF,
      }, 101).job
      createJob(store, 'project-b', 1, 'restart-create-b', 'restart-b')
      expect(older.createdAt).toBe(100)
      expect(newer.createdAt).toBe(101)
      store.close()

      store = new DataStore(path)
      expect(store.getLatestSimulationJob('project-a')).toMatchObject({ jobId: 'restart-new', projectId: 'project-a' })
      expect(store.getLatestSimulationJob('project-b')).toMatchObject({ jobId: 'restart-b', projectId: 'project-b' })
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('invalidates stale knowledge, keeps drafts out of preset retrieval, and scope-binds pagination', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      store.createProjectManifest(project('project-b'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '预算为一百万元。', 10)
      commitDocument(store, 'project-b', 'run-b', '原始资料/b.md', '预算为两百万元。', 30)
      const fence = store.getProjectSimulationFence('project-a')
      const running = startJob(store, createJob(store, 'project-a', 1).job)
      const citation = evidenceFor(store, fence, '预算为一百万元')
      const committed = store.commitSimulationBatch({
        operationId: 'batch-a', projectId: 'project-a', jobId: running.jobId,
        expectedGeneration: running.generation, expectedDataRevision: running.dataRevision,
        plannedCount: 1,
        items: [{ question: '预算是多少？', answer: '预算为一百万元。', citations: [citation] }],
        gaps: [],
      }, 100)
      const completed = store.transitionSimulationJob({
        operationId: 'complete-a', projectId: 'project-a', jobId: running.jobId,
        expectedStatus: 'running', expectedGeneration: running.generation,
        expectedDataRevision: committed.job.dataRevision, nextStatus: 'completed',
      }, 101).job
      expect(store.listPresetQa()).toEqual([])
      expect(store.findExactPresetQa('预算是多少？')).toEqual([])
      const reviewed = store.reviewSimulationItems({
        operationId: 'review-a', projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: completed.dataRevision,
        decisions: [{ itemId: committed.items[0]?.itemId as string, decision: 'approved' }],
      }, 102)
      const prepared = store.prepareSimulationPublication({
        operationId: 'publish-a', projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: reviewed.job.dataRevision,
        itemIds: [committed.items[0]?.itemId as string],
      }, 103)
      expect(prepared.canonicalMarkdown).toContain('## 问题：预算是多少？')
      expect(store.listPresetQa()).toEqual([])

      const itemPage = store.getSimulationItemPage({ projectId: 'project-a', jobId: running.jobId, limit: 1 })
      expect(() => store.getSimulationItemPage({
        projectId: 'project-b', jobId: running.jobId, cursor: itemPage.nextCursor,
      })).toThrow(/does not belong/)

      commitDocument(store, 'project-a', 'run-a-2', '原始资料/new.md', '新的预算补充资料。', 300)
      expect(() => store.searchProjectSimulationEvidence({
        projectId: 'project-a', knowledgeVersion: fence.knowledgeVersion,
        sourceManifestHash: fence.sourceManifestHash, query: '预算',
      })).toThrow(/STALE/)
      expect(() => store.cancelSimulationPublication({
        operationId: 'cancel-a', projectId: 'project-a', jobId: running.jobId,
        publicationId: prepared.publication.publicationId,
        expectedDataRevision: prepared.job.dataRevision,
      }, 301)).not.toThrow()
    } finally {
      store.close()
    }
  })

  it('publishes approved drafts through the strict project QA artifact path and completes idempotently', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      store.createProjectManifest(project('project-b'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '预算为一百万元。', 10)
      const fence = store.getProjectSimulationFence('project-a')
      const running = startJob(store, createJob(store, 'project-a', 1).job)
      const committed = store.commitSimulationBatch({
        operationId: 'publish-batch', projectId: 'project-a', jobId: running.jobId,
        expectedGeneration: running.generation, expectedDataRevision: running.dataRevision,
        plannedCount: 1,
        items: [{
          question: '预算是多少？', answer: '预算为一百万元。',
          citations: [evidenceFor(store, fence, '预算为一百万元')],
        }],
        gaps: [],
      }, 100)
      const completed = store.transitionSimulationJob({
        operationId: 'publish-complete-job', projectId: 'project-a', jobId: running.jobId,
        expectedStatus: 'running', expectedGeneration: running.generation,
        expectedDataRevision: committed.job.dataRevision, nextStatus: 'completed',
      }, 101).job
      const itemId = committed.items[0]?.itemId as string
      const reviewed = store.reviewSimulationItems({
        operationId: 'publish-review', projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: completed.dataRevision,
        decisions: [{ itemId, decision: 'approved' }],
      }, 102)
      const prepared = store.prepareSimulationPublication({
        operationId: 'publish-prepare', projectId: 'project-a', jobId: running.jobId,
        expectedDataRevision: reviewed.job.dataRevision, itemIds: [itemId],
      }, 103)
      expect(prepared.items).toEqual([
        expect.objectContaining({ itemId, question: '预算是多少？', answer: '预算为一百万元。' }),
      ])
      expect(store.listPresetQa()).toEqual([])
      commitQaArtifact(
        store,
        'project-b',
        'run-published-qa-b',
        '预设QA/其他项目.md',
        prepared.canonicalMarkdown,
        180,
      )
      expect(() => store.resolveSimulationPublicationMappings({
        projectId: 'project-a',
        items: prepared.items.map((item) => ({
          itemId: item.itemId, question: item.question, answer: item.answer,
        })),
      })).toThrow(/does not exactly match/)
      const publicationQa = prepareQaArtifact(
        store,
        'project-a',
        'run-published-qa',
        '预设QA/模拟问答-已审核.md',
        prepared.canonicalMarkdown,
        200,
      )
      const beforePublicationCommit = store.getProject('project-a')
      store.createSession({
        id: 'simulation-publication-session',
        projectId: 'project-a',
        mode: 'qa',
        audioSource: 'microphone',
        startedAt: 206,
      })
      expect(() => store.commitProjectQaArtifact(publicationQa, 207)).toThrow(/PROJECT_SESSION_ACTIVE/)
      expect(store.listProjectQaLinks('project-a')).toEqual([])
      expect(store.listPresetQa()).toHaveLength(1)
      expect(store.getProject('project-a')).toEqual(beforePublicationCommit)
      expect(store.getConversionJob(publicationQa.operationId)?.state).toBe('published_fs')
      expect(store.prepareSimulationPublication({
        operationId: 'publish-prepare',
        projectId: 'project-a',
        jobId: running.jobId,
        expectedDataRevision: 0,
        itemIds: [itemId],
      }, 999)).toMatchObject({
        inserted: false,
        publication: { status: 'prepared' },
        items: [{ itemId, reviewState: 'publishing' }],
      })
      store.endSession('simulation-publication-session', 'complete', 208)
      const committedQa = store.commitProjectQaArtifact(publicationQa, 209)
      const presetQaId = committedQa.items[0]?.id as string
      const completeInput = {
        operationId: 'publish-link', projectId: 'project-a', jobId: running.jobId,
        publicationId: prepared.publication.publicationId,
        expectedDataRevision: prepared.job.dataRevision,
        mappings: store.resolveSimulationPublicationMappings({
          projectId: 'project-a',
          items: prepared.items.map((item) => ({
            itemId: item.itemId,
            question: item.question,
            answer: item.answer,
          })),
        }),
      }
      expect(completeInput.mappings).toEqual([{ itemId, presetQaId }])
      expect(() => store.resolveSimulationPublicationMappings({
        projectId: 'project-a',
        items: [{ itemId, question: '预算是多少？', answer: '改动过的答案。' }],
      })).toThrow(/does not match/)
      const published = store.completeSimulationPublication(completeInput, 210)
      expect(published).toMatchObject({
        inserted: true,
        job: { publishedCount: 1 },
        publication: { status: 'completed', presetQaIds: [presetQaId] },
        items: [{ reviewState: 'published', publishedAt: 210 }],
      })
      expect(store.completeSimulationPublication({ ...completeInput, expectedDataRevision: 0 }, 999)).toMatchObject({
        inserted: false,
        publication: { status: 'completed' },
      })
      store.setActiveProject('project-a')
      expect(store.findExactPresetQa('预算是多少？')).toEqual([
        expect.objectContaining({ id: presetQaId, answer: '预算为一百万元。' }),
      ])
      expect(store.getProjectStatusSummary('project-a')).toMatchObject({
        usableDocumentSources: 1,
        usablePresetQaSources: 1,
        usablePresetQaItems: 1,
      })
      expect(() => store.updateSimulationItem({
        operationId: 'edit-published', projectId: 'project-a', jobId: running.jobId, itemId,
        expectedDataRevision: published.job.dataRevision,
        question: '新问题？', answer: '新答案。',
      }, 211)).toThrow(/cannot be edited/)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('reports usable and action-required project counts without treating background embedding as attention', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      commitDocument(store, 'project-a', 'run-a', '原始资料/a.md', '预算资料。', 10)
      const blockedRun = store.beginProjectScan({
        runId: 'run-blocked', projectId: 'project-a', rootIdentity: 'root:project-a', trigger: 'manual', startedAt: 30,
      })
      store.applyProjectScanManifest({
        runId: blockedRun.runId,
        projectId: 'project-a',
        generation: blockedRun.generation,
        observations: [
          observation('原始资料/a.md', '预算资料。'),
          {
            ...observation('原始资料/附件.pdf', 'pdf'), detectedType: 'pdf',
            conversionDisposition: 'external', blockedReason: 'INPUT_UNSUPPORTED',
          },
        ],
        completedAt: 31,
      })
      store.finishProjectSync(blockedRun.runId, 'completed_with_errors', null, 32)
      expect(store.getProjectStatusSummary('project-a')).toMatchObject({
        usableDocumentSources: 1,
        usablePresetQaSources: 0,
        usablePresetQaItems: 0,
        pendingEmbedding: 1,
        attention: 1,
        actionRequiredSources: 1,
      })
    } finally {
      store.close()
    }
  })
})
