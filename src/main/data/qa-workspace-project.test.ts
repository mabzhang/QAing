import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DataStore } from './database'
import { applyMigrations } from './migrations'

const stores: DataStore[] = []
const directories: string[] = []

function project(id: string): {
  readonly id: string
  readonly displayName: string
  readonly rootPath: string
  readonly rootIdentity: string
  readonly schemaVersion: number
} {
  return {
    id,
    displayName: id,
    rootPath: `/tmp/${id}`,
    rootIdentity: `root-${id}`,
    schemaVersion: 1,
  }
}

function fixture(): DataStore {
  const store = new DataStore(':memory:')
  stores.push(store)
  store.createProjectManifest(project('project-a'), 1)
  store.createProjectManifest(project('project-b'), 1)
  return store
}

function createSession(store: DataStore, projectId: string, sessionId: string, startedAt = 1): void {
  store.createSession({
    id: sessionId,
    projectId,
    mode: 'qa',
    audioSource: 'system',
    startedAt,
  })
}

function closedRound(
  store: DataStore,
  projectId: string,
  sessionId: string,
  roundId: string,
  startedAt: number,
): void {
  store.ensureQaRound({ projectId, sessionId, roundId, question: `Question ${roundId}`, startedAt })
  store.closeQaRound({ projectId, roundId, status: 'skipped', completedAt: startedAt + 1 })
}

function completedRound(
  store: DataStore,
  projectId: string,
  sessionId: string,
  roundId: string,
  startedAt: number,
): void {
  const answer = `Answer ${roundId}`
  const preset = store.upsertPresetQa({ question: `Question ${roundId}`, answer }, startedAt).record
  const source = {
    id: preset.id,
    documentId: `preset:${preset.id}`,
    title: 'Preset QA',
    kind: 'preset_qa' as const,
    excerpt: answer,
    score: 1,
  }
  store.ensureQaRound({ projectId, sessionId, roundId, question: `Question ${roundId}`, startedAt })
  const final = store.saveQaAnswerVersion({
    projectId,
    operationId: `operation-${roundId}`,
    roundId,
    sessionId,
    stage: 'final',
    questionRevision: 1,
    questionSnapshot: `Question ${roundId}`,
    questionIdentity: `identity-${roundId}`,
    answer,
    retrievalRoute: 'preset_qa_exact',
    sources: [source],
    elapsedMs: 1,
    createdAt: startedAt + 1,
  })
  store.commitQaRound({
    projectId,
    roundId,
    selectedAnswerVersionId: final.versionId,
    turn: {
      id: `turn-${roundId}`,
      sessionId,
      question: `Question ${roundId}`,
      answer,
      sourceIds: [preset.id],
      answerOrigin: 'final',
      createdAt: startedAt + 2,
    },
  })
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('project-scoped QA workspace persistence', () => {
  it('requires project ownership and transactionally fences active-project switching', () => {
    const store = fixture()
    expect(() => store.createSession({
      id: 'unscoped', mode: 'qa', audioSource: 'system', startedAt: 1,
    })).toThrow(/projectId/)

    store.setActiveProject('project-a')
    expect(store.createSessionForActiveProject({
      id: 'active-a', mode: 'qa', audioSource: 'system', startedAt: 2,
    })).toMatchObject({ projectId: 'project-a' })
    expect(() => store.setActiveProject('project-b')).toThrow(/session is active/)
    expect(store.getActiveProjectId()).toBe('project-a')
    expect(() => store.deleteQaWorkspaceRound({ projectId: 'project-a', roundId: 'missing' }))
      .toThrow(/session is active/)
    expect(() => store.clearQaWorkspaceProject('project-a')).toThrow(/session is active/)

    expect(store.endSession('active-a')).toBe(true)
    expect(() => store.setActiveProject('project-b')).not.toThrow()
  })

  it('recovers a crashed session with no round so it cannot permanently lock project switching', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-v7-session-recovery-'))
    directories.push(directory)
    const path = join(directory, 'workspace.sqlite3')
    let store = new DataStore(path)
    store.createProjectManifest(project('project-a'), 1)
    store.createProjectManifest(project('project-b'), 1)
    store.setActiveProject('project-a')
    store.createSessionForActiveProject({ id: 'crashed', mode: 'qa', audioSource: 'system', startedAt: 2 })
    store.close()

    store = new DataStore(path)
    stores.push(store)
    expect(store.getSession('crashed')).toMatchObject({ status: 'interrupted' })
    expect(store.getSession('crashed')?.endedAt).not.toBeNull()
    expect(() => store.setActiveProject('project-b')).not.toThrow()
  })

  it('rejects a cross-project round even when a caller bypasses DataStore', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-v7-project-guard-'))
    directories.push(directory)
    const path = join(directory, 'workspace.sqlite3')
    const store = new DataStore(path)
    store.createProjectManifest(project('project-a'), 1)
    store.createProjectManifest(project('project-b'), 1)
    createSession(store, 'project-a', 'session-a')
    store.close()

    const raw = new Database(path)
    try {
      raw.pragma('foreign_keys = ON')
      expect(() => raw.prepare(
        `INSERT INTO qa_rounds(
           id, session_id, ordinal, status, question_preview, started_at, completed_at,
           selected_answer_version_id, project_id
         ) VALUES ('cross-project', 'session-a', 0, 'active', 'Question', 2, NULL, NULL, 'project-b')`,
      ).run()).toThrow(/QA_WORKSPACE_PROJECT_MISMATCH/)
      expect((raw.prepare('SELECT COUNT(*) AS count FROM qa_rounds').get() as { count: number }).count).toBe(0)
    } finally {
      raw.close()
    }
  })

  it('isolates pages, binds cursors to project and revision, and restores history after switching back', () => {
    const store = fixture()
    createSession(store, 'project-a', 'session-a')
    createSession(store, 'project-b', 'session-b')
    for (let index = 0; index < 21; index += 1) {
      closedRound(store, 'project-a', 'session-a', `a-${String(index).padStart(2, '0')}`, 10 + index)
    }
    closedRound(store, 'project-b', 'session-b', 'b-only', 100)

    const aFirst = store.getQaWorkspacePage({ projectId: 'project-a', limit: 20 })
    expect(aFirst.projectId).toBe('project-a')
    expect(aFirst.totalRounds).toBe(21)
    expect(aFirst.items).toHaveLength(20)
    expect(aFirst.items.every((round) => round.id.startsWith('a-'))).toBe(true)
    expect(aFirst.nextCursor).not.toBeNull()
    expect(() => store.getQaWorkspacePage({
      projectId: 'project-b', cursor: aFirst.nextCursor, limit: 20,
    })).toThrow('QA_WORKSPACE_CURSOR_STALE')
    const bPage = store.getQaWorkspacePage({ projectId: 'project-b' })
    expect(bPage.projectId).toBe('project-b')
    expect(bPage.totalRounds).toBe(1)
    expect(bPage.items.map((round) => round.id)).toEqual(['b-only'])
    closedRound(store, 'project-b', 'session-b', 'b-new', 101)

    const aSecond = store.getQaWorkspacePage({
      projectId: 'project-a', cursor: aFirst.nextCursor, limit: 20,
    })
    expect(aSecond.totalRounds).toBe(21)
    expect(aSecond.items.map((round) => round.id)).toEqual(['a-00'])

    closedRound(store, 'project-a', 'session-a', 'a-new', 200)
    expect(() => store.getQaWorkspacePage({
      projectId: 'project-a', cursor: aFirst.nextCursor, limit: 20,
    })).toThrow('QA_WORKSPACE_CURSOR_STALE')
  })

  it('deletes and clears only terminal history in the requested project', () => {
    const store = fixture()
    createSession(store, 'project-a', 'session-a')
    createSession(store, 'project-b', 'session-b')
    completedRound(store, 'project-a', 'session-a', 'a-delete', 10)
    completedRound(store, 'project-a', 'session-a', 'a-keep', 20)
    completedRound(store, 'project-b', 'session-b', 'b-keep', 30)
    store.endSession('session-a')
    store.endSession('session-b')

    expect(() => store.deleteQaWorkspaceRound({ projectId: 'project-b', roundId: 'a-delete' }))
      .toThrow(/does not belong/)
    expect(store.deleteQaWorkspaceRound({ projectId: 'project-a', roundId: 'a-delete' })).toMatchObject({
      deleted: true,
    })
    expect(store.getRecentProjectTurns('project-a', 'session-a').map((turn) => turn.id)).toEqual(['turn-a-keep'])
    expect(store.getRecentProjectTurns('project-b', 'session-b').map((turn) => turn.id)).toEqual(['turn-b-keep'])
    expect(store.getQaWorkspacePage({ projectId: 'project-a' }).items.map((round) => round.id)).toEqual(['a-keep'])
    expect(store.getQaWorkspacePage({ projectId: 'project-b' }).items.map((round) => round.id)).toEqual(['b-keep'])

    expect(store.clearQaWorkspaceProject('project-a')).toMatchObject({ deletedRounds: 1 })
    const cleared = store.getQaWorkspacePage({ projectId: 'project-a' })
    expect(cleared).toMatchObject({ totalRounds: 0, items: [] })
    expect(store.getRecentProjectTurns('project-a', 'session-a')).toEqual([])
    expect(store.getQaWorkspacePage({ projectId: 'project-b' }).items.map((round) => round.id)).toEqual(['b-keep'])
    expect(store.integrityCheck()).toBe('ok')
  })

  it('rolls back a project clear when any round is still open', () => {
    const store = fixture()
    createSession(store, 'project-a', 'session-a')
    closedRound(store, 'project-a', 'session-a', 'closed', 10)
    store.ensureQaRound({
      projectId: 'project-a', sessionId: 'session-a', roundId: 'open', question: 'Still open?', startedAt: 20,
    })
    store.endSession('session-a')

    const revision = store.qaWorkspaceDataRevision('project-a')
    expect(() => store.clearQaWorkspaceProject('project-a')).toThrow(/open QA round/)
    expect(store.qaWorkspaceDataRevision('project-a')).toBe(revision)
    expect(store.getQaWorkspacePage({ projectId: 'project-a' }).items.map((round) => round.id))
      .toEqual(['open', 'closed'])
  })

  it('exports through a bounded revision-pinned page reader', () => {
    const store = fixture()
    createSession(store, 'project-a', 'session-a')
    for (let index = 0; index < 21; index += 1) {
      closedRound(store, 'project-a', 'session-a', `export-${String(index).padStart(2, '0')}`, 10 + index)
    }
    const snapshot = store.beginQaWorkspaceExport('project-a')
    const first = store.getQaWorkspaceExportPage({ ...snapshot, limit: 20 })
    expect(first.projectId).toBe('project-a')
    expect(first.totalRounds).toBe(21)
    expect(first.items).toHaveLength(20)
    expect(first.nextCursor).not.toBeNull()
    const second = store.getQaWorkspaceExportPage({ ...snapshot, cursor: first.nextCursor, limit: 20 })
    expect(second.totalRounds).toBe(21)
    expect(second.items).toHaveLength(1)

    closedRound(store, 'project-a', 'session-a', 'export-new', 100)
    expect(() => store.getQaWorkspaceExportPage({
      ...snapshot, cursor: first.nextCursor, limit: 20,
    })).toThrow('QA_WORKSPACE_CURSOR_STALE')
  })

  it('keeps migrated legacy history unassigned until an explicit whole-session transaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-v7-legacy-project-'))
    directories.push(directory)
    const path = join(directory, 'legacy.sqlite3')
    const legacy = new Database(path)
    try {
      applyMigrations(legacy, 1, 4)
      legacy.prepare(
        `INSERT INTO sessions(id, mode, audio_source, status, started_at, ended_at)
         VALUES ('legacy-session', 'qa', 'system', 'complete', 1, 3)`,
      ).run()
      legacy.prepare(
        `INSERT INTO turns(id, session_id, ordinal, question, answer, source_ids_json, created_at)
         VALUES ('legacy-turn', 'legacy-session', 0, 'Legacy question', 'Legacy answer', '[]', 2)`,
      ).run()
    } finally {
      legacy.close()
    }

    const store = new DataStore(path)
    stores.push(store)
    store.createProjectManifest(project('project-a'), 10)
    const legacyPage = store.getLegacyQaWorkspacePage()
    expect(legacyPage.projectId).toBeNull()
    expect(legacyPage.totalRounds).toBe(1)
    expect(legacyPage.items.map((round) => round.id)).toEqual(['legacy_round_legacy-turn'])
    expect(store.getQaWorkspacePage({ projectId: 'project-a' }).items).toEqual([])

    expect(store.assignLegacyQaSessionToProject({
      sessionId: 'legacy-session', projectId: 'project-a',
    })).toMatchObject({ rounds: 1, turns: 1, versions: 1 })
    expect(store.getLegacyQaWorkspacePage().items).toEqual([])
    expect(store.getQaWorkspacePage({ projectId: 'project-a' }).items.map((round) => round.id))
      .toEqual(['legacy_round_legacy-turn'])
    expect(() => store.assignLegacyQaSessionToProject({
      sessionId: 'legacy-session', projectId: 'project-a',
    })).toThrow(/already assigned/)
    expect(store.integrityCheck()).toBe('ok')
  })
})
