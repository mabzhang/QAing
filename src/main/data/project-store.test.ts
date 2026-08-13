import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DataStore } from './database'
import { sha256 } from './hash'
import { validateCanonicalArtifact } from './importers'
import { HybridRetriever } from './retrieval'
import { latestSchemaVersion } from './migrations'
import { TestOnlyDeterministicEmbeddingProvider } from './testing'
import type {
  ProjectScanApplyResult,
  ProjectScanObservation,
  ProjectTrustKind,
} from './types'
import { EmbeddingIndexer, InMemoryExactVectorIndex, embedTexts } from './vector'
import { projectSourceId } from '../project/planner'

const PROJECT_A = {
  id: 'project-a',
  displayName: '项目 A',
  rootPath: '/tmp/qaing-project-a',
  rootIdentity: 'volume-a:root-a',
  schemaVersion: 1,
} as const

function observation(
  path: string,
  raw: string,
  trustKind: ProjectTrustKind = 'document',
): ProjectScanObservation {
  return {
    trustKind,
    displayRelativePath: path,
    pathKey: path.normalize('NFC').toLocaleLowerCase('zh-CN'),
    sizeBytes: Buffer.byteLength(raw),
    mtimeNs: '1234567890123456789',
    deviceId: 'dev-1',
    inode: `inode-${path}`,
    rawSha256: sha256(raw),
    detectedType: trustKind === 'document' ? 'text/markdown' : 'text/markdown+qa',
  }
}

function scan(
  store: DataStore,
  projectId: string,
  rootIdentity: string,
  runId: string,
  observations: readonly ProjectScanObservation[],
  now: number,
): ProjectScanApplyResult {
  const run = store.beginProjectScan({ runId, projectId, rootIdentity, trigger: 'manual', startedAt: now })
  const result = store.applyProjectScanManifest({
    runId,
    projectId,
    generation: run.generation,
    observations,
    completedAt: now + 1,
  })
  store.finishProjectSync(runId, result.counts.failed > 0 ? 'completed_with_errors' : 'completed', null, now + 2)
  return result
}

function prepareAndPublish(
  store: DataStore,
  projectId: string,
  scanResult: ProjectScanApplyResult,
  sourceId: string,
  content: string,
  trustKind: ProjectTrustKind,
  suffix: string,
  now: number,
): {
  readonly operationId: string
  readonly artifactId: string
  readonly outputSha256: string
  readonly canonicalBodySha256: string
} {
  const pending = scanResult.pendingRevisions.find((entry) => entry.sourceId === sourceId)
  if (!pending) throw new Error('Fixture is missing a pending revision')
  const source = store.getProjectSource(sourceId)
  if (!source?.observedRawSha256) throw new Error('Fixture is missing a source hash')
  const operationId = `operation-${suffix}`
  const artifactId = `artifact-${suffix}`
  const canonicalBody = content.normalize('NFC').replace(/\r\n?/gu, '\n').replace(/[\t ]+$/gmu, '').trim()
  const fullArtifact = `---\nqaing_schema: "qaing-converted/v1"\ncontent_kind: "${trustKind}"\n---\n\n${canonicalBody}\n`
  const outputSha256 = sha256(fullArtifact)
  const canonicalBodySha256 = sha256(canonicalBody)
  const outputRoot = trustKind === 'document' ? '转换资料库/资料' : '转换资料库/预设QA'
  store.prepareConversionJob({
    operationId,
    projectId,
    sourceId,
    revisionId: pending.revisionId,
    generation: scanResult.run.generation,
    inputSha256: source.observedRawSha256,
    tempRelativePath: `${outputRoot}/${suffix}.md.tmp`,
    finalRelativePath: `${outputRoot}/${suffix}.md`,
    conversionMode: 'local',
    converterId: 'qaing/text',
    converterVersion: '1',
    artifactSchemaVersion: 1,
    cacheKey: `cache-${suffix}`,
  }, now)
  store.stageConversionArtifact({
    operationId,
    artifactId,
    outputSha256,
    contentKind: trustKind,
  }, now + 1)
  store.markConversionPublished(operationId, outputSha256, now + 2)
  return { operationId, artifactId, outputSha256, canonicalBodySha256 }
}

function commitDocument(
  store: DataStore,
  projectId: string,
  scanResult: ProjectScanApplyResult,
  sourceId: string,
  content: string,
  suffix: string,
  now: number,
): string {
  const saga = prepareAndPublish(store, projectId, scanResult, sourceId, content, 'document', suffix, now)
  return store.commitProjectDocumentArtifact({
    ...saga,
    document: {
      title: suffix,
      kind: 'markdown',
      content,
      chunks: [{ content, tokenCount: Math.min(512, [...content].length) }],
    },
  }, now + 3).document.id
}

function commitQa(
  store: DataStore,
  projectId: string,
  scanResult: ProjectScanApplyResult,
  sourceId: string,
  canonicalContent: string,
  suffix: string,
  now: number,
): string {
  const validated = validateCanonicalArtifact({ trustKind: 'preset_qa', canonicalContent })
  const saga = prepareAndPublish(
    store,
    projectId,
    scanResult,
    sourceId,
    validated.normalizedContent,
    'preset_qa',
    suffix,
    now,
  )
  return store.commitProjectQaArtifact({
    ...saga,
    canonicalContent: validated.normalizedContent,
    items: validated.items,
  }, now + 3).items[0]?.id as string
}

describe('project manifest migration and scan generations', () => {
  it('persists an idempotent active manifest without exposing stale project identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-project-v6-'))
    const path = join(directory, 'qaing.sqlite')
    let store = new DataStore(path)
    try {
      expect(store.schemaVersion()).toBe(latestSchemaVersion)
      expect(store.createProjectManifest(PROJECT_A, 1)).toEqual(expect.objectContaining({
        id: PROJECT_A.id,
        scanGeneration: 0,
        knowledgeVersion: 0,
        availability: 'available',
      }))
      expect(store.createProjectManifest(PROJECT_A, 2).createdAt).toBe(1)
      expect(() => store.createProjectManifest({ ...PROJECT_A, rootIdentity: 'different' }, 3)).toThrow(/conflicts/)
      store.setActiveProject(PROJECT_A.id)
      store.close()

      store = new DataStore(path)
      expect(store.getActiveProjectId()).toBe(PROJECT_A.id)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('records deterministic revisions, unique renames, ambiguity, and two-scan tombstones', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(PROJECT_A, 1)
      const first = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'run-1', [
        observation('原始资料/甲.md', 'raw-a'),
        observation('原始资料/乙.md', 'raw-b'),
        {
          ...observation('原始资料/附件.pdf', 'pdf-raw'),
          detectedType: 'pdf',
          conversionDisposition: 'external',
          blockedReason: 'INPUT_UNSUPPORTED',
        },
      ], 10)
      expect(first.counts).toMatchObject({ added: 2, changed: 0, renamed: 0, blocked: 1 })
      expect(first.pendingRevisions).toHaveLength(2)
      expect(first.addedSourceIds[0]).toBe(projectSourceId(
        PROJECT_A.id,
        'document',
        '原始资料/甲.md'.normalize('NFC').toLocaleLowerCase('zh-CN'),
      ))
      expect(store.listProjectManifestEntries(PROJECT_A.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          relativePath: '原始资料/附件.pdf',
          rawSha256: sha256('pdf-raw'),
          conversionDisposition: 'external',
          state: 'blocked',
        }),
      ]))

      const second = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'run-2', [
        observation('原始资料/甲重命名.md', 'raw-a'),
        observation('原始资料/乙.md', 'raw-b-updated'),
        {
          ...observation('原始资料/附件.pdf', 'pdf-raw'),
          detectedType: 'pdf',
          conversionDisposition: 'external',
          blockedReason: 'INPUT_UNSUPPORTED',
        },
      ], 20)
      expect(second.counts).toMatchObject({ renamed: 0, changed: 1 })
      expect(second.pendingRenames).toHaveLength(1)
      expect(second.pendingRevisions).toHaveLength(1)
      const applied = store.applyProjectIncrementalPlan({
        projectId: PROJECT_A.id,
        runId: second.run.runId,
        generation: second.run.generation,
        renames: second.pendingRenames,
        tombstoneSourceIds: [],
        appliedAt: 23,
      })
      expect(applied.renamedSourceIds).toHaveLength(1)
      expect(store.getProjectSyncRun(second.run.runId)?.counts.renamed).toBe(1)
      const renamed = store.getProjectSource(applied.renamedSourceIds[0] as string)
      expect(renamed?.displayRelativePath).toBe('原始资料/甲重命名.md')

      const third = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'run-3', [], 30)
      expect(third.counts.missingGrace).toBe(3)
      expect(store.listProjectDocumentLinks(PROJECT_A.id)).toEqual([])
      const fourth = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'run-4', [], 40)
      expect(fourth.counts.tombstoned).toBe(0)
      expect(fourth.pendingTombstoneSourceIds).toHaveLength(3)
      store.applyProjectIncrementalPlan({
        projectId: PROJECT_A.id,
        runId: fourth.run.runId,
        generation: fourth.run.generation,
        renames: [],
        tombstoneSourceIds: fourth.pendingTombstoneSourceIds,
        appliedAt: 43,
      })
      expect(store.getProjectSyncRun(fourth.run.runId)?.counts.tombstoned).toBe(3)
      expect(store.getProjectSourcePage({ projectId: PROJECT_A.id }).items.every((item) => item.state === 'tombstoned')).toBe(true)

      const ambiguousSeed = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'run-5', [
        observation('原始资料/旧一.md', 'same'),
        observation('原始资料/旧二.md', 'same'),
      ], 50)
      expect(ambiguousSeed.counts.added).toBe(2)
      const ambiguous = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'run-6', [
        observation('原始资料/新一.md', 'same'),
        observation('原始资料/新二.md', 'same'),
      ], 60)
      expect(ambiguous.counts).toMatchObject({ renamed: 0, blocked: 2 })
      expect(store.getProjectSourcePage({ projectId: PROJECT_A.id, filter: 'attention' }).items)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ errorCode: 'RENAME_AMBIGUOUS' }),
        ]))
    } finally {
      store.close()
    }
  })

  it('persists final sync counts, accepts an identical retry, and rejects a conflicting replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-project-final-counts-'))
    const path = join(directory, 'qaing.sqlite')
    let store = new DataStore(path)
    try {
      store.createProjectManifest(PROJECT_A, 1)
      const run = store.beginProjectScan({
        runId: 'final-counts-run',
        projectId: PROJECT_A.id,
        rootIdentity: PROJECT_A.rootIdentity,
        trigger: 'manual',
        startedAt: 2,
      })
      store.applyProjectScanManifest({
        runId: run.runId,
        projectId: PROJECT_A.id,
        generation: run.generation,
        observations: [observation('原始资料/统计.md', 'counts')],
        completedAt: 3,
      })
      const finalCounts = {
        converted: 1,
        manualReady: 1,
        blocked: 2,
        failed: 1,
      } as const
      const finished = store.finishProjectSync(
        run.runId,
        'completed_with_errors',
        null,
        4,
        finalCounts,
      )
      expect(finished.counts).toMatchObject({
        discovered: 1,
        added: 1,
        converted: 1,
        manualReady: 1,
        blocked: 2,
        failed: 1,
      })
      expect(store.finishProjectSync(
        run.runId,
        'completed_with_errors',
        null,
        5,
        finalCounts,
      ).counts).toEqual(finished.counts)
      expect(() => store.finishProjectSync(
        run.runId,
        'completed_with_errors',
        null,
        6,
        { failed: 2 },
      )).toThrow(/final counts conflict/)
      store.close()

      store = new DataStore(path)
      expect(store.getProjectSyncRun(run.runId)?.counts).toEqual(finished.counts)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('pages a bounded manifest without omissions and recovers an interrupted scan after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-project-recovery-'))
    const path = join(directory, 'qaing.sqlite')
    let store = new DataStore(path)
    try {
      store.createProjectManifest(PROJECT_A, 1)
      const observations = Array.from({ length: 125 }, (_, index) => (
        observation(`原始资料/分页-${String(index).padStart(2, '0')}.md`, `raw-${String(index)}`)
      ))
      const run = store.beginProjectScan({
        runId: 'paging-run',
        projectId: PROJECT_A.id,
        rootIdentity: PROJECT_A.rootIdentity,
        trigger: 'manual',
        startedAt: 2,
      })
      const applied = store.applyProjectScanManifest({
        runId: run.runId,
        projectId: PROJECT_A.id,
        generation: run.generation,
        observations,
        completedAt: 3,
      })
      expect(store.getProjectStatusSummary(PROJECT_A.id)).toMatchObject({
        totalFiles: 125,
        needsConversion: 125,
        attention: 0,
        actionRequiredSources: 0,
        hasUsableKnowledge: false,
      })
      const sourceIds: string[] = []
      let cursor: string | null = null
      do {
        const page = store.getProjectSourcePage({ projectId: PROJECT_A.id, cursor, limit: 20 })
        expect(page.items.length).toBeLessThanOrEqual(20)
        sourceIds.push(...page.items.map((item) => item.sourceId))
        cursor = page.nextCursor
      } while (cursor !== null)
      expect(sourceIds).toHaveLength(125)
      expect(new Set(sourceIds).size).toBe(125)
      expect(store.listProjectManifestEntries(PROJECT_A.id)).toHaveLength(125)
      expect(() => store.getProjectSourcePage({ projectId: PROJECT_A.id, cursor: 'bad' })).toThrow(/cursor/)
      for (const [index, pending] of applied.pendingRevisions.entries()) {
        const source = store.getProjectSource(pending.sourceId)
        store.prepareConversionJob({
          operationId: `recovery-operation-${String(index)}`,
          projectId: PROJECT_A.id,
          sourceId: pending.sourceId,
          revisionId: pending.revisionId,
          generation: run.generation,
          inputSha256: source?.observedRawSha256 as string,
          tempRelativePath: `转换资料库/资料/recovery-${String(index)}.md.tmp`,
          finalRelativePath: `转换资料库/资料/recovery-${String(index)}.md`,
          conversionMode: 'local',
          converterId: 'qaing/text',
          converterVersion: '1',
          artifactSchemaVersion: 1,
          cacheKey: `recovery-cache-${String(index)}`,
        }, 3)
      }
      expect(store.listProjectRecoveryWork({ projectId: PROJECT_A.id })).toHaveLength(125)
      store.close()

      store = new DataStore(path)
      expect(store.getProjectSyncRun(run.runId)?.state).toBe('processing')
      expect(store.listProjectRecoveryWork({ projectId: PROJECT_A.id })).toHaveLength(125)
      expect(store.recoverInterruptedProjectRuns(4)).toEqual([
        expect.objectContaining({ runId: run.runId, state: 'failed', errorCode: 'SYNC_INTERRUPTED' }),
      ])
      expect(store.recoverInterruptedProjectRuns(5)).toEqual([])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('project conversion saga and last-good knowledge', () => {
  it('fail-closes canonical Markdown with executable, remote, or absolute resources', () => {
    expect(() => validateCanonicalArtifact({
      trustKind: 'document',
      canonicalContent: '# 安全资料\n\n<object data="payload"></object>',
    })).toThrow(/forbidden/)
    expect(() => validateCanonicalArtifact({
      trustKind: 'document',
      canonicalContent: '# 安全资料\n\n[远程](https://example.invalid)',
    })).toThrow(/forbidden/)
    expect(() => validateCanonicalArtifact({
      trustKind: 'document',
      canonicalContent: '# 安全资料\n\n/Users/example/private.txt',
    })).toThrow(/forbidden/)
    expect(() => validateCanonicalArtifact({
      trustKind: 'document',
      canonicalContent: '已审核手动资料\n\n<svg onload=alert(1)>',
      validationProfile: 'manual',
    })).toThrow(/forbidden/)
    expect(() => validateCanonicalArtifact({
      trustKind: 'document',
      canonicalContent: '已审核手动资料\n\n[escape](../outside.txt)',
      validationProfile: 'manual',
    })).toThrow(/forbidden/)
    expect(() => validateCanonicalArtifact({
      trustKind: 'document',
      canonicalContent: '无标题的已审核手动资料',
    })).toThrow(/exactly one H1/)
    expect(validateCanonicalArtifact({
      trustKind: 'document',
      canonicalContent: '无标题的已审核手动资料',
      validationProfile: 'manual',
    })).toMatchObject({ normalizedContent: '无标题的已审核手动资料' })
  })

  it('publishes a document atomically, replays every state, and preserves last-good after failure', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(PROJECT_A, 1)
      const first = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'saga-run-1', [
        observation('原始资料/产品.md', 'raw-v1'),
      ], 100)
      const sourceId = first.addedSourceIds[0] as string
      const content = '# 产品资料\n\n稳定版本内容。'
      const documentId = commitDocument(store, PROJECT_A.id, first, sourceId, content, 'product-v1', 110)
      const committedArtifact = store.getConversionArtifact('artifact-product-v1')
      expect(committedArtifact?.outputSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(committedArtifact?.canonicalBodySha256).toBe(sha256(content))
      expect(committedArtifact?.outputSha256).not.toBe(committedArtifact?.canonicalBodySha256)
      expect(store.getProjectSource(sourceId)).toMatchObject({
        state: 'embedding_pending',
        activeRevisionId: first.pendingRevisions[0]?.revisionId,
        lastGoodRevisionId: first.pendingRevisions[0]?.revisionId,
      })
      expect(store.listProjectDocumentLinks(PROJECT_A.id)).toEqual([
        expect.objectContaining({ documentId, active: true }),
      ])
      expect(store.getProject(PROJECT_A.id)?.knowledgeVersion).toBe(1)
      store.markProjectRevisionIndexed({
        projectId: PROJECT_A.id,
        sourceId,
        revisionId: first.pendingRevisions[0]?.revisionId as string,
      }, 120)
      const rebuildRun = store.beginProjectScan({
        runId: 'saga-output-rebuild',
        projectId: PROJECT_A.id,
        rootIdentity: PROJECT_A.rootIdentity,
        trigger: 'manual',
        startedAt: 121,
      })
      store.applyProjectScanManifest({
        runId: rebuildRun.runId,
        projectId: PROJECT_A.id,
        generation: rebuildRun.generation,
        observations: [observation('原始资料/产品.md', 'raw-v1')],
        completedAt: 122,
      })
      expect(store.findProjectSourceRevision({
        sourceId,
        generation: rebuildRun.generation,
        rawSha256: sha256('raw-v1'),
      })).toBeNull()
      const rebuiltRevision = store.ensureProjectSourceRevision({
        sourceId,
        generation: rebuildRun.generation,
        rawSha256: sha256('raw-v1'),
        sizeBytes: Buffer.byteLength('raw-v1'),
        detectedType: 'text/markdown',
      }, 123)
      expect(store.ensureProjectSourceRevision({
        sourceId,
        generation: rebuildRun.generation,
        rawSha256: sha256('raw-v1'),
        sizeBytes: Buffer.byteLength('raw-v1'),
        detectedType: 'text/markdown',
      }, 999)).toEqual(rebuiltRevision)
      expect(store.getProjectSource(sourceId)).toMatchObject({
        state: 'needs_conversion',
        lastGoodRevisionId: first.pendingRevisions[0]?.revisionId,
      })
      store.finishProjectSync(rebuildRun.runId, 'completed', null, 124)

      const second = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'saga-run-2', [
        observation('原始资料/产品.md', 'raw-v2'),
      ], 130)
      const pending = second.pendingRevisions[0] as { sourceId: string; revisionId: string }
      const job = store.prepareConversionJob({
        operationId: 'operation-failure',
        projectId: PROJECT_A.id,
        sourceId,
        revisionId: pending.revisionId,
        generation: second.run.generation,
        inputSha256: store.getProjectSource(sourceId)?.observedRawSha256 as string,
        tempRelativePath: '转换资料库/资料/failure.md.tmp',
        finalRelativePath: '转换资料库/资料/failure.md',
        conversionMode: 'local',
        converterId: 'qaing/text',
        converterVersion: '1',
        artifactSchemaVersion: 1,
        cacheKey: 'failure-cache',
      }, 140)
      expect(store.prepareConversionJob({
        operationId: 'operation-failure',
        projectId: PROJECT_A.id,
        sourceId,
        revisionId: pending.revisionId,
        generation: second.run.generation,
        inputSha256: job.inputSha256,
        tempRelativePath: '转换资料库/资料/failure.md.tmp',
        finalRelativePath: '转换资料库/资料/failure.md',
        conversionMode: 'local',
        converterId: 'qaing/text',
        converterVersion: '1',
        artifactSchemaVersion: 1,
        cacheKey: 'failure-cache',
      }, 999)).toEqual(job)
      store.failConversionJob(job.operationId, 'CONVERTER_CRASHED', 141)
      expect(store.getProjectSource(sourceId)).toMatchObject({
        state: 'conversion_failed',
        lastGoodRevisionId: first.pendingRevisions[0]?.revisionId,
      })
      expect(store.listProjectDocumentLinks(PROJECT_A.id)).toEqual([
        expect.objectContaining({ documentId, active: true }),
      ])
      expect(store.retryConversionJob(job.operationId, 142)).toMatchObject({ state: 'prepared', attempt: 1 })
      expect(store.listProjectRecoveryWork({ projectId: PROJECT_A.id })).toEqual([
        expect.objectContaining({ operationId: job.operationId, state: 'prepared' }),
      ])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('rejects mismatched QA canonical content and rolls back project conflicts as a whole', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(PROJECT_A, 1)
      const firstMarkdown = '## 问题：交付周期？\n### 答案\n十天。'
      const secondMarkdown = '## 问题：交付周期？\n### 答案\n二十天。'
      const result = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'qa-run', [
        observation('预设QA/审核一.md', 'qa-raw-1', 'preset_qa'),
        observation('预设QA/审核二.md', 'qa-raw-2', 'preset_qa'),
      ], 200)
      const firstSource = result.addedSourceIds[0] as string
      const secondSource = result.addedSourceIds[1] as string
      const firstQaId = commitQa(store, PROJECT_A.id, result, firstSource, firstMarkdown, 'qa-one', 210)
      const validated = validateCanonicalArtifact({ trustKind: 'preset_qa', canonicalContent: secondMarkdown })
      const saga = prepareAndPublish(
        store, PROJECT_A.id, result, secondSource, validated.normalizedContent, 'preset_qa', 'qa-two', 220,
      )
      expect(() => store.commitProjectQaArtifact({
        ...saga,
        outputSha256: sha256(validated.normalizedContent),
        canonicalContent: validated.normalizedContent,
        items: validated.items,
      }, 222)).toThrow(/output hash/)
      expect(() => store.commitProjectQaArtifact({
        ...saga,
        canonicalContent: validated.normalizedContent,
        items: validated.items,
      }, 223)).toThrow(/conflicts/)
      expect(store.listProjectQaLinks(PROJECT_A.id)).toEqual([
        expect.objectContaining({ presetQaId: firstQaId, active: true }),
      ])
      expect(store.getConversionJob(saga.operationId)?.state).toBe('published_fs')
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('serializes document and QA publication with project sessions and keeps published work recoverable', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(PROJECT_A, 1)
      const qaMarkdown = '## 问题：并发门禁是否生效？\n### 答案\n只在会话结束后发布。'
      const validatedQa = validateCanonicalArtifact({ trustKind: 'preset_qa', canonicalContent: qaMarkdown })
      const scanned = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'guard-run', [
        observation('原始资料/待提交.md', 'raw-document'),
        observation('预设QA/待提交.md', 'raw-qa', 'preset_qa'),
      ], 300)
      const documentContent = '# 待提交资料\n\n事务门禁测试。'
      const documentSaga = prepareAndPublish(
        store,
        PROJECT_A.id,
        scanned,
        scanned.addedSourceIds[0] as string,
        documentContent,
        'document',
        'guard-document',
        310,
      )
      const qaSaga = prepareAndPublish(
        store,
        PROJECT_A.id,
        scanned,
        scanned.addedSourceIds[1] as string,
        validatedQa.normalizedContent,
        'preset_qa',
        'guard-qa',
        320,
      )
      const beforeSession = store.getProject(PROJECT_A.id)
      store.createSession({
        id: 'guard-session-first',
        projectId: PROJECT_A.id,
        mode: 'qa',
        audioSource: 'microphone',
        startedAt: 330,
      })

      expect(() => store.commitProjectDocumentArtifact({
        ...documentSaga,
        document: {
          title: '待提交资料',
          kind: 'markdown',
          content: documentContent,
          chunks: [{ content: documentContent, tokenCount: 20 }],
        },
      }, 331)).toThrow(/PROJECT_SESSION_ACTIVE/)
      expect(() => store.commitProjectQaArtifact({
        ...qaSaga,
        canonicalContent: validatedQa.normalizedContent,
        items: validatedQa.items,
      }, 332)).toThrow(/PROJECT_SESSION_ACTIVE/)
      expect(store.listDocuments()).toEqual([])
      expect(store.listPresetQa()).toEqual([])
      expect(store.listProjectDocumentLinks(PROJECT_A.id)).toEqual([])
      expect(store.listProjectQaLinks(PROJECT_A.id)).toEqual([])
      expect(store.getProject(PROJECT_A.id)).toEqual(beforeSession)
      expect(store.getConversionJob(documentSaga.operationId)?.state).toBe('published_fs')
      expect(store.getConversionJob(qaSaga.operationId)?.state).toBe('published_fs')
      expect(store.listProjectRecoveryWork({ projectId: PROJECT_A.id })).toHaveLength(2)

      store.endSession('guard-session-first', 'complete', 340)
      store.commitProjectDocumentArtifact({
        ...documentSaga,
        document: {
          title: '待提交资料',
          kind: 'markdown',
          content: documentContent,
          chunks: [{ content: documentContent, tokenCount: 20 }],
        },
      }, 341)
      expect(store.getProject(PROJECT_A.id)?.knowledgeVersion).toBe(1)

      // Commit-first wins the writer lock; the subsequently-created session
      // observes that version and prevents any later publication drift.
      store.createSession({
        id: 'guard-commit-first',
        projectId: PROJECT_A.id,
        mode: 'qa',
        audioSource: 'system',
        startedAt: 342,
      })
      const frozenVersion = store.getProject(PROJECT_A.id)?.knowledgeVersion
      expect(() => store.commitProjectQaArtifact({
        ...qaSaga,
        canonicalContent: validatedQa.normalizedContent,
        items: validatedQa.items,
      }, 343)).toThrow(/PROJECT_SESSION_ACTIVE/)
      expect(store.getProject(PROJECT_A.id)?.knowledgeVersion).toBe(frozenVersion)
      expect(store.listProjectQaLinks(PROJECT_A.id)).toEqual([])

      store.endSession('guard-commit-first', 'complete', 350)
      store.commitProjectQaArtifact({
        ...qaSaga,
        canonicalContent: validatedQa.normalizedContent,
        items: validatedQa.items,
      }, 351)
      expect(store.getProject(PROJECT_A.id)?.knowledgeVersion).toBe(2)
      expect(store.listProjectRecoveryWork({ projectId: PROJECT_A.id })).toEqual([])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })
})

describe('manual project artifacts and semantic index reconciliation', () => {
  it('rolls back a session-blocked manual commit and accepts the exact retry after the session ends', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(PROJECT_A, 1)
      const run = store.beginProjectScan({
        runId: 'manual-guard-run',
        projectId: PROJECT_A.id,
        rootIdentity: PROJECT_A.rootIdentity,
        trigger: 'manual',
        startedAt: 1,
      })
      store.applyProjectScanManifest({
        runId: run.runId,
        projectId: PROJECT_A.id,
        generation: run.generation,
        observations: [],
        completedAt: 2,
      })
      store.finishProjectSync(run.runId, 'completed', null, 3)
      const body = '# 会话门禁手动资料\n\n会话结束后自动恢复提交。'
      const output = `---\nqaing_schema: "qaing-converted/v1"\ncontent_kind: "document"\n---\n\n${body}\n`
      const input = {
        operationId: 'manual-guard-operation',
        projectId: PROJECT_A.id,
        runId: run.runId,
        generation: run.generation,
        displayRelativePath: '转换资料库/资料/门禁.md',
        pathKey: '转换资料库/资料/门禁.md',
        trustKind: 'document' as const,
        canonicalContent: body,
        outputSha256: sha256(output),
        canonicalBodySha256: sha256(body),
        document: {
          title: '会话门禁手动资料',
          kind: 'markdown' as const,
          content: body,
          chunks: [{ content: body, tokenCount: 24 }],
        },
        outputSizeBytes: Buffer.byteLength(output),
      }
      const sourceId = projectSourceId(PROJECT_A.id, 'document', input.pathKey)
      const beforeSession = store.getProject(PROJECT_A.id)
      store.createSession({
        id: 'manual-guard-session',
        projectId: PROJECT_A.id,
        mode: 'qa',
        audioSource: 'microphone',
        startedAt: 4,
      })
      expect(() => store.commitManualProjectArtifact(input, 5)).toThrow(/PROJECT_SESSION_ACTIVE/)
      expect(store.getProjectSource(sourceId)).toBeNull()
      expect(store.getConversionJob(input.operationId)).toBeNull()
      expect(store.listDocuments()).toEqual([])
      expect(store.listProjectDocumentLinks(PROJECT_A.id)).toEqual([])
      expect(store.getProject(PROJECT_A.id)).toEqual(beforeSession)

      store.endSession('manual-guard-session', 'complete', 6)
      expect(store.commitManualProjectArtifact(input, 7)).toMatchObject({
        inserted: true,
        source: { sourceId, projectId: PROJECT_A.id, state: 'embedding_pending' },
      })
      expect(store.getConversionJob(input.operationId)?.state).toBe('committed')
      expect(store.listProjectDocumentLinks(PROJECT_A.id)).toHaveLength(1)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('keeps manual origin independent from pending, failed, and ready semantic states', async () => {
    const store = new DataStore(':memory:')
    const provider = new TestOnlyDeterministicEmbeddingProvider(64)
    const index = new InMemoryExactVectorIndex()
    try {
      store.createProjectManifest(PROJECT_A, 1)
      store.setActiveProject(PROJECT_A.id)
      const run = store.beginProjectScan({
        runId: 'manual-run',
        projectId: PROJECT_A.id,
        rootIdentity: PROJECT_A.rootIdentity,
        trigger: 'manual',
        startedAt: 10,
      })
      const scanned = store.applyProjectScanManifest({
        runId: run.runId,
        projectId: PROJECT_A.id,
        generation: run.generation,
        observations: [],
        completedAt: 11,
      })
      const body = '# 手动资料\n\n手动资料关键词在向量不可用时也可检索。'
      const output = `---\nqaing_schema: "qaing-converted/v1"\ncontent_kind: "source_document"\nconversion_mode: "manual"\n---\n\n${body}\n`
      const result = store.commitManualProjectArtifact({
        operationId: 'manual-operation',
        projectId: PROJECT_A.id,
        runId: run.runId,
        generation: run.generation,
        displayRelativePath: '转换资料库/资料/手动.md',
        pathKey: '转换资料库/资料/手动.md',
        trustKind: 'document',
        canonicalContent: body,
        outputSha256: sha256(output),
        canonicalBodySha256: sha256(body),
        document: {
          title: '手动资料',
          kind: 'markdown',
          content: body,
          chunks: [{ content: body, tokenCount: 20 }],
        },
        outputSizeBytes: Buffer.byteLength(output),
      }, 12)
      expect(result).toMatchObject({ inserted: true, source: { state: 'embedding_pending' } })
      store.finishProjectSync(run.runId, 'completed', null, 12)
      const replayRun = store.beginProjectScan({
        runId: 'manual-replay-run',
        projectId: PROJECT_A.id,
        rootIdentity: PROJECT_A.rootIdentity,
        trigger: 'manual',
        startedAt: 13,
      })
      store.applyProjectScanManifest({
        runId: replayRun.runId,
        projectId: PROJECT_A.id,
        generation: replayRun.generation,
        observations: [],
        completedAt: 14,
      })
      expect(store.commitManualProjectArtifact({
        operationId: 'manual-operation',
        projectId: PROJECT_A.id,
        runId: replayRun.runId,
        generation: replayRun.generation,
        displayRelativePath: '转换资料库/资料/手动.md',
        pathKey: '转换资料库/资料/手动.md',
        trustKind: 'document',
        canonicalContent: body,
        outputSha256: sha256(output),
        canonicalBodySha256: sha256(body),
        document: {
          title: '手动资料',
          kind: 'markdown',
          content: body,
          chunks: [{ content: body, tokenCount: 20 }],
        },
        outputSizeBytes: Buffer.byteLength(output),
      }, 15)).toMatchObject({ inserted: false, source: { lastSeenGeneration: replayRun.generation } })
      expect(store.searchDocumentKeywords('手动资料关键词')).toHaveLength(1)
      expect(store.getProjectStatusSummary(PROJECT_A.id)).toMatchObject({
        manualReady: 1,
        pendingEmbedding: 1,
        readyEmbedding: 0,
        failedEmbedding: 0,
      })

      const job = store.listIndexJobs().find((entry) => entry.ownerType === 'chunk')
      expect(job).toBeDefined()
      store.failIndexJob((job as { id: string }).id, 'WORKER_CRASHED', 0, 16)
      expect(store.reconcileProjectIndexState(PROJECT_A.id, 17)).toMatchObject({
        changedSourceIds: [result.source.sourceId],
      })
      expect(store.getProjectStatusSummary(PROJECT_A.id)).toMatchObject({
        manualReady: 1,
        pendingEmbedding: 0,
        failedEmbedding: 1,
      })

      await new EmbeddingIndexer({ store, index, provider, allowTestProvider: true }).indexPending()
      expect(store.reconcileProjectIndexState(PROJECT_A.id, 18)).toMatchObject({
        changedSourceIds: [result.source.sourceId],
      })
      expect(store.getProjectSource(result.source.sourceId)?.state).toBe('ready')
      expect(store.getProjectStatusSummary(PROJECT_A.id)).toMatchObject({
        manualReady: 1,
        pendingEmbedding: 0,
        readyEmbedding: 1,
        failedEmbedding: 0,
      })

      const failed = store.failManualProjectArtifact({
        projectId: PROJECT_A.id,
        runId: replayRun.runId,
        generation: replayRun.generation,
        displayRelativePath: '转换资料库/预设QA/损坏.md',
        pathKey: '转换资料库/预设qa/损坏.md',
        trustKind: 'preset_qa',
        inputSha256: sha256('invalid-manual-output'),
        errorCode: 'OUTPUT_INVALID',
      }, 19)
      expect(failed).toMatchObject({ state: 'conversion_failed', errorCode: 'OUTPUT_INVALID' })
      const beforeReplay = store.getProject(PROJECT_A.id)?.dataRevision
      expect(store.failManualProjectArtifact({
        projectId: PROJECT_A.id,
        runId: replayRun.runId,
        generation: replayRun.generation,
        displayRelativePath: '转换资料库/预设QA/损坏.md',
        pathKey: '转换资料库/预设qa/损坏.md',
        trustKind: 'preset_qa',
        inputSha256: sha256('invalid-manual-output'),
        errorCode: 'OUTPUT_INVALID',
      }, 999).sourceId).toBe(failed.sourceId)
      expect(store.getProject(PROJECT_A.id)?.dataRevision).toBe(beforeReplay)
      expect(store.getProjectSourcePage({ projectId: PROJECT_A.id, filter: 'failed' }).items).toEqual([
        expect.objectContaining({ sourceId: failed.sourceId, currentConversionMode: 'manual' }),
      ])
      store.finishProjectSync(replayRun.runId, 'completed_with_errors', null, 20)
      expect(scanned.pendingRevisions).toEqual([])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })
})

describe('active-project retrieval isolation', () => {
  it('excludes inactive project revisions from vector capacity and reuses a reactivated embedding', () => {
    const store = new DataStore(':memory:')
    const provider = new TestOnlyDeterministicEmbeddingProvider(8)
    try {
      store.createProjectManifest(PROJECT_A, 1)
      const first = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'capacity-run-1', [
        observation('原始资料/容量.md', 'old raw'),
      ], 10)
      const sourceId = first.addedSourceIds[0] as string
      const oldDocumentId = commitDocument(store, PROJECT_A.id, first, sourceId, '# 旧版\n\n旧内容', 'capacity-old', 20)
      const oldChunk = store.listChunks(oldDocumentId)[0]

      const second = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'capacity-run-2', [
        observation('原始资料/容量.md', 'new raw'),
      ], 30)
      const newDocumentId = commitDocument(store, PROJECT_A.id, second, sourceId, '# 新版\n\n新内容', 'capacity-new', 40)
      const newChunk = store.listChunks(newDocumentId)[0]
      expect(store.countStoredVectors()).toBe(0)
      // Simulate a worker completing the now-inactive old revision in the same
      // commit as the active revision. Only the active owner consumes capacity.
      store.storeEmbeddings([
        {
          ownerType: 'chunk',
          ownerId: oldChunk?.id as string,
          contentHash: oldChunk?.contentHash as string,
          vector: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
          metadata: provider.metadata,
        },
        {
          ownerType: 'chunk',
          ownerId: newChunk?.id as string,
          contentHash: newChunk?.contentHash as string,
          vector: new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]),
          metadata: provider.metadata,
        },
      ], 44, 1)
      expect(store.countStoredVectors()).toBe(1)
      expect(store.loadStoredVectors(provider.metadata).map((entry) => entry.ownerId)).toEqual([newChunk?.id])

      const third = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'capacity-run-3', [
        observation('原始资料/容量.md', 'old raw'),
      ], 50)
      const reactivatedDocumentId = commitDocument(
        store,
        PROJECT_A.id,
        third,
        sourceId,
        '# 旧版\n\n旧内容',
        'capacity-old-reactivated',
        60,
      )
      expect(reactivatedDocumentId).toBe(oldDocumentId)
      expect(store.countStoredVectors()).toBe(1)
      expect(store.loadStoredVectors(provider.metadata).map((entry) => entry.ownerId)).toEqual([oldChunk?.id])
      expect(store.listUnembeddedOwners(provider.metadata, 10)).toHaveLength(0)

      const index = new InMemoryExactVectorIndex(1)
      expect(new EmbeddingIndexer({ store, index, provider, allowTestProvider: true }).initialize()).toMatchObject({
        mode: 'hybrid',
        indexed: 1,
        remaining: 0,
      })
      expect(index.search(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), 1)[0]?.ownerId).toBe(oldChunk?.id)
    } finally {
      store.close()
    }
  })

  it('isolates exact QA, FTS, and vectors across two projects and legacy mode', async () => {
    const store = new DataStore(':memory:')
    const index = new InMemoryExactVectorIndex()
    const provider = new TestOnlyDeterministicEmbeddingProvider(64)
    try {
      const legacyDocument = store.upsertDocument({
        title: '旧资料',
        kind: 'markdown',
        content: '# 旧资料\n\n蓝鲸计划的旧库答案。',
        chunks: [{ content: '蓝鲸计划的旧库答案。', tokenCount: 12 }],
      }, 1)
      const legacyQa = store.upsertPresetQa({ question: '共同问题？', answer: '旧库答案。' }, 1).record

      store.createProjectManifest(PROJECT_A, 2)
      store.createProjectManifest({
        id: 'project-b',
        displayName: '项目 B',
        rootPath: '/tmp/qaing-project-b',
        rootIdentity: 'volume-b:root-b',
        schemaVersion: 1,
      }, 2)
      const scanA = scan(store, PROJECT_A.id, PROJECT_A.rootIdentity, 'isolation-a', [
        observation('原始资料/A.md', 'raw-doc-a'),
        observation('预设QA/A.md', 'raw-qa-a', 'preset_qa'),
      ], 10)
      const scanB = scan(store, 'project-b', 'volume-b:root-b', 'isolation-b', [
        observation('原始资料/B.md', 'raw-doc-b'),
        observation('预设QA/B.md', 'raw-qa-b', 'preset_qa'),
      ], 20)
      const documentA = commitDocument(
        store, PROJECT_A.id, scanA, scanA.addedSourceIds[0] as string,
        '# A资料\n\n蓝鲸计划只属于项目A。', 'doc-a', 30,
      )
      const qaA = commitQa(
        store, PROJECT_A.id, scanA, scanA.addedSourceIds[1] as string,
        '## 问题：共同问题？\n### 答案\n项目A答案。', 'qa-a', 40,
      )
      const documentB = commitDocument(
        store, 'project-b', scanB, scanB.addedSourceIds[0] as string,
        '# B资料\n\n蓝鲸计划只属于项目B。', 'doc-b', 50,
      )
      const qaB = commitQa(
        store, 'project-b', scanB, scanB.addedSourceIds[1] as string,
        '## 问题：共同问题？\n### 答案\n项目B答案。', 'qa-b', 60,
      )

      await new EmbeddingIndexer({ store, index, provider, allowTestProvider: true }).indexPending()
      const retriever = new HybridRetriever({
        store,
        index,
        provider,
        allowTestProvider: true,
        minimumVectorScore: -1,
      })

      store.setActiveProject(PROJECT_A.id)
      expect((await retriever.retrieve('共同问题？')).directAnswer).toBe('项目A答案。')
      expect(store.searchDocumentKeywords('蓝鲸计划', 20).map((hit) => hit.documentId)).toEqual([documentA])
      const [queryVector] = await embedTexts(provider, ['蓝鲸计划'], { allowTestProvider: true, timeoutMs: 1_000 })
      expect(index.search(
        queryVector as Float32Array, 20, -1, 'chunk', store.getRetrievalOwnerIds('chunk'),
      ).map((hit) => hit.documentId)).toEqual([documentA])
      expect(store.getRetrievalOwnerIds('preset_qa')).toEqual(new Set([qaA]))
      expect(store.deleteDocument(documentA)).toEqual([])
      expect(store.deletePresetQa(qaA)).toBe(false)
      expect(store.getRetrievalOwnerIds('chunk').size).toBeGreaterThan(0)
      expect(store.getRetrievalOwnerIds('preset_qa')).toEqual(new Set([qaA]))

      store.setActiveProject('project-b')
      expect((await retriever.retrieve('共同问题？')).directAnswer).toBe('项目B答案。')
      expect(store.searchDocumentKeywords('蓝鲸计划', 20).map((hit) => hit.documentId)).toEqual([documentB])
      expect(store.getRetrievalOwnerIds('preset_qa')).toEqual(new Set([qaB]))

      store.setActiveProject(null)
      expect((await retriever.retrieve('共同问题？')).directAnswer).toBe('旧库答案。')
      expect(store.searchDocumentKeywords('蓝鲸计划', 20).map((hit) => hit.documentId)).toEqual([
        legacyDocument.document.id,
      ])
      expect(store.getRetrievalOwnerIds('preset_qa')).toEqual(new Set([legacyQa.id]))
      const legacyChunkIds = store.listChunks(legacyDocument.document.id).map((chunk) => chunk.id)
      expect(store.deleteDocument(legacyDocument.document.id)).toEqual(legacyChunkIds)
      expect(store.deletePresetQa(legacyQa.id)).toBe(true)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })
})
