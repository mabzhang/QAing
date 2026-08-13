import { describe, expect, it } from 'vitest'
import type { QaAnswerVersion, QaWorkspacePage, QaWorkspaceRound } from '../../core/types'
import {
  advanceWorkspaceRevisionFloor,
  answerVersionLabel,
  appendWorkspacePage,
  elapsedAnswerLabel,
  mergeWorkspaceRefresh,
  orderedAnswerVersions,
  orderedWorkspaceRounds,
  resolveVersionView,
  resolveWorkspaceExport,
  retrievalRoutePresentation,
  workspaceCursorMatchesRevisionFloor,
  workspaceEventAdvancesRevisionFloor,
  workspaceEventMatchesProject,
  workspaceLoadMoreDisposition,
  workspaceMutationRequiresRefresh,
  workspacePageMeetsRevisionFloor,
  workspacePageMatchesProject,
  workspaceSelectionIsCurrent,
  workspaceRevisionIsValid,
} from './qa-workspace'

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver
    reject = rejecter
  })
  return { promise, resolve, reject }
}

function version(patch: Partial<QaAnswerVersion> = {}): QaAnswerVersion {
  return {
    id: 'version-1',
    roundId: 'round-1',
    ordinal: 0,
    stage: 'candidate',
    questionRevision: 1,
    questionSnapshot: '问题',
    questionIdentity: '问题',
    answer: '答案',
    retrievalRoute: 'preset_qa_semantic',
    sources: [],
    elapsedMs: 5_650,
    createdAt: 100,
    isSelected: false,
    isSuperseded: false,
    answerUnchanged: false,
    ...patch,
  }
}

function round(patch: Partial<QaWorkspaceRound> = {}): QaWorkspaceRound {
  return {
    id: 'round-1',
    sessionId: 'session-1',
    ordinal: 1,
    status: 'active',
    questionPreview: '问题',
    startedAt: 100,
    completedAt: null,
    selectedAnswerVersionId: null,
    versions: [],
    ...patch,
  }
}

function page(items: readonly QaWorkspaceRound[], nextCursor: string | null = null): QaWorkspacePage {
  return { projectId: 'project-1', totalRounds: items.length, items, nextCursor, dataRevision: 1 }
}

describe('QA workspace presentation and paging', () => {
  it('requires the response project identity to match the requested workspace', () => {
    expect(workspaceRevisionIsValid(0)).toBe(true)
    expect(workspaceRevisionIsValid(Number.POSITIVE_INFINITY)).toBe(false)
    expect(workspacePageMatchesProject(page([]), 'project-1')).toBe(true)
    expect(workspacePageMatchesProject({ ...page([]), projectId: 'project-2' }, 'project-1')).toBe(false)
    expect(workspacePageMatchesProject({ ...page([]), projectId: null }, 'project-1')).toBe(false)
    expect(workspacePageMatchesProject({ ...page([]), totalRounds: -1 }, 'project-1')).toBe(false)
    expect(workspacePageMatchesProject({ ...page([round({})]), totalRounds: 0 }, 'project-1')).toBe(false)
  })

  it('rejects responses from an old project generation after switching away and back', () => {
    expect(workspaceSelectionIsCurrent('project-a', 4, 'project-a', 4)).toBe(true)
    expect(workspaceSelectionIsCurrent('project-a', 4, 'project-b', 5)).toBe(false)
    expect(workspaceSelectionIsCurrent('project-a', 4, 'project-a', 6)).toBe(false)
    expect(workspaceSelectionIsCurrent('project-a', Number.NaN, 'project-a', Number.NaN)).toBe(false)
    expect(workspaceEventMatchesProject({ projectId: 'project-a', dataRevision: 9 }, 'project-a')).toBe(true)
    expect(workspaceEventMatchesProject({ projectId: 'project-a', dataRevision: 9 }, 'project-b')).toBe(false)
    expect(workspaceEventMatchesProject({ projectId: 'project-a', dataRevision: Number.NaN }, 'project-a')).toBe(false)
  })

  it('coalesces the mutation result and matching workspace event at one revision', () => {
    expect(workspaceEventAdvancesRevisionFloor(
      { projectId: 'project-a', dataRevision: 10 },
      'project-a',
      9,
    )).toBe(true)
    expect(workspaceEventAdvancesRevisionFloor(
      { projectId: 'project-a', dataRevision: 10 },
      'project-a',
      10,
    )).toBe(false)
    expect(workspaceEventAdvancesRevisionFloor(
      { projectId: 'project-a', dataRevision: 9 },
      'project-a',
      10,
    )).toBe(false)
    expect(workspaceEventAdvancesRevisionFloor(
      { projectId: 'project-b', dataRevision: 11 },
      'project-a',
      10,
    )).toBe(false)

    // Result-first schedules one refresh and makes the later equal event a
    // no-op. Event-first already has a refresh in flight, so the equal result
    // must not schedule a second one.
    expect(workspaceMutationRequiresRefresh(10, 9)).toBe(true)
    expect(workspaceMutationRequiresRefresh(10, 10)).toBe(false)
    expect(workspaceMutationRequiresRefresh(10, 11)).toBe(false)
    expect(workspaceMutationRequiresRefresh(Number.NaN, 9)).toBe(false)
  })

  it('turns export rejection into a safe visible outcome without exposing its message', async () => {
    const outcome = await resolveWorkspaceExport(() => Promise.reject(
      new Error('/Users/private/project secret.md'),
    ))
    expect(outcome).toBe('failed')
    expect(JSON.stringify(outcome)).not.toContain('/Users/private')
    await expect(resolveWorkspaceExport(() => Promise.resolve())).resolves.toBe('exported')
  })

  it('labels semantic answer milestones without fixed 15/30 second checkpoints', () => {
    expect(answerVersionLabel(version())).toBe('首次候选')
    expect(answerVersionLabel(version({ ordinal: 1 }))).toBe('更新 2')
    expect(answerVersionLabel(version({ stage: 'final' }))).toBe('最终')
    expect(answerVersionLabel(version({ stage: 'candidate_fallback' }))).toBe('候选降级答案')
    expect(elapsedAnswerLabel(5_650)).toBe('+5.7秒')
    expect(retrievalRoutePresentation('preset_qa_semantic').label).toBe('预设 QA 近义命中')
    expect(retrievalRoutePresentation('source_document').label).toBe('文档补充')
  })

  it('renders migrated records as unverified history rather than a final or document answer', () => {
    expect(answerVersionLabel(version({ stage: 'legacy_committed' }))).toBe('历史答案')
    expect(retrievalRoutePresentation('legacy_unknown')).toEqual({
      label: '旧版记录',
      detail: '升级前已保存，生成路径未记录',
      tone: 'legacy',
    })
  })

  it('orders versions oldest first and puts the active round first', () => {
    const target = round({
      versions: [
        version({ id: 'v3', ordinal: 2, createdAt: 300 }),
        version({ id: 'v1', ordinal: 0, createdAt: 100 }),
        version({ id: 'v2', ordinal: 1, createdAt: 200 }),
      ],
    })
    expect(orderedAnswerVersions(target).map((item) => item.id)).toEqual(['v1', 'v2', 'v3'])
    expect(orderedWorkspaceRounds(page([
      target,
      round({ id: 'round-active', startedAt: 50 }),
    ]), 'round-active').map((item) => item.id)).toEqual(['round-active', 'round-1'])
  })

  it('does not move a user off an older version when a newer complete version arrives', () => {
    const target = round({
      versions: [
        version({ id: 'v1', ordinal: 0, createdAt: 100 }),
        version({ id: 'v2', ordinal: 1, createdAt: 200 }),
      ],
    })
    expect(resolveVersionView(target, 'v1')).toMatchObject({
      selected: { id: 'v1' },
      latest: { id: 'v2' },
      hasNewer: true,
    })
    expect(resolveVersionView(target, null)).toMatchObject({
      selected: { id: 'v2' },
      latest: { id: 'v2' },
      hasNewer: false,
    })
  })

  it('sorts different sessions by startedAt before their reset ordinals', () => {
    const oldSessionHighOrdinal = round({
      id: 'old-session-round-93',
      sessionId: 'old-session',
      ordinal: 93,
      startedAt: 1_000,
    })
    const newSessionFirstRound = round({
      id: 'new-session-round-1',
      sessionId: 'new-session',
      ordinal: 1,
      startedAt: 2_000,
    })
    expect(orderedWorkspaceRounds(page([
      oldSessionHighOrdinal,
      newSessionFirstRound,
    ]), null).map((item) => item.id)).toEqual(['new-session-round-1', 'old-session-round-93'])
  })

  it('refreshes the first page without losing an already loaded older tail', () => {
    const first = page([
      round({ id: 'round-3', startedAt: 300 }),
      round({ id: 'round-2', startedAt: 200 }),
    ], 'cursor-2')
    const loaded = appendWorkspacePage(first, page([
      round({ id: 'round-2', startedAt: 200 }),
      round({ id: 'round-1', startedAt: 100 }),
    ], null))
    const refreshed = mergeWorkspaceRefresh(loaded, {
      ...page([
        round({ id: 'round-4', startedAt: 400 }),
        round({ id: 'round-3', startedAt: 300 }),
      ], 'cursor-3'),
      dataRevision: 2,
    })
    expect(refreshed.items.map((item) => item.id)).toEqual(['round-4', 'round-3', 'round-2', 'round-1'])
    expect(refreshed.nextCursor).toBe('cursor-3')
    expect(refreshed.dataRevision).toBe(2)
  })

  it('drops stale loaded tails when a newer revision reports fewer project rounds', () => {
    const current = {
      ...page([
        round({ id: 'round-3' }),
        round({ id: 'round-deleted' }),
        round({ id: 'round-1' }),
      ], null),
      totalRounds: 3,
      dataRevision: 4,
    }
    const afterDelete = {
      ...page([round({ id: 'round-3' }), round({ id: 'round-1' })], null),
      totalRounds: 2,
      dataRevision: 5,
    }
    expect(mergeWorkspaceRefresh(current, afterDelete)).toBe(afterDelete)
    expect(mergeWorkspaceRefresh(current, afterDelete).items.map((item) => item.id)).not.toContain('round-deleted')
  })

  it('never merges or appends rounds from another project', () => {
    const current = page([round({ id: 'project-1-round' })], 'cursor')
    const other = {
      ...page([round({ id: 'project-2-round' })]),
      projectId: 'project-2',
      dataRevision: 2,
    }
    expect(mergeWorkspaceRefresh(current, other)).toBe(other)
    expect(appendWorkspacePage(current, other)).toBe(current)
    expect(appendWorkspacePage(current, { ...current, totalRounds: 9 })).toBe(current)
  })

  it('rejects an out-of-order first-page response instead of rolling back newer answers', () => {
    const current = {
      ...page([round({
        id: 'round-current',
        versions: [version({ id: 'new-version', answer: '新答案' })],
      })]),
      dataRevision: 7,
    }
    const stale = {
      ...page([round({
        id: 'round-current',
        versions: [version({ id: 'old-version', answer: '旧答案' })],
      })]),
      dataRevision: 6,
    }
    expect(mergeWorkspaceRefresh(current, stale)).toBe(current)
  })

  it('rejects a deferred old first page after a newer change even when the follow-up refresh fails', async () => {
    const oldResponse = deferred<QaWorkspacePage>()
    const followUp = deferred<QaWorkspacePage>()
    let floor = advanceWorkspaceRevisionFloor(5, 7)
    let rendered: QaWorkspacePage | null = null

    const publishIfCurrent = async (response: Promise<QaWorkspacePage>): Promise<void> => {
      const result = await response
      if (!workspacePageMeetsRevisionFloor(result, floor)) return
      floor = advanceWorkspaceRevisionFloor(floor, result.dataRevision)
      rendered = mergeWorkspaceRefresh(rendered, result)
    }
    const oldTask = publishIfCurrent(oldResponse.promise)
    oldResponse.resolve({
      projectId: 'project-1',
      totalRounds: 1,
      items: [round({
        id: 'current-round',
        versions: [version({ id: 'stale-candidate', answer: '不得回显的旧候选' })],
      })],
      nextCursor: null,
      dataRevision: 6,
    })
    await oldTask
    expect(rendered).toBeNull()

    const followUpTask = publishIfCurrent(followUp.promise).catch(() => undefined)
    followUp.reject(new Error('refresh unavailable'))
    await followUpTask
    expect(rendered).toBeNull()
    expect(floor).toBe(7)
  })

  it('rejects an old load-more response instead of masking it with the current revision', async () => {
    const loadMore = deferred<QaWorkspacePage>()
    const current = {
      ...page([round({ id: 'newest-round', startedAt: 500 })], 'cursor-older'),
      dataRevision: 11,
    }
    let rendered = current
    const task = loadMore.promise.then((result) => {
      if (!workspacePageMeetsRevisionFloor(result, current.dataRevision)) return
      rendered = appendWorkspacePage(rendered, result)
    })
    loadMore.resolve({
      projectId: 'project-1',
      totalRounds: 2,
      items: [round({ id: 'stale-older-round', startedAt: 100 })],
      nextCursor: null,
      dataRevision: 10,
    })
    await task

    expect(rendered).toBe(current)
    expect(rendered.items.map((item) => item.id)).not.toContain('stale-older-round')
  })

  it('accepts a continuation page only at the exact revision that produced its cursor', () => {
    expect(workspaceCursorMatchesRevisionFloor({ dataRevision: 10 }, 10)).toBe(true)
    expect(workspaceCursorMatchesRevisionFloor({ dataRevision: 10 }, 11)).toBe(false)
    expect(workspaceCursorMatchesRevisionFloor({ dataRevision: Number.NaN }, 10)).toBe(false)
    expect(workspaceLoadMoreDisposition({ dataRevision: 10 }, 10, 10)).toBe('append')
    expect(workspaceLoadMoreDisposition({ dataRevision: 9 }, 10, 10)).toBe('reject')
    expect(workspaceLoadMoreDisposition({ dataRevision: 10 }, 10, 11)).toBe('reject')
    expect(workspaceLoadMoreDisposition({ dataRevision: 11 }, 10, 10)).toBe('refresh')
    expect(workspaceLoadMoreDisposition({ dataRevision: Number.NaN }, 10, 10)).toBe('reject')
  })

  it('keeps the rendered leading page when load-more observes a newer revision and refresh fails', async () => {
    const loadMore = deferred<QaWorkspacePage>()
    const refresh = deferred<QaWorkspacePage>()
    const current = {
      ...page([round({
        id: 'current-round',
        versions: [version({ id: 'visible-version', answer: '已显示的完整答案' })],
      })], 'cursor-revision-10'),
      dataRevision: 10,
    }
    let floor = current.dataRevision
    let rendered = current
    let refreshRequested = false

    const loadMoreTask = loadMore.promise.then((result) => {
      const disposition = workspaceLoadMoreDisposition(result, current.dataRevision, floor)
      if (disposition === 'append') rendered = appendWorkspacePage(rendered, result)
      if (disposition === 'refresh') {
        floor = advanceWorkspaceRevisionFloor(floor, result.dataRevision)
        refreshRequested = true
      }
    })
    loadMore.resolve({
      projectId: 'project-1',
      totalRounds: 2,
      items: [round({ id: 'older-round', startedAt: 1 })],
      nextCursor: null,
      dataRevision: 11,
    })
    await loadMoreTask

    expect(refreshRequested).toBe(true)
    expect(floor).toBe(11)
    expect(rendered).toBe(current)
    expect(rendered.dataRevision).toBe(10)
    expect(rendered.items[0]?.versions[0]?.answer).toBe('已显示的完整答案')

    const refreshTask = refresh.promise.then((result) => {
      if (!workspacePageMeetsRevisionFloor(result, floor)) return
      rendered = mergeWorkspaceRefresh(rendered, result)
    }).catch(() => undefined)
    refresh.reject(new Error('first-page refresh unavailable'))
    await refreshTask

    expect(rendered).toBe(current)
    expect(rendered.items.map((item) => item.id)).not.toContain('older-round')
  })
})
