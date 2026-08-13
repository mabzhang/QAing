import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { DataStore } from './database'
import { sha256 } from './hash'
import { prepareProjectFrontDocumentDeferred } from './importers'
import { applyMigrations, latestSchemaVersion } from './migrations'
import { TestOnlyDeterministicEmbeddingProvider } from './testing'

const project = (id: string) => ({
  id,
  displayName: id,
  rootPath: `/tmp/${id}`,
  rootIdentity: `root-${id}`,
  schemaVersion: 1,
})

function prepareFront(
  store: DataStore,
  input: {
    readonly projectId: string
    readonly sessionId: string
    readonly draftId: string
    readonly markdown: string
    readonly now: number
  },
) {
  store.createSession({
    id: input.sessionId,
    projectId: input.projectId,
    mode: 'front',
    audioSource: 'system',
    startedAt: input.now,
  })
  const draft = store.upsertFrontDraft({
    id: input.draftId,
    sessionId: input.sessionId,
    transcript: `raw-${input.sessionId}`,
    status: 'raw_ready',
  }, input.now + 1)
  store.markFrontDraftStructured(input.draftId, draft.contentHash, input.markdown, input.now + 2)
  return prepareProjectFrontDocumentDeferred({
    sessionId: input.sessionId,
    title: `Front ${input.sessionId}`,
    markdown: input.markdown,
  })
}

describe('project-scoped structured front documents', () => {
  it('commits derived front knowledge without inventing a conversion-file manifest and isolates A/B retrieval', () => {
    const store = new DataStore(':memory:')
    const provider = new TestOnlyDeterministicEmbeddingProvider(8)
    try {
      store.createProjectManifest(project('project-a'), 1)
      store.createProjectManifest(project('project-b'), 1)
      const aDocument = prepareFront(store, {
        projectId: 'project-a', sessionId: 'front-a', draftId: 'draft-a',
        markdown: '# A 会议\n\n阿尔法专项使用青色包装。', now: 10,
      })
      const bDocument = prepareFront(store, {
        projectId: 'project-b', sessionId: 'front-b', draftId: 'draft-b',
        markdown: '# B 会议\n\n贝塔专项使用橙色包装。', now: 20,
      })
      const a = store.commitProjectFrontDocument({
        projectId: 'project-a', sessionId: 'front-a', draftId: 'draft-a', document: aDocument,
      }, 13)
      const b = store.commitProjectFrontDocument({
        projectId: 'project-b', sessionId: 'front-b', draftId: 'draft-b', document: bDocument,
      }, 23)
      store.endSession('front-a', 'complete', 24)
      store.endSession('front-b', 'complete', 24)

      expect(store.listProjectManifestEntries('project-a')).toEqual([])
      expect(store.listProjectDocumentLinks('project-a')).toEqual([])
      expect(store.listProjectFrontDocumentLinks('project-a')).toEqual([
        expect.objectContaining({ projectId: 'project-a', sessionId: 'front-a', documentId: a.document.id }),
      ])
      expect(store.getProjectStatusSummary('project-a')).toMatchObject({
        totalFiles: 0,
        hasUsableKnowledge: true,
        pendingEmbedding: 1,
      })

      const aChunk = store.listChunks(a.document.id)[0]
      const bChunk = store.listChunks(b.document.id)[0]
      expect(aChunk).toBeDefined()
      expect(bChunk).toBeDefined()
      store.storeEmbeddings([
        {
          ownerType: 'chunk', ownerId: aChunk?.id as string, contentHash: aChunk?.contentHash as string,
          vector: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), metadata: provider.metadata,
        },
        {
          ownerType: 'chunk', ownerId: bChunk?.id as string, contentHash: bChunk?.contentHash as string,
          vector: new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]), metadata: provider.metadata,
        },
      ], 30)
      expect(store.countStoredVectors(provider.metadata)).toBe(2)

      store.setActiveProject('project-a')
      expect(store.searchDocumentKeywords('阿尔法专项').map((hit) => hit.documentId)).toEqual([a.document.id])
      expect(store.searchDocumentKeywords('贝塔专项')).toEqual([])
      expect(store.getRetrievalOwnerIds('chunk')).toEqual(new Set([aChunk?.id]))

      store.setActiveProject('project-b')
      expect(store.searchDocumentKeywords('贝塔专项').map((hit) => hit.documentId)).toEqual([b.document.id])
      expect(store.searchDocumentKeywords('阿尔法专项')).toEqual([])
      expect(store.getRetrievalOwnerIds('chunk')).toEqual(new Set([bChunk?.id]))

      store.setActiveProject(null)
      expect(store.searchDocumentKeywords('阿尔法专项')).toEqual([])
      expect(store.searchDocumentKeywords('贝塔专项')).toEqual([])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('fails stale or cross-project commits atomically and makes exact retries idempotent', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      store.createProjectManifest(project('project-b'), 1)
      expect(() => store.createSessionForActiveProject({
        id: 'front-without-project', mode: 'front', audioSource: 'microphone', startedAt: 2,
      })).toThrow(/active project/)
      const document = prepareFront(store, {
        projectId: 'project-a', sessionId: 'front-a', draftId: 'draft-a',
        markdown: '# 稳定版\n\n只允许写入项目 A。', now: 10,
      })
      const before = store.getProject('project-a')
      expect(() => store.commitProjectFrontDocument({
        projectId: 'project-b', sessionId: 'front-a', draftId: 'draft-a', document,
      }, 13)).toThrow(/does not belong/)
      expect(store.listDocuments()).toEqual([])
      expect(store.listProjectFrontDocumentLinks()).toEqual([])
      expect(store.getProject('project-a')).toEqual(before)

      const stale = prepareProjectFrontDocumentDeferred({
        sessionId: 'front-a', title: 'Front front-a', markdown: '# 旧代\n\n过时结果。',
      })
      expect(() => store.commitProjectFrontDocument({
        projectId: 'project-a', sessionId: 'front-a', draftId: 'draft-a', document: stale,
      }, 14)).toThrow(/does not match/)
      expect(store.listDocuments()).toEqual([])

      const committed = store.commitProjectFrontDocument({
        projectId: 'project-a', sessionId: 'front-a', draftId: 'draft-a', document,
      }, 15)
      expect(store.getSession('front-a')).toMatchObject({ status: 'complete', endedAt: 15 })
      const committedProject = store.getProject('project-a')
      expect(store.commitProjectFrontDocument({
        projectId: 'project-a', sessionId: 'front-a', draftId: 'draft-a', document,
      }, 99)).toMatchObject({ inserted: false, contentChanged: false, document: committed.document })
      expect(store.getProject('project-a')).toEqual(committedProject)

      const draft = store.getFrontDraft('draft-a')
      store.markFrontDraftStructured('draft-a', draft?.contentHash as string, '# 篡改\n\n不得覆盖。', 100)
      const conflicting = prepareProjectFrontDocumentDeferred({
        sessionId: 'front-a', title: 'Front front-a', markdown: '# 篡改\n\n不得覆盖。',
      })
      expect(() => store.commitProjectFrontDocument({
        projectId: 'project-a', sessionId: 'front-a', draftId: 'draft-a', document: conflicting,
      }, 101)).toThrow(/already committed/)
      expect(store.getDocument(committed.document.id)?.content).toBe(document.content)
      expect(store.listProjectFrontDocumentLinks()).toHaveLength(1)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('blocks a front publication behind another live project session and atomically ends its own producer', () => {
    const store = new DataStore(':memory:')
    try {
      store.createProjectManifest(project('project-a'), 1)
      const document = prepareFront(store, {
        projectId: 'project-a', sessionId: 'front-producer', draftId: 'front-producer-draft',
        markdown: '# 前置纪要\n\n只能在项目无其他活动会话时发布。', now: 10,
      })
      store.createSession({
        id: 'front-blocker',
        projectId: 'project-a',
        mode: 'qa',
        audioSource: 'microphone',
        startedAt: 12,
      })
      const before = store.getProject('project-a')
      expect(() => store.commitProjectFrontDocument({
        projectId: 'project-a',
        sessionId: 'front-producer',
        draftId: 'front-producer-draft',
        document,
      }, 13)).toThrow(/PROJECT_SESSION_ACTIVE/)
      expect(store.getSession('front-producer')).toMatchObject({ status: 'active', endedAt: null })
      expect(store.listDocuments()).toEqual([])
      expect(store.listProjectFrontDocumentLinks('project-a')).toEqual([])
      expect(store.getProject('project-a')).toEqual(before)

      store.endSession('front-blocker', 'complete', 14)
      const committed = store.commitProjectFrontDocument({
        projectId: 'project-a',
        sessionId: 'front-producer',
        draftId: 'front-producer-draft',
        document,
      }, 15)
      expect(store.getSession('front-producer')).toMatchObject({ status: 'complete', endedAt: 15 })
      expect(store.listProjectFrontDocumentLinks('project-a')).toEqual([
        expect.objectContaining({ sessionId: 'front-producer', documentId: committed.document.id }),
      ])
      expect(store.getProject('project-a')?.knowledgeVersion).toBe(1)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('does not silently assign legacy global front documents during migration v8', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-front-v8-'))
    const path = join(directory, 'qaing.sqlite3')
    const legacy = new Database(path)
    const content = '# 旧版前置\n\n仍属于未归属的全局记录。'
    const documentHash = sha256(content)
    const chunkHash = sha256('仍属于未归属的全局记录。')
    try {
      applyMigrations(legacy, 1, 7)
      legacy.prepare(
        `INSERT INTO sessions(id, mode, audio_source, status, started_at, ended_at, project_id)
         VALUES ('legacy-front', 'front', 'system', 'complete', 1, 2, NULL)`,
      ).run()
      legacy.prepare(
        `INSERT INTO documents(id, title, kind, source_uri, content, content_hash, created_at, updated_at)
         VALUES ('legacy-front-doc', '旧版前置', 'front_transcript', 'qaing://front/legacy-front', ?, ?, 1, 1)`,
      ).run(content, documentHash)
      legacy.prepare(
        `INSERT INTO chunks(id, document_id, ordinal, content, content_hash, token_count)
         VALUES ('legacy-front-chunk', 'legacy-front-doc', 0, '仍属于未归属的全局记录。', ?, 16)`,
      ).run(chunkHash)
      legacy.prepare("INSERT INTO legacy_document_entries(document_id) VALUES ('legacy-front-doc')").run()
    } finally {
      legacy.close()
    }

    const store = new DataStore(path)
    try {
      expect(store.schemaVersion()).toBe(latestSchemaVersion)
      expect(store.listProjectFrontDocumentLinks()).toEqual([])
      expect(store.searchDocumentKeywords('未归属的全局记录').map((hit) => hit.documentId))
        .toEqual(['legacy-front-doc'])
      expect(store.getRetrievalOwnerIds('chunk')).toEqual(new Set(['legacy-front-chunk']))
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
