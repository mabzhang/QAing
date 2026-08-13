import type { ProjectChangedEvent, ProjectTaskPage } from '../core/contracts'

export const PROJECT_TASK_PAGE_LIMIT = 20

export type ProjectTaskPageDisposition = 'accept' | 'refresh' | 'reject'
export type ProjectRefreshPairDisposition = 'accept' | 'retry' | 'reject'
export type ProjectChangedEventDisposition = 'refresh' | 'coalesce' | 'reject'

export function projectEventAffectsActiveSelection(
  eventProjectId: string,
  activeProjectId: string | null,
): boolean {
  return activeProjectId === null || eventProjectId === activeProjectId
}

/**
 * Reject malformed/stale IPC events before they can poison the monotonic
 * revision floor. Equal revisions are meaningful for in-memory run progress,
 * but a second event already covered by the pending refresh is coalesced.
 */
export function projectChangedEventDisposition(
  event: Pick<ProjectChangedEvent, 'projectId' | 'dataRevision'>,
  observedRevision: number,
  pendingRevision: number | null,
): ProjectChangedEventDisposition {
  if (
    typeof event.projectId !== 'string' || event.projectId.length === 0
    || !Number.isSafeInteger(event.dataRevision) || event.dataRevision < 0
    || !Number.isSafeInteger(observedRevision) || observedRevision < 0
    || (pendingRevision !== null && (!Number.isSafeInteger(pendingRevision) || pendingRevision < 0))
  ) return 'reject'
  if (event.dataRevision < observedRevision) return 'reject'
  if (pendingRevision !== null && event.dataRevision <= pendingRevision) return 'coalesce'
  return 'refresh'
}

/** A summary and its first task page form one renderer-visible revision. */
export function projectRefreshPairDisposition(
  stateRevision: number,
  pageRevision: number,
  observedRevision: number,
): ProjectRefreshPairDisposition {
  if (
    !Number.isSafeInteger(stateRevision) || stateRevision < 0
    || !Number.isSafeInteger(pageRevision) || pageRevision < 0
    || !Number.isSafeInteger(observedRevision) || observedRevision < 0
  ) return 'reject'
  if (stateRevision < observedRevision || pageRevision < observedRevision || stateRevision !== pageRevision) {
    return 'retry'
  }
  return 'accept'
}

/**
 * Project task pages use the same monotonic revision fence as the QA
 * workspace. A page from an older revision must never replace a newer project
 * summary; a newer revision invalidates the cursor and therefore requires a
 * first-page refresh instead of being appended to stale rows.
 */
export function projectTaskPageDisposition(
  page: Pick<ProjectTaskPage, 'dataRevision'>,
  requestRevision: number,
  observedRevision: number,
): ProjectTaskPageDisposition {
  if (!Number.isSafeInteger(page.dataRevision) || page.dataRevision < 0) return 'reject'
  if (page.dataRevision < requestRevision || requestRevision < observedRevision) return 'reject'
  if (page.dataRevision > requestRevision) return 'refresh'
  return 'accept'
}

export function appendProjectTaskPage(
  current: ProjectTaskPage | null,
  incoming: ProjectTaskPage,
): ProjectTaskPage {
  if (current === null || current.dataRevision !== incoming.dataRevision) return incoming
  const known = new Set(current.items.map((item) => item.id))
  return {
    ...incoming,
    items: [...current.items, ...incoming.items.filter((item) => !known.has(item.id))],
  }
}
