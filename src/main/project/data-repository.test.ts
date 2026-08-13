import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataStore } from '../data/database'
import { canonicalizeProjectInput } from './canonical'
import { DataStoreProjectSyncRepository } from './data-repository'
import { ProjectSyncService } from './service'
import type { ProjectConverter } from './types'

const roots: string[] = []
const stores: DataStore[] = []
const services: ProjectSyncService[] = []

const converter: ProjectConverter = {
  convert: async (request) => canonicalizeProjectInput(request),
  dispose: async () => undefined,
}

async function fixture(input: {
  readonly onKnowledgeCommitted?: (projectId: string, sourceId: string, revisionId: string) => void | Promise<void>
} = {}): Promise<{
  readonly root: string
  readonly store: DataStore
  readonly service: ProjectSyncService
  readonly projectId: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'qaing-project-data-adapter-'))
  roots.push(root)
  const store = new DataStore(':memory:')
  stores.push(store)
  let run = 0
  const repository = new DataStoreProjectSyncRepository({
    store,
    runIdFactory: () => `run-${String(++run)}`,
    ...(input.onKnowledgeCommitted === undefined ? {} : { onKnowledgeCommitted: input.onKnowledgeCommitted }),
  })
  const service = new ProjectSyncService({ repository, converter })
  services.push(service)
  const project = await service.prepareRoot({ rootPath: root, createMissing: true })
  return { root, store, service, projectId: project.id }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DataStoreProjectSyncRepository integration', () => {
  it('reopens the same durable project without replacing its sync policy', async () => {
    const { root, store, service, projectId } = await fixture()
    store.setProjectSyncPolicy(projectId, 'manual')
    const canonicalRoot = store.getProject(projectId)?.rootPath

    await expect(service.prepareRoot({ rootPath: root, createMissing: false })).resolves.toMatchObject({
      id: projectId,
      rootPath: canonicalRoot,
    })
    expect(store.listProjects()).toHaveLength(1)
    expect(store.getProject(projectId)).toMatchObject({ syncPolicy: 'manual' })
  })

  it('commits document and preset-QA bodies with distinct filesystem and canonical hashes', async () => {
    const committed = vi.fn(async (...identities: readonly [string, string, string]) => { void identities })
    const { root, store, service, projectId } = await fixture({ onKnowledgeCommitted: committed })
    await writeFile(join(root, '原始资料', 'brief.md'), '# Brief\n\n项目预算为 100 万元。')
    await writeFile(join(root, '预设QA', 'answers.json'), JSON.stringify([
      { question: '项目预算多少？', answer: '100 万元。' },
    ]))

    await expect(service.sync({ projectId, trigger: 'manual', apply: true }))
      .resolves.toMatchObject({ phase: 'complete', counts: { converted: 2, failed: 0 } })
    const documentLink = store.listProjectDocumentLinks(projectId)[0]
    const qaLink = store.listProjectQaLinks(projectId)[0]
    expect(documentLink?.active).toBe(true)
    expect(qaLink?.active).toBe(true)
    const document = store.getDocument(documentLink?.documentId ?? '')
    expect(document?.content).toContain('项目预算为 100 万元')
    expect(document?.content).not.toContain('source_sha256:')
    expect(store.getPresetQa(qaLink?.presetQaId ?? '')).toMatchObject({
      question: '项目预算多少？',
      answer: '100 万元。',
    })
    for (const link of [documentLink, qaLink]) {
      const artifact = store.getConversionArtifact(link?.artifactId ?? '')
      expect(artifact?.outputSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(artifact?.canonicalBodySha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(artifact?.outputSha256).not.toBe(artifact?.canonicalBodySha256)
    }
    expect(committed).toHaveBeenCalledTimes(2)
    expect(committed.mock.calls.every(([committedProjectId]) => committedProjectId === projectId)).toBe(true)
    expect(store.integrityCheck()).toBe('ok')
  })

  it('keeps durable FTS knowledge pending when the optional index hook fails', async () => {
    const failedHook = vi.fn(async () => { throw new Error('worker unavailable') })
    const { root, store, service, projectId } = await fixture({ onKnowledgeCommitted: failedHook })
    await writeFile(join(root, '原始资料', 'fallback.txt'), '可用的关键词降级内容')

    await expect(service.sync({ projectId, trigger: 'manual', apply: true }))
      .resolves.toMatchObject({ counts: { converted: 1, failed: 0 } })
    store.setActiveProject(projectId)
    expect(store.listDocuments()[0]?.content).toContain('关键词降级')
    expect(store.searchKeywords('可用的关键词降级内容')).toHaveLength(1)
    expect(store.listProjectManifestEntries(projectId)[0]).toMatchObject({ state: 'embedding_pending' })
    expect(failedHook).toHaveBeenCalledOnce()

    await expect(service.sync({ projectId, trigger: 'manual', apply: true }))
      .resolves.toMatchObject({ counts: { converted: 0, failed: 0 } })
    expect(failedHook).toHaveBeenCalledOnce()
  })

  it('retains the content hash of an externally converted regular input', async () => {
    const { root, store, service, projectId } = await fixture()
    const bytes = Buffer.from('%PDF-1.7\nexternal-conversion-source\n', 'utf8')
    await writeFile(join(root, '原始资料', 'source.pdf'), bytes)

    await expect(service.sync({ projectId, trigger: 'manual', apply: false }))
      .resolves.toMatchObject({ counts: { converted: 0, failed: 0 } })
    expect(store.listProjectManifestEntries(projectId)).toEqual([
      expect.objectContaining({
        relativePath: '原始资料/source.pdf',
        conversionDisposition: 'external',
        rawSha256: createHash('sha256').update(bytes).digest('hex'),
        errorCode: 'INPUT_UNSUPPORTED',
      }),
    ])
  })

  it('replays a published filesystem artifact after a transient SQLite commit failure', async () => {
    const { root, store, service, projectId } = await fixture()
    await writeFile(join(root, '原始资料', 'recover.txt'), '崩溃后应恢复的内容')
    const originalCommit = store.commitProjectDocumentArtifact.bind(store)
    const commit = vi.spyOn(store, 'commitProjectDocumentArtifact')
      .mockImplementationOnce(() => { throw new Error('SQLITE_BUSY') })
      .mockImplementation((input, now) => originalCommit(input, now))

    await expect(service.sync({ projectId, trigger: 'manual', apply: true }))
      .resolves.toMatchObject({ counts: { converted: 0, failed: 1 } })
    expect(store.listProjectRecoveryWork({ projectId })).toEqual([
      expect.objectContaining({ state: 'published_fs' }),
    ])
    await expect(service.recover(projectId)).resolves.toMatchObject({ committed: 1, failed: 0 })
    expect(store.listProjectRecoveryWork({ projectId })).toHaveLength(0)
    expect(store.listDocuments()[0]?.content).toContain('崩溃后应恢复')
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('defers generated and manual knowledge while a session owns the project, then resumes after release', async () => {
    const { root, store, service, projectId } = await fixture()
    await writeFile(join(root, '原始资料', 'deferred.txt'), '会话结束后提交的生成资料')
    await writeFile(join(root, '转换资料库', '资料', 'deferred-manual.md'), '会话结束后提交的手动资料\n')
    store.setActiveProject(projectId)
    store.createSessionForActiveProject({
      id: 'project-sync-live-session',
      mode: 'qa',
      audioSource: 'microphone',
      startedAt: 500,
    })

    await expect(service.sync({ projectId, trigger: 'manual', apply: true })).rejects.toMatchObject({
      code: 'PROJECT_SESSION_ACTIVE',
      retryable: true,
    })
    expect(store.listProjectRecoveryWork({ projectId })).toEqual([
      expect.objectContaining({ state: 'published_fs' }),
    ])
    expect(store.listProjectManifestEntries(projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: '转换资料库/资料/deferred-manual.md',
        errorCode: null,
      }),
    ]))
    expect(store.listProjectDocumentLinks(projectId)).toEqual([])

    store.endSession('project-sync-live-session', 'complete', 501)
    await expect(service.resumeAfterSession(projectId)).resolves.toBe(true)
    await vi.waitFor(() => {
      expect(store.listProjectDocumentLinks(projectId).filter((entry) => entry.active)).toHaveLength(2)
    })
    expect(store.listProjectRecoveryWork({ projectId })).toEqual([])
    expect(store.listProjectManifestEntries(projectId).some((entry) => entry.state === 'conversion_failed')).toBe(false)
    expect(store.listDocuments().map((entry) => entry.content).join('\n')).toContain('会话结束后提交的手动资料')
  })

  it('rebuilds a deleted app-managed output without dropping its last-good source', async () => {
    const { root, store, service, projectId } = await fixture()
    await writeFile(join(root, '原始资料', 'managed.txt'), '稳定内容')
    await service.sync({ projectId, trigger: 'manual', apply: true })
    const initial = store.listProjectManifestEntries(projectId)[0]
    const outputPath = join(root, initial?.outputRelativePath ?? '')
    await unlink(outputPath)

    await expect(service.sync({ projectId, trigger: 'manual', apply: true }))
      .resolves.toMatchObject({ counts: { converted: 1, failed: 0 } })
    const rebuilt = store.listProjectManifestEntries(projectId)[0]
    expect(rebuilt?.sourceId).toBe(initial?.sourceId)
    expect(rebuilt?.activeRawSha256).toBe(initial?.activeRawSha256)
    await expect(readFile(outputPath, 'utf8')).resolves.toContain('稳定内容')
    expect(store.listProjectDocumentLinks(projectId).filter((entry) => entry.active)).toHaveLength(1)
  })

  it('marks a user-edited managed output without overwriting or unlinking last-good knowledge', async () => {
    const { root, store, service, projectId } = await fixture()
    await writeFile(join(root, '原始资料', 'protected.txt'), '原始内容')
    await service.sync({ projectId, trigger: 'manual', apply: true })
    const initial = store.listProjectManifestEntries(projectId)[0]
    const outputPath = join(root, initial?.outputRelativePath ?? '')
    const userEdit = '# 用户手动修改\n\n不可覆盖'
    await writeFile(outputPath, userEdit)

    await expect(service.sync({ projectId, trigger: 'manual', apply: true }))
      .resolves.toMatchObject({ counts: { converted: 0, blocked: 1, failed: 0 } })
    expect(store.listProjectManifestEntries(projectId)[0]).toMatchObject({
      sourceId: initial?.sourceId,
      state: 'blocked',
      errorCode: 'GENERATED_OUTPUT_MODIFIED',
      activeRawSha256: initial?.activeRawSha256,
    })
    expect(store.listProjectDocumentLinks(projectId)[0]?.active).toBe(true)
    await expect(readFile(outputPath, 'utf8')).resolves.toBe(userEdit)
  })

  it('does not clear a modified-output block on a later identical scan', async () => {
    const { root, store, service, projectId } = await fixture()
    await writeFile(join(root, '原始资料', 'blocked.txt'), '原始内容')
    await service.sync({ projectId, trigger: 'manual', apply: true })
    const outputPath = join(root, store.listProjectManifestEntries(projectId)[0]?.outputRelativePath ?? '')
    await writeFile(outputPath, '# 修改后的托管输出')

    await service.sync({ projectId, trigger: 'manual', apply: true })
    await service.sync({ projectId, trigger: 'manual', apply: true })
    expect(store.listProjectManifestEntries(projectId)[0]).toMatchObject({
      state: 'blocked',
      errorCode: 'GENERATED_OUTPUT_MODIFIED',
    })
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('# 修改后的托管输出')
  })

  it('keeps repeated check-only absence non-destructive and applies only an explicit later plan', async () => {
    const { root, store, service, projectId } = await fixture()
    const inputPath = join(root, '原始资料', 'stable.txt')
    await writeFile(inputPath, 'last-good')
    await service.sync({ projectId, trigger: 'manual', apply: true })
    const link = store.listProjectDocumentLinks(projectId)[0]
    expect(link?.active).toBe(true)
    await unlink(inputPath)

    await service.sync({ projectId, trigger: 'manual', apply: false })
    await service.sync({ projectId, trigger: 'manual', apply: false })
    expect(store.listProjectDocumentLinks(projectId)[0]?.active).toBe(true)
    expect(store.listProjectManifestEntries(projectId)[0]).toMatchObject({ state: 'missing_grace' })

    const applied = await service.sync({
      projectId,
      trigger: 'manual',
      apply: true,
      allowDestructiveChanges: true,
    })
    expect(store.listProjectDocumentLinks(projectId)[0]?.active).toBe(false)
    expect(store.listProjectManifestEntries(projectId)[0]).toMatchObject({ state: 'tombstoned' })
    expect(store.getProjectSyncRun(applied.runId)?.counts).toMatchObject({
      missingGrace: 0,
      tombstoned: 1,
      failed: 0,
    })
  })

  it('preserves source identity when a check-only rename is confirmed in a later generation', async () => {
    const { root, store, service, projectId } = await fixture()
    const oldPath = join(root, '原始资料', 'old.txt')
    const newPath = join(root, '原始资料', 'new.txt')
    await writeFile(oldPath, 'same bytes')
    await service.sync({ projectId, trigger: 'manual', apply: true })
    const original = store.listProjectManifestEntries(projectId)[0]
    expect(original?.sourceId).toBeTruthy()
    await rename(oldPath, newPath)

    await service.sync({ projectId, trigger: 'manual', apply: false })
    expect(store.listProjectManifestEntries(projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: original?.sourceId, relativePath: '原始资料/old.txt' }),
      expect.objectContaining({ relativePath: '原始资料/new.txt', errorCode: 'RENAME_CONFIRMATION_REQUIRED' }),
    ]))

    const applied = await service.sync({ projectId, trigger: 'manual', apply: true })
    const active = store.listProjectManifestEntries(projectId).filter((entry) => entry.state !== 'tombstoned')
    expect(active).toEqual([
      expect.objectContaining({ sourceId: original?.sourceId, relativePath: '原始资料/new.txt' }),
    ])
    expect(store.listProjectDocumentLinks(projectId).filter((entry) => entry.active)).toHaveLength(1)
    expect(store.getProjectSyncRun(applied.runId)?.counts).toMatchObject({ renamed: 1, failed: 0 })
  })

  it('imports safe plain manual Markdown while a newly added raw source still follows normal conversion', async () => {
    const { root, store, service, projectId } = await fixture()
    const valid = '经审核的正文。\n\n- 这份 Markdown 由用户维护\n'
    await writeFile(join(root, '转换资料库', '资料', 'manual.md'), valid)
    await writeFile(join(root, '转换资料库', '预设QA', 'invalid.md'), '普通问答散文')
    await writeFile(join(root, '原始资料', 'new.txt'), '新增原始资料仍需要转换')

    await expect(service.sync({ projectId, trigger: 'manual', apply: true }))
      .resolves.toMatchObject({ phase: 'complete', counts: { converted: 2, failed: 1 } })
    expect(store.listProjectDocumentLinks(projectId)).toHaveLength(2)
    expect(store.listProjectQaLinks(projectId)).toHaveLength(0)
    expect(store.listProjectManifestEntries(projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: '转换资料库/预设QA/invalid.md', state: 'conversion_failed' }),
    ]))
    const body = store.listDocuments().find((entry) => entry.content.includes('用户维护'))?.content ?? ''
    expect(createHash('sha256').update(body).digest('hex')).toMatch(/^[a-f0-9]{64}$/u)
    expect(body).not.toContain('conversion_mode:')
    expect(store.listDocuments().some((entry) => entry.content.includes('新增原始资料'))).toBe(true)

    const output = await readFile(join(root, '转换资料库', '资料', 'manual.md'), 'utf8')
    expect(output).toBe(valid)
  })

  it('accepts plain strict-QA Markdown and rejects a conflicting manual QA without replacing last-good', async () => {
    const { root, store, service, projectId } = await fixture()
    const first = '## 问题：项目预算多少？\n\n### 答案\n\n100 万元。\n'
    await writeFile(join(root, '转换资料库', '预设QA', 'approved.md'), first)

    await expect(service.sync({ projectId, trigger: 'manual', apply: true }))
      .resolves.toMatchObject({ counts: { converted: 1, failed: 0 } })
    expect(store.listProjectQaLinks(projectId).filter((entry) => entry.active)).toHaveLength(1)
    expect(store.getPresetQa(store.listProjectQaLinks(projectId)[0]?.presetQaId ?? '')).toMatchObject({
      question: '项目预算多少？',
      answer: '100 万元。',
    })

    await writeFile(
      join(root, '转换资料库', '预设QA', 'conflict.md'),
      '## 问题：项目预算多少？\n\n### 答案\n\n200 万元。\n',
    )
    await expect(service.sync({ projectId, trigger: 'manual', apply: true }))
      .resolves.toMatchObject({ counts: { converted: 0, failed: 1 } })
    const active = store.listProjectQaLinks(projectId).filter((entry) => entry.active)
    expect(active).toHaveLength(1)
    expect(store.getPresetQa(active[0]?.presetQaId ?? '')?.answer).toBe('100 万元。')
    expect(store.listProjectManifestEntries(projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: '转换资料库/预设QA/conflict.md',
        state: 'conversion_failed',
      }),
    ]))
  })

  it('treats an unchanged manual artifact as idempotent across scan generations', async () => {
    const { root, store, service, projectId } = await fixture()
    const manual = [
      '---',
      'qaing_schema: "qaing-converted/v1"',
      'content_kind: "source_document"',
      'conversion_mode: "manual"',
      '---',
      '# 手动资料',
      '',
      '只应导入一次。',
      '',
    ].join('\n')
    await writeFile(join(root, '转换资料库', '资料', 'manual.md'), manual)

    const first = await service.sync({ projectId, trigger: 'manual', apply: true })
    const second = await service.sync({ projectId, trigger: 'manual', apply: true })
    const third = await service.sync({ projectId, trigger: 'manual', apply: true })
    expect(first).toMatchObject({ counts: { converted: 1, failed: 0 } })
    expect(second).toMatchObject({ counts: { converted: 0, failed: 0 } })
    expect(third).toMatchObject({ counts: { converted: 0, failed: 0, tombstoned: 0 } })
    expect(store.listProjectDocumentLinks(projectId).filter((entry) => entry.active)).toHaveLength(1)
    expect(store.listDocuments()).toHaveLength(1)
    expect(store.listProjectManifestEntries(projectId)).toEqual([
      expect.objectContaining({ relativePath: '转换资料库/资料/manual.md', state: 'embedding_pending' }),
    ])
  })

  it('persists terminal run counts across a SQLite close and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qaing-project-run-counts-'))
    roots.push(root)
    const databasePath = join(root, '.qaing-run-counts.sqlite3')
    const store = new DataStore(databasePath)
    let run = 0
    const repository = new DataStoreProjectSyncRepository({
      store,
      runIdFactory: () => `restart-run-${String(++run)}`,
    })
    const service = new ProjectSyncService({ repository, converter })
    const project = await service.prepareRoot({ rootPath: root, createMissing: true })
    await writeFile(join(root, '原始资料', 'source.txt'), '持久化最终计数')
    await writeFile(join(root, '转换资料库', '资料', 'manual.md'), [
      '---',
      'qaing_schema: "qaing-converted/v1"',
      'content_kind: "source_document"',
      'conversion_mode: "manual"',
      '---',
      '# 手工资料',
      '',
      '重启后仍应统计为已就绪。',
      '',
    ].join('\n'))
    await writeFile(join(root, '转换资料库', '预设QA', 'invalid.md'), '无合法来源声明')

    const result = await service.sync({ projectId: project.id, trigger: 'manual', apply: true })
    expect(result).toMatchObject({
      phase: 'complete',
      counts: { discovered: 3, converted: 2, failed: 1 },
    })
    const beforeRestart = store.getProjectSyncRun(result.runId)
    expect(beforeRestart).toMatchObject({
      state: 'completed_with_errors',
      counts: {
        discovered: 3,
        converted: 2,
        manualReady: 1,
        blocked: 0,
        failed: 1,
      },
    })

    await service.dispose()
    store.close()
    const reopened = new DataStore(databasePath)
    try {
      expect(reopened.getProjectSyncRun(result.runId)).toEqual(beforeRestart)
      expect(reopened.getProjectStatusSummary(project.id)).toMatchObject({ manualReady: 1 })
    } finally {
      reopened.close()
    }
  })
})
