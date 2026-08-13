import { describe, expect, it, vi } from 'vitest'
import type { QaWorkspacePage, QaWorkspaceRound } from '../../core/types'
import { QaWorkspaceRuntime } from './qa-workspace'

describe('QaWorkspaceRuntime', () => {
  it('loads bounded pages outside the public snapshot and publishes only lightweight changes', async () => {
    const page: QaWorkspacePage = {
      projectId: 'project-1', totalRounds: 0, items: [], nextCursor: null, dataRevision: 4,
    }
    const store = {
      getProject: vi.fn(() => ({ displayName: 'Project 1' })),
      getQaWorkspacePage: vi.fn(() => page),
      deleteQaWorkspaceRound: vi.fn(() => ({ deleted: false, dataRevision: 4 })),
      clearQaWorkspaceProject: vi.fn(() => ({ deletedRounds: 0, deletedTurns: 0, dataRevision: 4 })),
      beginQaWorkspaceExport: vi.fn(() => ({ projectId: 'project-1', snapshotRevision: 4 })),
      getQaWorkspaceExportPage: vi.fn(() => page),
    }
    const runtime = new QaWorkspaceRuntime(store)
    const listener = vi.fn()
    const unsubscribe = runtime.subscribe(listener)

    await expect(runtime.getPage({ projectId: 'project-1', limit: 20 })).resolves.toBe(page)
    expect(store.getQaWorkspacePage).toHaveBeenCalledWith({ projectId: 'project-1', limit: 20 })

    const event = { projectId: 'project-1', dataRevision: 5, roundId: 'round-1', answerVersionId: 'answer-2' }
    runtime.notify(event)
    expect(listener).toHaveBeenCalledWith(event)

    unsubscribe()
    runtime.notify({ projectId: 'project-1', dataRevision: 6, roundId: 'round-2', answerVersionId: null })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('deletes and clears only the requested project and publishes its new revision', async () => {
    const store = {
      getProject: vi.fn(() => ({ displayName: 'Project 1' })),
      getQaWorkspacePage: vi.fn(() => ({ projectId: 'project-1', totalRounds: 0, items: [], nextCursor: null, dataRevision: 9 })),
      deleteQaWorkspaceRound: vi.fn(() => ({ deleted: true, dataRevision: 10 })),
      clearQaWorkspaceProject: vi.fn(() => ({ deletedRounds: 3, deletedTurns: 3, dataRevision: 11 })),
      beginQaWorkspaceExport: vi.fn(() => ({ projectId: 'project-1', snapshotRevision: 11 })),
      getQaWorkspaceExportPage: vi.fn(),
    }
    const runtime = new QaWorkspaceRuntime(store)
    const listener = vi.fn()
    runtime.subscribe(listener)

    await expect(runtime.deleteRound('project-1', 'round-1')).resolves.toEqual({ deleted: true, dataRevision: 10 })
    await expect(runtime.clearProject('project-1')).resolves.toEqual({ deletedRounds: 3, deletedTurns: 3, dataRevision: 11 })
    expect(store.deleteQaWorkspaceRound).toHaveBeenCalledWith({ projectId: 'project-1', roundId: 'round-1' })
    expect(store.clearQaWorkspaceProject).toHaveBeenCalledWith('project-1')
    expect(listener).toHaveBeenNthCalledWith(1, {
      projectId: 'project-1', dataRevision: 10, roundId: 'round-1', answerVersionId: null,
    })
    expect(listener).toHaveBeenNthCalledWith(2, {
      projectId: 'project-1', dataRevision: 11, roundId: null, answerVersionId: null,
    })
  })

  it('keeps committed mutations successful when one subscriber is stale', async () => {
    const store = {
      getProject: vi.fn(() => ({ displayName: 'Project 1' })),
      getQaWorkspacePage: vi.fn(),
      deleteQaWorkspaceRound: vi.fn(() => ({ deleted: true, dataRevision: 10 })),
      clearQaWorkspaceProject: vi.fn(() => ({ deletedRounds: 2, deletedTurns: 2, dataRevision: 11 })),
      beginQaWorkspaceExport: vi.fn(),
      getQaWorkspaceExportPage: vi.fn(),
    }
    const runtime = new QaWorkspaceRuntime(store)
    const healthy = vi.fn()
    runtime.subscribe(() => { throw new Error('DESTROYED_RENDERER') })
    runtime.subscribe(healthy)

    await expect(runtime.deleteRound('project-1', 'round-1')).resolves.toEqual({ deleted: true, dataRevision: 10 })
    await expect(runtime.clearProject('project-1')).resolves.toEqual({
      deletedRounds: 2, deletedTurns: 2, dataRevision: 11,
    })
    expect(healthy).toHaveBeenNthCalledWith(1, {
      projectId: 'project-1', dataRevision: 10, roundId: 'round-1', answerVersionId: null,
    })
    expect(healthy).toHaveBeenNthCalledWith(2, {
      projectId: 'project-1', dataRevision: 11, roundId: null, answerVersionId: null,
    })
  })

  it('exports every revision-pinned page for one project without leaking another project', async () => {
    const round = (id: string, marker: string): QaWorkspaceRound => ({
      id,
      sessionId: `session-${id}`,
      ordinal: 0,
      status: 'completed',
      questionPreview: `问题 ${marker}`,
      startedAt: 100,
      completedAt: 200,
      selectedAnswerVersionId: `${id}-answer`,
      versions: [{
        id: `${id}-answer`,
        roundId: id,
        ordinal: 0,
        stage: 'final',
        questionRevision: 1,
        questionSnapshot: `问题 ${marker}`,
        questionIdentity: `问题 ${marker}`,
        answer: `答案 ${marker}`,
        retrievalRoute: 'preset_qa_exact',
        sources: [],
        elapsedMs: 10,
        createdAt: 150,
        isSelected: true,
        isSuperseded: false,
        answerUnchanged: false,
      }],
    })
    const firstPage: QaWorkspacePage = {
      projectId: 'project-a', totalRounds: 2, items: [round('round-a1', 'A_ONLY_1')], nextCursor: 'cursor-a', dataRevision: 7,
    }
    const secondPage: QaWorkspacePage = {
      projectId: 'project-a', totalRounds: 2, items: [round('round-a2', 'A_ONLY_2')], nextCursor: null, dataRevision: 7,
    }
    let exported = ''
    const store = {
      getProject: vi.fn((id: string) => id === 'project-a' ? { displayName: 'A 项目' } : null),
      getQaWorkspacePage: vi.fn(),
      deleteQaWorkspaceRound: vi.fn(),
      clearQaWorkspaceProject: vi.fn(),
      beginQaWorkspaceExport: vi.fn(() => ({ projectId: 'project-a', snapshotRevision: 7 })),
      getQaWorkspaceExportPage: vi.fn((input: { cursor?: string | null }) => input.cursor ? secondPage : firstPage),
    }
    const runtime = new QaWorkspaceRuntime(store, {
      save: async (_name, chunks) => {
        for await (const chunk of chunks) exported += chunk
      },
    })

    await runtime.exportProject('project-a')

    expect(exported).toContain('A_ONLY_1')
    expect(exported).toContain('A_ONLY_2')
    expect(exported).not.toContain('B_ONLY')
    expect(store.getQaWorkspaceExportPage).toHaveBeenNthCalledWith(1, {
      projectId: 'project-a', snapshotRevision: 7, limit: 20,
    })
    expect(store.getQaWorkspaceExportPage).toHaveBeenNthCalledWith(2, {
      projectId: 'project-a', snapshotRevision: 7, cursor: 'cursor-a', limit: 20,
    })
  })
})
