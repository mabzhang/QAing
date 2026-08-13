import { describe, expect, it, vi } from 'vitest'
import type { QaWorkspaceChanged, SourceReference } from '../../core/types'
import { DataStore } from '../data/database'
import type { IsolatedLocalBgeEmbeddingProvider } from '../data/isolated-bge-provider'
import { KnowledgeRepository } from '../data/repository'
import { InMemoryExactVectorIndex, type EmbeddingIndexer } from '../data/vector'
import { SqliteApplicationRepository } from './adapters'

const PROJECT_ID = 'adapter-project'

function prepareQaProject(store: DataStore): void {
  if (!store.getProject(PROJECT_ID)) {
    store.createProjectManifest({
      id: PROJECT_ID,
      displayName: 'Adapter Project',
      rootPath: '/tmp/qaing-adapter-project',
      rootIdentity: 'adapter-project-root',
      schemaVersion: 1,
    }, 1)
  }
  store.setActiveProject(PROJECT_ID)
}

function repositoryFixture(input: {
  readonly prepare?: () => Promise<void>
  readonly indexPending: ReturnType<typeof vi.fn>
  readonly onWorkspaceChanged?: (event: QaWorkspaceChanged) => void
}): { readonly store: DataStore; readonly repository: SqliteApplicationRepository } {
  const store = new DataStore(':memory:')
  const vectorIndex = new InMemoryExactVectorIndex()
  const provider = {
    prepare: input.prepare ?? (async () => undefined),
  } as unknown as IsolatedLocalBgeEmbeddingProvider
  return {
    store,
    repository: new SqliteApplicationRepository({
      store,
      provider,
      indexer: { indexPending: input.indexPending } as unknown as EmbeddingIndexer,
      knowledge: new KnowledgeRepository(store, vectorIndex),
      ...(input.onWorkspaceChanged === undefined ? {} : { onWorkspaceChanged: input.onWorkspaceChanged }),
    }),
  }
}

describe('SqliteApplicationRepository front indexing fallback', () => {
  it('completes and preserves FTS-visible front material when the BGE worker exits', async () => {
    const indexPending = vi.fn(async () => { throw new Error('WORKER_EXIT_11') })
    const fixture = repositoryFixture({ indexPending })
    try {
      prepareQaProject(fixture.store)
      fixture.store.createSession({ id: 'front-worker-exit', projectId: PROJECT_ID, mode: 'front', audioSource: 'system' })
      await fixture.repository.persistFrontTranscript({
        sessionId: 'front-worker-exit',
        transcript: '原始转写先保存。',
      })
      await fixture.repository.indexStructuredFront({
        projectId: PROJECT_ID,
        documentId: 'front_front-worker-exit',
        markdown: '# 客户政策\n\n保修期限为一年。',
      })

      expect(fixture.store.getFrontDraft('front_front-worker-exit')?.status).toBe('complete')
      expect(fixture.store.searchKeywords('保修期限为一年')[0]?.title).toContain('前置记录')
      expect(fixture.store.integrityCheck()).toBe('ok')
    } finally {
      fixture.store.close()
    }
  })

  it('stops a no-progress index result instead of hot-looping', async () => {
    const indexPending = vi.fn(async () => ({
      mode: 'keyword_fallback' as const,
      indexed: 0,
      remaining: 1,
      failed: 0,
    }))
    const fixture = repositoryFixture({ indexPending })
    try {
      prepareQaProject(fixture.store)
      fixture.store.createSession({ id: 'front-no-progress', projectId: PROJECT_ID, mode: 'front', audioSource: 'system' })
      await fixture.repository.persistFrontTranscript({ sessionId: 'front-no-progress', transcript: '原始内容。' })
      await fixture.repository.indexStructuredFront({
        projectId: PROJECT_ID,
        documentId: 'front_front-no-progress',
        markdown: '# 记录\n\n索引暂不可用。',
      })

      expect(indexPending).toHaveBeenCalledTimes(1)
      expect(fixture.store.getFrontDraft('front_front-no-progress')?.status).toBe('complete')
    } finally {
      fixture.store.close()
    }
  })

  it('rejects a mismatched front project and exposes the committed note only to its frozen project', async () => {
    const fixture = repositoryFixture({ indexPending: vi.fn(async () => ({
      mode: 'keyword_fallback' as const, indexed: 0, remaining: 0, failed: 0,
    })) })
    const projectB = 'adapter-project-b'
    try {
      prepareQaProject(fixture.store)
      fixture.store.createProjectManifest({
        id: projectB,
        displayName: 'Adapter Project B',
        rootPath: '/tmp/qaing-adapter-project-b',
        rootIdentity: 'adapter-project-root-b',
        schemaVersion: 1,
      }, 1)
      fixture.store.createSession({
        id: 'front-project-a', projectId: PROJECT_ID, mode: 'front', audioSource: 'system',
      })
      await fixture.repository.persistFrontTranscript({
        sessionId: 'front-project-a', transcript: '这是 A 项目独有的原始记录。',
      })
      const structured = {
        documentId: 'front_front-project-a',
        markdown: '# A 项目记录\n\n隔离标记 A_ONLY_FRONT_NOTE。',
      }

      await expect(fixture.repository.indexStructuredFront({
        ...structured, projectId: projectB,
      })).rejects.toThrow('FRONT_PROJECT_MISMATCH')
      expect(fixture.store.listProjectFrontDocumentLinks()).toHaveLength(0)

      await fixture.repository.indexStructuredFront({ ...structured, projectId: PROJECT_ID })
      expect(fixture.store.searchDocumentKeywords('A_ONLY_FRONT_NOTE')).toHaveLength(1)
      fixture.store.endSession('front-project-a', 'complete')
      fixture.store.setActiveProject(projectB)
      expect(fixture.store.searchDocumentKeywords('A_ONLY_FRONT_NOTE')).toHaveLength(0)
      fixture.store.setActiveProject(PROJECT_ID)
      expect(fixture.store.searchDocumentKeywords('A_ONLY_FRONT_NOTE')).toHaveLength(1)
    } finally {
      fixture.store.close()
    }
  })
})

describe('SqliteApplicationRepository QA workspace boundary', () => {
  it('atomically freezes the active project before any QA runtime starts', async () => {
    const fixture = repositoryFixture({ indexPending: vi.fn() })
    try {
      await expect(fixture.repository.beginSession({
        sessionId: 'no-project', mode: 'qa', audioSource: 'microphone',
      })).rejects.toThrow(/active project/u)
      expect(fixture.store.getSession('no-project')).toBeNull()
      await expect(fixture.repository.beginSession({
        sessionId: 'front-no-project', mode: 'front', audioSource: 'microphone',
      })).rejects.toThrow(/active project/u)
      expect(fixture.store.getSession('front-no-project')).toBeNull()

      fixture.store.createSession({
        id: 'legacy-front-without-project', mode: 'front', audioSource: 'microphone',
      })
      await expect(fixture.repository.beginSession({
        sessionId: 'legacy-front-without-project', mode: 'front', audioSource: 'microphone',
      })).rejects.toThrow('SESSION_ID_CONFLICT')

      prepareQaProject(fixture.store)
      await expect(fixture.repository.beginSession({
        sessionId: 'frozen-project', mode: 'qa', audioSource: 'microphone',
      })).resolves.toEqual({ projectId: PROJECT_ID })
      expect(fixture.store.getSession('frozen-project')).toMatchObject({ projectId: PROJECT_ID })
      expect(() => fixture.store.setActiveProject(null)).toThrow(/session is active/u)
      fixture.store.endSession('frozen-project', 'complete')
      await expect(fixture.repository.beginSession({
        sessionId: 'frozen-project', mode: 'qa', audioSource: 'microphone',
      })).rejects.toThrow('SESSION_ID_CONFLICT')
    } finally {
      fixture.store.close()
    }
  })

  it('persists versions before an atomic final selection and emits monotonic workspace deltas', async () => {
    const changes: QaWorkspaceChanged[] = []
    const fixture = repositoryFixture({
      indexPending: vi.fn(),
      onWorkspaceChanged: (event) => changes.push(event),
    })
    try {
      prepareQaProject(fixture.store)
      fixture.store.createSession({ id: 'qa-session', projectId: PROJECT_ID, mode: 'qa', audioSource: 'microphone', startedAt: 1 })
      const preset = fixture.store.upsertPresetQa({ question: '预算多少？', answer: '100万元。' }, 2).record
      const source: SourceReference = {
        id: preset.id,
        documentId: `preset:${preset.id}`,
        title: '预设问题',
        kind: 'preset_qa',
        excerpt: preset.answer,
        score: 1,
      }
      await fixture.repository.ensureQaRound({
        projectId: PROJECT_ID,
        sessionId: 'qa-session', roundId: 'round-1', question: '预算多少？', startedAt: 3,
      })
      await fixture.repository.ensureQaRound({
        projectId: PROJECT_ID,
        sessionId: 'qa-session', roundId: 'round-1', question: '2026年预算多少？', startedAt: 3,
      })
      const version = await fixture.repository.saveQaAnswerVersion({
        projectId: PROJECT_ID,
        operationId: 'final-op',
        roundId: 'round-1',
        sessionId: 'qa-session',
        stage: 'final',
        questionRevision: 2,
        questionSnapshot: '2026年预算多少？',
        questionIdentity: '2026年预算多少？',
        answer: preset.answer,
        retrievalRoute: 'preset_qa_exact',
        sources: [source],
        elapsedMs: 8,
        createdAt: 4,
      })
      await fixture.repository.commitQaRound({
        projectId: PROJECT_ID,
        roundId: 'round-1',
        selectedAnswerVersionId: version.versionId,
        sessionId: 'qa-session',
        turn: {
          id: 'turn-1',
          question: '2026年预算多少？',
          answer: preset.answer,
          sourceIds: [preset.id],
          answerOrigin: 'final',
          createdAt: 5,
        },
      })

      expect(fixture.store.getQaRound('round-1')).toMatchObject({
        status: 'completed',
        questionPreview: '2026年预算多少？',
        selectedAnswerVersionId: version.versionId,
      })
      expect(changes.map((event) => event.dataRevision)).toEqual([1, 2, 3, 4])
      expect(changes.every((event) => event.projectId === PROJECT_ID)).toBe(true)
      expect(changes.at(-1)).toMatchObject({ roundId: 'round-1', answerVersionId: version.versionId })
      expect(fixture.store.integrityCheck()).toBe('ok')
    } finally {
      fixture.store.close()
    }
  })

  it('does not report a committed transaction as failed when a workspace listener throws', async () => {
    const fixture = repositoryFixture({
      indexPending: vi.fn(),
      onWorkspaceChanged: () => { throw new Error('renderer gone') },
    })
    try {
      prepareQaProject(fixture.store)
      fixture.store.createSession({ id: 'qa-listener', projectId: PROJECT_ID, mode: 'qa', audioSource: 'system', startedAt: 1 })
      await expect(fixture.repository.ensureQaRound({
        projectId: PROJECT_ID,
        sessionId: 'qa-listener', roundId: 'round-listener', question: '请问预算是多少？', startedAt: 2,
      })).resolves.toMatchObject({ dataRevision: 1 })
      expect(fixture.store.getQaRound('round-listener')).toMatchObject({ status: 'active' })
    } finally {
      fixture.store.close()
    }
  })
})
