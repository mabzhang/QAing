import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { SourceReference } from '../../core/types'
import {
  DataStore,
  MAX_QA_ANSWER_CHARACTERS,
  MAX_QA_ANSWER_VERSIONS,
  MAX_QA_WORKSPACE_PAGE_BYTES,
  MAX_QA_WORKSPACE_PAGE_SIZE,
} from './database'
import { applyMigrations, latestSchemaVersion } from './migrations'

const PROJECT_ID = 'workspace-project'

function createQaSession(
  store: DataStore,
  input: { readonly id: string; readonly audioSource: 'microphone' | 'system'; readonly startedAt: number },
): void {
  if (!store.getProject(PROJECT_ID)) {
    store.createProjectManifest({
      id: PROJECT_ID,
      displayName: '工作台项目',
      rootPath: '/tmp/qaing-workspace-project',
      rootIdentity: 'workspace-root',
      schemaVersion: 1,
    }, 0)
  }
  store.createSession({ ...input, projectId: PROJECT_ID, mode: 'qa' })
}

function presetReference(id: string, answer: string): SourceReference {
  return {
    id,
    documentId: `preset:${id}`,
    title: '预设问题',
    kind: 'preset_qa',
    excerpt: answer,
    score: 1,
  }
}

describe('QA workspace canonical persistence', () => {
  it('backfills legacy turns without claiming a verified origin or retrieval route', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-v5-legacy-'))
    const databasePath = join(directory, 'legacy.sqlite')
    const legacy = new Database(databasePath)
    try {
      applyMigrations(legacy, 1, 4)
      legacy.prepare(
        `INSERT INTO sessions(id, mode, audio_source, status, started_at)
         VALUES ('s1', 'qa', 'microphone', 'complete', 10)`,
      ).run()
      legacy.prepare(
        `INSERT INTO turns(id, session_id, ordinal, question, answer, source_ids_json, created_at)
         VALUES ('t1', 's1', 0, '旧问题', '旧答案', '["unverified"]', 20)`,
      ).run()
    } finally {
      legacy.close()
    }

    const store = new DataStore(databasePath)
    try {
      expect(store.schemaVersion()).toBe(latestSchemaVersion)
      expect(store.getRecentTurns('s1')).toEqual([
        expect.objectContaining({
          id: 't1',
          roundId: 'legacy_round_t1',
          answerOrigin: 'legacy_committed',
          selectedAnswerVersionId: 'legacy_version_t1',
        }),
      ])
      const page = store.getLegacyQaWorkspacePage()
      expect(page.items[0]).toMatchObject({
        id: 'legacy_round_t1',
        status: 'completed',
        selectedAnswerVersionId: 'legacy_version_t1',
        versions: [{ stage: 'legacy_committed', retrievalRoute: 'legacy_unknown', isSelected: true }],
      })
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('saves complete versions idempotently and commits the selected version with its turn atomically', () => {
    const store = new DataStore(':memory:')
    try {
      createQaSession(store, { id: 'session', audioSource: 'system', startedAt: 1 })
      const preset = store.upsertPresetQa({ question: '营收多少？', answer: '100万元。' }, 2).record
      store.ensureQaRound({ projectId: PROJECT_ID, sessionId: 'session', roundId: 'round', question: '营收', startedAt: 3 })
      expect(store.ensureQaRound({
        projectId: PROJECT_ID,
        sessionId: 'session', roundId: 'round', question: '营收多少？', startedAt: 999,
      })).toMatchObject({ questionPreview: '营收多少？', startedAt: 3 })
      const previewRevision = store.qaWorkspaceDataRevision(PROJECT_ID)
      store.ensureQaRound({ projectId: PROJECT_ID, sessionId: 'session', roundId: 'round', question: '营收多少？', startedAt: 1_000 })
      expect(store.qaWorkspaceDataRevision(PROJECT_ID)).toBe(previewRevision)
      const source = presetReference(preset.id, preset.answer)
      const candidate = store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'candidate-op',
        roundId: 'round',
        sessionId: 'session',
        stage: 'candidate',
        questionRevision: 1,
        questionSnapshot: '营收多少？',
        questionIdentity: 'identity-1',
        answer: preset.answer,
        retrievalRoute: 'preset_qa_exact',
        sources: [source],
        elapsedMs: 120,
        createdAt: 4,
      })
      expect(candidate).toMatchObject({ inserted: true, dataRevision: previewRevision + 1 })
      expect(store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'candidate-op',
        roundId: 'round',
        sessionId: 'session',
        stage: 'candidate',
        questionRevision: 1,
        questionSnapshot: '营收多少？',
        questionIdentity: 'identity-1',
        answer: preset.answer,
        retrievalRoute: 'preset_qa_exact',
        sources: [source],
        elapsedMs: 999,
        createdAt: 999,
      })).toMatchObject({ versionId: candidate.versionId, inserted: false, dataRevision: previewRevision + 1 })
      expect(store.getQaRound('round')?.versions[0]).toMatchObject({ elapsedMs: 120, createdAt: 4 })
      expect(() => store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'candidate-op',
        roundId: 'round',
        sessionId: 'session',
        stage: 'candidate',
        questionRevision: 2,
        questionSnapshot: '净利润多少？',
        questionIdentity: 'identity-2',
        answer: preset.answer,
        retrievalRoute: 'preset_qa_semantic',
        sources: [source],
        elapsedMs: 140,
        createdAt: 5,
      })).toThrow(/conflicting/)

      const final = store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'final-op',
        roundId: 'round',
        sessionId: 'session',
        stage: 'final',
        questionRevision: 1,
        questionSnapshot: '营收多少？',
        questionIdentity: 'identity-1',
        answer: preset.answer,
        retrievalRoute: 'preset_qa_exact',
        sources: [source],
        elapsedMs: 180,
        createdAt: 6,
      })
      expect(final.version.answerUnchanged).toBe(true)

      expect(() => store.commitQaRound({ projectId: PROJECT_ID,
        roundId: 'round',
        selectedAnswerVersionId: final.versionId,
        turn: {
          id: 'turn', sessionId: 'session', question: '营收多少？', answer: '伪造答案',
          sourceIds: [preset.id], answerOrigin: 'final', createdAt: 7,
        },
      })).toThrow(/does not match/)
      expect(store.getRecentTurns('session')).toEqual([])
      expect(store.getQaRound('round')?.status).toBe('answer_locked')

      const committed = store.commitQaRound({ projectId: PROJECT_ID,
        roundId: 'round',
        selectedAnswerVersionId: final.versionId,
        turn: {
          id: 'turn', sessionId: 'session', question: '营收多少？', answer: preset.answer,
          sourceIds: [preset.id], answerOrigin: 'final', createdAt: 7,
        },
      })
      expect(committed.round).toMatchObject({ status: 'completed', selectedAnswerVersionId: final.versionId })
      expect(committed.round.versions.map((version) => [version.id, version.isSelected, version.isSuperseded])).toEqual([
        [candidate.versionId, false, true],
        [final.versionId, true, false],
      ])
      expect(committed.turn).toMatchObject({
        roundId: 'round', answerOrigin: 'final', selectedAnswerVersionId: final.versionId,
      })
      expect(() => store.ensureQaRound({
        projectId: PROJECT_ID,
        sessionId: 'session', roundId: 'round', question: '成交额多少？', startedAt: 8,
      })).toThrow(/closed/)
      expect(store.commitQaRound({ projectId: PROJECT_ID,
        roundId: 'round',
        selectedAnswerVersionId: final.versionId,
        turn: {
          id: 'turn', sessionId: 'session', question: '营收多少？', answer: preset.answer,
          sourceIds: [preset.id], answerOrigin: 'final', createdAt: 7,
        },
      })).toMatchObject({ dataRevision: committed.dataRevision })
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('bounds full versions and sources, closes rounds idempotently, and interrupts open rounds on restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-round-recovery-'))
    const databasePath = join(directory, 'qaing.sqlite')
    let store = new DataStore(databasePath)
    try {
      createQaSession(store, { id: 'session', audioSource: 'microphone', startedAt: 1 })
      const preset = store.upsertPresetQa({ question: '问题？', answer: '完整答案' }, 2).record
      const source = presetReference(preset.id, preset.answer)
      store.ensureQaRound({ projectId: PROJECT_ID, sessionId: 'session', roundId: 'open', question: '问题？', startedAt: 3 })
      expect(() => store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'empty', roundId: 'open', sessionId: 'session', stage: 'candidate', questionRevision: 1,
        questionSnapshot: '问题？', questionIdentity: 'id', answer: '', retrievalRoute: 'preset_qa_exact',
        sources: [source], elapsedMs: 1, createdAt: 4,
      })).toThrow(/empty/)
      expect(() => store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'no-source', roundId: 'open', sessionId: 'session', stage: 'candidate', questionRevision: 1,
        questionSnapshot: '问题？', questionIdentity: 'id', answer: preset.answer,
        retrievalRoute: 'preset_qa_exact', sources: [], elapsedMs: 1, createdAt: 4,
      })).toThrow(/source/)
      const longAnswer = '证'.repeat(2_000)
      const longPreset = store.upsertPresetQa({ question: '长答案问题？', answer: longAnswer }, 5).record
      expect(store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'long-answer', roundId: 'open', sessionId: 'session', stage: 'candidate',
        questionRevision: 0, questionSnapshot: '长答案问题？', questionIdentity: 'long-answer',
        answer: longAnswer, retrievalRoute: 'preset_qa_exact',
        sources: [{ ...presetReference(longPreset.id, longAnswer), excerpt: `${longAnswer.slice(0, 1_599)}…` }],
        elapsedMs: 1, createdAt: 5,
      })).toMatchObject({ inserted: true })
      for (let ordinal = 1; ordinal < MAX_QA_ANSWER_VERSIONS - 1; ordinal += 1) {
        store.saveQaAnswerVersion({ projectId: PROJECT_ID,
          operationId: `candidate-${ordinal}`, roundId: 'open', sessionId: 'session', stage: 'candidate',
          questionRevision: ordinal, questionSnapshot: `问题 ${ordinal}？`, questionIdentity: `id-${ordinal}`,
          answer: preset.answer, retrievalRoute: 'preset_qa_semantic', sources: [source], elapsedMs: ordinal,
          createdAt: 10 + ordinal,
        })
      }
      expect(() => store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'candidate-overflow', roundId: 'open', sessionId: 'session', stage: 'candidate',
        questionRevision: MAX_QA_ANSWER_VERSIONS - 1, questionSnapshot: '候选溢出？',
        questionIdentity: 'candidate-overflow', answer: preset.answer,
        retrievalRoute: 'preset_qa_semantic', sources: [source], elapsedMs: 19, createdAt: 29,
      })).toThrow(/candidate-version capacity/)
      const final = store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'bounded-final', roundId: 'open', sessionId: 'session', stage: 'final',
        questionRevision: MAX_QA_ANSWER_VERSIONS - 2,
        questionSnapshot: `问题 ${MAX_QA_ANSWER_VERSIONS - 2}？`,
        questionIdentity: `id-${MAX_QA_ANSWER_VERSIONS - 2}`, answer: preset.answer,
        retrievalRoute: 'preset_qa_semantic', sources: [source], elapsedMs: 20, createdAt: 30,
      })
      expect(final.version.ordinal).toBe(MAX_QA_ANSWER_VERSIONS - 1)
      expect(() => store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'overflow', roundId: 'open', sessionId: 'session', stage: 'final', questionRevision: 8,
        questionSnapshot: '溢出？', questionIdentity: 'overflow', answer: preset.answer,
        retrievalRoute: 'preset_qa_semantic', sources: [source], elapsedMs: 21, createdAt: 31,
      })).toThrow(/answer-locked/)
      store.close()

      store = new DataStore(databasePath)
      const recovered = store.getQaRound('open')
      expect(recovered?.status).toBe('interrupted')
      expect(typeof recovered?.completedAt).toBe('number')
      expect(store.getQaRound('open')?.versions).toHaveLength(MAX_QA_ANSWER_VERSIONS)
      const retry = store.closeQaRound({ projectId: PROJECT_ID, roundId: 'open', status: 'interrupted', completedAt: 99 })
      expect(retry.dataRevision).toBe(store.qaWorkspaceDataRevision(PROJECT_ID))
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('marks an actually open round interrupted after an unclean restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-open-round-recovery-'))
    const databasePath = join(directory, 'qaing.sqlite')
    let store = new DataStore(databasePath)
    try {
      createQaSession(store, { id: 'session', audioSource: 'microphone', startedAt: 1 })
      const preset = store.upsertPresetQa({ question: '崩溃恢复？', answer: '已保存的完整候选答案。' }, 2).record
      store.ensureQaRound({ projectId: PROJECT_ID, sessionId: 'session', roundId: 'open', question: '崩溃恢复？', startedAt: 3 })
      store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'saved-before-crash', roundId: 'open', sessionId: 'session', stage: 'candidate',
        questionRevision: 1, questionSnapshot: '崩溃恢复？', questionIdentity: 'crash-recovery',
        answer: preset.answer, retrievalRoute: 'preset_qa_exact', sources: [presetReference(preset.id, preset.answer)],
        elapsedMs: 100, createdAt: 4,
      })
      store.close()

      store = new DataStore(databasePath)
      const recovered = store.getQaRound('open')
      expect(recovered).toMatchObject({ status: 'interrupted', selectedAnswerVersionId: null })
      expect(recovered?.versions).toEqual([
        expect.objectContaining({ answer: preset.answer, isSelected: false, isSuperseded: true }),
      ])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('pages newest-first with an opaque cursor and never returns more than twenty rounds', () => {
    const store = new DataStore(':memory:')
    try {
      createQaSession(store, { id: 'session', audioSource: 'system', startedAt: 1 })
      for (let index = 0; index < MAX_QA_WORKSPACE_PAGE_SIZE + 3; index += 1) {
        const id = `round-${String(index).padStart(2, '0')}`
        store.ensureQaRound({ projectId: PROJECT_ID, sessionId: 'session', roundId: id, question: `问题 ${index}`, startedAt: index + 10 })
        store.closeQaRound({ projectId: PROJECT_ID, roundId: id, status: 'skipped', completedAt: index + 20 })
      }
      const first = store.getQaWorkspacePage({ projectId: PROJECT_ID, limit: 999 })
      expect(first.items).toHaveLength(MAX_QA_WORKSPACE_PAGE_SIZE)
      expect(first.items[0]?.id).toBe('round-22')
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{55}$/u)
      expect(Buffer.from(first.nextCursor as string, 'base64url')).toHaveLength(41)
      const second = store.getQaWorkspacePage({ projectId: PROJECT_ID, cursor: first.nextCursor, limit: 20 })
      expect(second.items.map((round) => round.id)).toEqual(['round-02', 'round-01', 'round-00'])
      expect(second.nextCursor).toBeNull()
      expect(() => store.getQaWorkspacePage({ projectId: PROJECT_ID, cursor: 'not_valid!' })).toThrow('Invalid workspace cursor')
    } finally {
      store.close()
    }
  })

  it('pages one thousand equal-timestamp rounds without duplicates, gaps, or text-sized cursors', () => {
    const store = new DataStore(':memory:')
    try {
      createQaSession(store, { id: 'thousand-session', audioSource: 'system', startedAt: 1 })
      for (let index = 0; index < 1_000; index += 1) {
        const roundId = `thousand-round-${String(index).padStart(4, '0')}`
        store.ensureQaRound({
          projectId: PROJECT_ID,
          sessionId: 'thousand-session', roundId, question: `问题 ${index}`, startedAt: 1_000,
        })
        store.closeQaRound({ projectId: PROJECT_ID, roundId, status: 'skipped', completedAt: 2_000 })
      }
      const startedAt = performance.now()
      const ids: string[] = []
      let cursor: string | null | undefined
      do {
        const page = store.getQaWorkspacePage({ projectId: PROJECT_ID, ...(cursor ? { cursor } : {}), limit: 20 })
        expect(page.totalRounds).toBe(1_000)
        expect(page.items.length).toBeLessThanOrEqual(20)
        if (page.nextCursor !== null) expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]{55}$/u)
        ids.push(...page.items.map((round) => round.id))
        cursor = page.nextCursor
      } while (cursor)
      expect(ids).toHaveLength(1_000)
      expect(new Set(ids).size).toBe(1_000)
      expect(ids[0]).toBe('thousand-round-0999')
      expect(ids.at(-1)).toBe('thousand-round-0000')
      expect(performance.now() - startedAt).toBeLessThan(1_000)
    } finally {
      store.close()
    }
  }, 30_000)

  it('migrates long legacy turn IDs and pages every round with a fixed-size row cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-v5-long-legacy-id-'))
    const databasePath = join(directory, 'legacy.sqlite')
    const legacy = new Database(databasePath)
    try {
      applyMigrations(legacy, 1, 4)
      legacy.prepare(
        `INSERT INTO sessions(id, mode, audio_source, status, started_at)
         VALUES ('legacy-session', 'qa', 'microphone', 'complete', 1)`,
      ).run()
      const insert = legacy.prepare(
        `INSERT INTO turns(id, session_id, ordinal, question, answer, source_ids_json, created_at)
         VALUES (?, 'legacy-session', ?, ?, ?, '[]', ?)`,
      )
      for (let index = 0; index < 21; index += 1) {
        insert.run(
          index === 1 ? 'x'.repeat(220) : `legacy-turn-${index}`,
          index,
          `历史问题 ${index}`,
          `历史答案 ${index}`,
          index + 10,
        )
      }
    } finally {
      legacy.close()
    }

    const store = new DataStore(databasePath)
    try {
      const first = store.getLegacyQaWorkspacePage({ limit: 20 })
      expect(first.items).toHaveLength(20)
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{55}$/u)
      const second = store.getLegacyQaWorkspacePage({ cursor: first.nextCursor, limit: 20 })
      const ids = [...first.items, ...second.items].map((round) => round.id)
      expect(ids).toHaveLength(21)
      expect(new Set(ids).size).toBe(21)
      expect(ids.some((id) => id === `legacy_round_${'x'.repeat(220)}`)).toBe(true)
      expect(second.nextCursor).toBeNull()
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails open for an oversized legacy answer through a bounded view without changing SQLite facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-v5-oversized-legacy-answer-'))
    const databasePath = join(directory, 'legacy.sqlite')
    const oversizedAnswer = '旧'.repeat(MAX_QA_WORKSPACE_PAGE_BYTES + 100_000)
    const legacy = new Database(databasePath)
    try {
      applyMigrations(legacy, 1, 4)
      legacy.prepare(
        `INSERT INTO sessions(id, mode, audio_source, status, started_at)
         VALUES ('legacy-large-session', 'qa', 'system', 'complete', 1)`,
      ).run()
      legacy.prepare(
        `INSERT INTO turns(id, session_id, ordinal, question, answer, source_ids_json, created_at)
         VALUES ('legacy-large-turn', 'legacy-large-session', 0, '超大历史问题', ?, '[]', 2)`,
      ).run(oversizedAnswer)
    } finally {
      legacy.close()
    }

    const store = new DataStore(databasePath)
    try {
      const page = store.getLegacyQaWorkspacePage()
      expect(page.items).toHaveLength(1)
      const displayed = page.items[0]?.versions[0]?.answer ?? ''
      expect([...displayed]).toHaveLength(MAX_QA_ANSWER_CHARACTERS)
      expect(displayed.endsWith('…')).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(MAX_QA_WORKSPACE_PAGE_BYTES)

      const inspector = new Database(databasePath, { readonly: true })
      try {
        const raw = inspector.prepare(
          `SELECT length(answer) AS character_count, answer = ? AS identical
           FROM qa_answer_versions WHERE stage = 'legacy_committed'`,
        ).get(oversizedAnswer) as { character_count: number; identical: number }
        expect(raw).toEqual({ character_count: oversizedAnswer.length, identical: 1 })
      } finally {
        inspector.close()
      }
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps large complete rounds intact while bounding every serialized workspace page', () => {
    const store = new DataStore(':memory:')
    try {
      createQaSession(store, { id: 'bounded-page-session', audioSource: 'system', startedAt: 1 })
      const answer = '答'.repeat(MAX_QA_ANSWER_CHARACTERS)
      const sourceContent = '据'.repeat(1_600)
      const document = store.upsertDocument({
        title: '资'.repeat(300),
        kind: 'text',
        content: Array.from({ length: 8 }, (_, index) => `${index}${sourceContent}`).join('\n'),
        chunks: Array.from({ length: 8 }, (_, index) => ({ content: `${index}${sourceContent}`, tokenCount: 512 })),
      }, 2).document
      const sources: readonly SourceReference[] = store.listChunks(document.id).map((chunk) => ({
        id: chunk.id,
        documentId: document.id,
        title: document.title,
        kind: 'source_document',
        excerpt: sourceContent,
        score: 1,
      }))
      expect(sources).toHaveLength(8)
      for (let roundOrdinal = 0; roundOrdinal < 20; roundOrdinal += 1) {
        const roundId = `large-round-${roundOrdinal}`
        store.ensureQaRound({
          projectId: PROJECT_ID,
          sessionId: 'bounded-page-session',
          roundId,
          question: `轮次 ${roundOrdinal} 的大页面预设问题？`,
          startedAt: 1_000 + roundOrdinal,
        })
        for (let version = 0; version < MAX_QA_ANSWER_VERSIONS; version += 1) {
          store.saveQaAnswerVersion({ projectId: PROJECT_ID,
            operationId: `large-${roundOrdinal}-${version}`,
            roundId,
            sessionId: 'bounded-page-session',
            stage: version === MAX_QA_ANSWER_VERSIONS - 1 ? 'final' : 'candidate',
            questionRevision: version,
            questionSnapshot: `轮次 ${roundOrdinal} 的大页面预设问题？`,
            questionIdentity: `large-question-${roundOrdinal}-${version}`,
            answer,
            retrievalRoute: 'source_document',
            sources,
            elapsedMs: version,
            createdAt: 2_000 + roundOrdinal * MAX_QA_ANSWER_VERSIONS + version,
          })
        }
      }
      store.ensureQaRound({
        projectId: PROJECT_ID,
        sessionId: 'bounded-page-session', roundId: 'too-long', question: '超限答案？', startedAt: 9_999,
      })
      expect(() => store.saveQaAnswerVersion({ projectId: PROJECT_ID,
        operationId: 'too-long-answer', roundId: 'too-long', sessionId: 'bounded-page-session',
        stage: 'candidate', questionRevision: 1, questionSnapshot: '超限答案？', questionIdentity: 'too-long',
        answer: `${answer}多`, retrievalRoute: 'source_document', sources, elapsedMs: 1, createdAt: 10_000,
      })).toThrow(/16000-character limit/)
      expect(store.getQaRound('too-long')?.versions).toEqual([])

      const startedAt = performance.now()
      const rounds = []
      let cursor: string | null | undefined
      do {
        const page = store.getQaWorkspacePage({ projectId: PROJECT_ID, ...(cursor ? { cursor } : {}), limit: 20 })
        expect(page.totalRounds).toBe(21)
        expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(MAX_QA_WORKSPACE_PAGE_BYTES)
        for (const round of page.items) {
          if (round.id === 'too-long') continue
          expect(round.versions).toHaveLength(MAX_QA_ANSWER_VERSIONS)
          expect(round.versions.every((version) => version.answer === answer)).toBe(true)
        }
        rounds.push(...page.items)
        cursor = page.nextCursor
      } while (cursor)
      const elapsedMs = performance.now() - startedAt
      expect(rounds).toHaveLength(21)
      expect(new Set(rounds.map((round) => round.id)).size).toBe(21)
      expect(elapsedMs).toBeLessThan(1_500)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  }, 30_000)

  it('rolls back the entire version write when escaped JSON would exceed the single-round budget', () => {
    const store = new DataStore(':memory:')
    try {
      createQaSession(store, { id: 'escaped-budget-session', audioSource: 'system', startedAt: 1 })
      const document = store.upsertDocument({
        title: '边界资料', kind: 'text', content: '证据',
        chunks: Array.from({ length: 8 }, (_, index) => ({ content: `证据 ${index}`, tokenCount: 3 })),
      }).document
      const sources: readonly SourceReference[] = store.listChunks(document.id).map((chunk) => ({
        id: chunk.id,
        documentId: document.id,
        title: '\u0001'.repeat(300),
        kind: 'source_document',
        excerpt: '\u0001'.repeat(1_600),
        score: 1,
      }))
      store.ensureQaRound({
        projectId: PROJECT_ID,
        sessionId: 'escaped-budget-session', roundId: 'escaped-budget-round', question: '序列化边界？', startedAt: 2,
      })
      let rejected = false
      for (let version = 0; version < MAX_QA_ANSWER_VERSIONS; version += 1) {
        const beforeRound = store.getQaRound('escaped-budget-round')
        const beforeRevision = store.qaWorkspaceDataRevision(PROJECT_ID)
        try {
          store.saveQaAnswerVersion({ projectId: PROJECT_ID,
            operationId: `escaped-${version}`,
            roundId: 'escaped-budget-round',
            sessionId: 'escaped-budget-session',
            stage: version === MAX_QA_ANSWER_VERSIONS - 1 ? 'final' : 'candidate',
            questionRevision: version,
            questionSnapshot: '序列化边界？',
            questionIdentity: `escaped-${version}`,
            answer: '\u0001'.repeat(MAX_QA_ANSWER_CHARACTERS),
            retrievalRoute: 'source_document',
            sources,
            elapsedMs: version,
            createdAt: 10 + version,
          })
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toMatch(/page byte budget/)
          expect(store.getQaRound('escaped-budget-round')).toEqual(beforeRound)
          expect(store.qaWorkspaceDataRevision(PROJECT_ID)).toBe(beforeRevision)
          rejected = true
          break
        }
      }
      expect(rejected).toBe(true)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  }, 30_000)
})
