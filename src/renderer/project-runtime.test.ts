import { describe, expect, it } from 'vitest'
import type { ProjectSyncTask, ProjectTaskPage } from '../core/contracts'
import {
  appendProjectTaskPage,
  projectChangedEventDisposition,
  projectEventAffectsActiveSelection,
  projectRefreshPairDisposition,
  projectTaskPageDisposition,
} from './project-runtime'

function task(id: string): ProjectSyncTask {
  return {
    id,
    projectId: 'project-1',
    runId: null,
    relativePath: `原始资料/${id}.md`,
    kind: 'source_document',
    conversionMode: 'local',
    status: 'ready',
    lastGoodAvailable: true,
    requiresAction: false,
    errorCode: null,
    updatedAt: 1,
  }
}

function page(revision: number, ids: readonly string[], nextCursor: string | null): ProjectTaskPage {
  return { items: ids.map(task), nextCursor, dataRevision: revision }
}

describe('project task revision fencing', () => {
  it('ignores background-project events while one project is selected', () => {
    expect(projectEventAffectsActiveSelection('project-1', null)).toBe(true)
    expect(projectEventAffectsActiveSelection('project-1', 'project-1')).toBe(true)
    expect(projectEventAffectsActiveSelection('project-2', 'project-1')).toBe(false)
  })

  it('rejects stale/malformed events and coalesces repeated revisions already awaiting refresh', () => {
    expect(projectChangedEventDisposition({ projectId: 'project-1', dataRevision: 8 }, 7, null)).toBe('refresh')
    expect(projectChangedEventDisposition({ projectId: 'project-1', dataRevision: 8 }, 8, 8)).toBe('coalesce')
    expect(projectChangedEventDisposition({ projectId: 'project-1', dataRevision: 9 }, 8, 8)).toBe('refresh')
    expect(projectChangedEventDisposition({ projectId: 'project-1', dataRevision: 7 }, 8, null)).toBe('reject')
    expect(projectChangedEventDisposition({ projectId: '', dataRevision: 9 }, 8, null)).toBe('reject')
    expect(projectChangedEventDisposition({ projectId: 'project-1', dataRevision: Number.NaN }, 8, null)).toBe('reject')
    expect(projectChangedEventDisposition({ projectId: 'project-1', dataRevision: 9 }, 8, Number.POSITIVE_INFINITY)).toBe('reject')
  })

  it('publishes a project summary and first task page only as one atomic revision', () => {
    expect(projectRefreshPairDisposition(8, 8, 8)).toBe('accept')
    expect(projectRefreshPairDisposition(7, 8, 7)).toBe('retry')
    expect(projectRefreshPairDisposition(8, 7, 8)).toBe('retry')
    expect(projectRefreshPairDisposition(Number.NaN, 8, 8)).toBe('reject')
    expect(projectRefreshPairDisposition(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 8)).toBe('reject')
  })

  it('accepts only the exact revision used to obtain the cursor', () => {
    expect(projectTaskPageDisposition(page(7, [], null), 7, 7)).toBe('accept')
    expect(projectTaskPageDisposition(page(6, [], null), 7, 7)).toBe('reject')
    expect(projectTaskPageDisposition(page(7, [], null), 7, 8)).toBe('reject')
  })

  it('forces a first-page refresh when a load-more response observes a newer revision', () => {
    expect(projectTaskPageDisposition(page(8, [], null), 7, 7)).toBe('refresh')
  })

  it('appends without duplicating task rows and rejects cross-revision merging', () => {
    expect(appendProjectTaskPage(page(3, ['a', 'b'], 'cursor'), page(3, ['b', 'c'], null)).items)
      .toEqual([task('a'), task('b'), task('c')])
    expect(appendProjectTaskPage(page(3, ['a'], 'cursor'), page(4, ['z'], null)))
      .toEqual(page(4, ['z'], null))
  })
})
