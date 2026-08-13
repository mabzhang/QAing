import type {
  QaAnswerVersion,
  QaWorkspaceChanged,
  QaWorkspacePage,
  QaWorkspaceRound,
  RetrievalRoute,
} from '../../core/types'

export const QA_WORKSPACE_PAGE_LIMIT = 20

export function workspaceRevisionIsValid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export function workspaceSelectionIsCurrent(
  requestProjectId: string,
  requestGeneration: number,
  currentProjectId: string | null,
  currentGeneration: number,
): boolean {
  return requestProjectId.length > 0
    && requestProjectId === currentProjectId
    && workspaceRevisionIsValid(requestGeneration)
    && requestGeneration === currentGeneration
}

export function workspaceEventMatchesProject(
  event: Pick<QaWorkspaceChanged, 'projectId' | 'dataRevision'>,
  projectId: string | null,
): boolean {
  return projectId !== null
    && event.projectId === projectId
    && workspaceRevisionIsValid(event.dataRevision)
}

/**
 * Change events are hints that a strictly newer durable workspace revision is
 * available. Mutations can produce both an IPC result and the matching event;
 * once that revision is already observed, replaying the event must not flash
 * the loading state or issue a duplicate first-page request.
 */
export function workspaceEventAdvancesRevisionFloor(
  event: Pick<QaWorkspaceChanged, 'projectId' | 'dataRevision'>,
  projectId: string | null,
  revisionFloor: number,
): boolean {
  return workspaceEventMatchesProject(event, projectId)
    && event.dataRevision > advanceWorkspaceRevisionFloor(0, revisionFloor)
}

/** A mutation response needs its own refresh only when no matching/newer event
 * has already advanced the observed floor. This makes result-first and
 * event-first delivery converge without duplicate loading transitions. */
export function workspaceMutationRequiresRefresh(
  mutationRevision: number,
  revisionFloor: number,
): boolean {
  return workspaceRevisionIsValid(mutationRevision)
    && mutationRevision > advanceWorkspaceRevisionFloor(0, revisionFloor)
}

export function workspacePageMatchesProject(
  page: Pick<QaWorkspacePage, 'projectId' | 'totalRounds' | 'items'>,
  projectId: string,
): boolean {
  return projectId.length > 0
    && page.projectId === projectId
    && workspaceRevisionIsValid(page.totalRounds)
    && page.items.length <= page.totalRounds
}

/**
 * Workspace revisions are emitted by the canonical SQLite writer before the
 * renderer asks for the corresponding page. Keep the greatest revision we
 * have observed so an older in-flight IPC response can never become visible
 * after a newer change notification.
 */
export function advanceWorkspaceRevisionFloor(current: number, observed: number): number {
  const safeCurrent = Number.isSafeInteger(current) && current >= 0 ? current : 0
  if (!workspaceRevisionIsValid(observed)) return safeCurrent
  return Math.max(safeCurrent, observed)
}

export function workspacePageMeetsRevisionFloor(
  page: Pick<QaWorkspacePage, 'dataRevision'>,
  revisionFloor: number,
): boolean {
  return workspaceRevisionIsValid(page.dataRevision)
    && page.dataRevision >= advanceWorkspaceRevisionFloor(0, revisionFloor)
}

/**
 * A continuation cursor belongs to the revision of the rendered page that
 * produced it. Do not issue a continuation request while a newer revision is
 * only observed but has not yet replaced that leading page.
 */
export function workspaceCursorMatchesRevisionFloor(
  page: Pick<QaWorkspacePage, 'dataRevision'>,
  revisionFloor: number,
): boolean {
  return workspaceRevisionIsValid(page.dataRevision)
    && page.dataRevision === advanceWorkspaceRevisionFloor(0, revisionFloor)
}

export type WorkspaceLoadMoreDisposition = 'append' | 'refresh' | 'reject'

/**
 * A continuation cursor is valid only for the exact workspace revision that
 * produced it. A newer response means a lightweight change notification was
 * delayed or lost: refreshing page one is the only way to avoid labelling an
 * old leading page with the newer revision. Older or malformed responses are
 * always rejected.
 */
export function workspaceLoadMoreDisposition(
  page: Pick<QaWorkspacePage, 'dataRevision'>,
  requestRevisionFloor: number,
  observedRevisionFloor: number,
): WorkspaceLoadMoreDisposition {
  const requestFloor = advanceWorkspaceRevisionFloor(0, requestRevisionFloor)
  const observedFloor = advanceWorkspaceRevisionFloor(requestFloor, observedRevisionFloor)
  if (!workspaceRevisionIsValid(page.dataRevision) || page.dataRevision < observedFloor) return 'reject'
  if (page.dataRevision > requestFloor) return 'refresh'
  return page.dataRevision === requestFloor ? 'append' : 'reject'
}

export interface RetrievalRoutePresentation {
  readonly label: string
  readonly detail: string
  readonly tone: 'exact' | 'semantic' | 'document' | 'legacy'
}

export function retrievalRoutePresentation(route: RetrievalRoute): RetrievalRoutePresentation {
  switch (route) {
    case 'preset_qa_exact':
      return { label: '预设 QA 精确命中', detail: '直接采用预设问答', tone: 'exact' }
    case 'preset_qa_semantic':
      return { label: '预设 QA 近义命中', detail: '语义匹配预设问答', tone: 'semantic' }
    case 'source_document':
      return { label: '文档补充', detail: '未命中预设 QA，基于原始资料', tone: 'document' }
    case 'legacy_unknown':
      return { label: '旧版记录', detail: '升级前已保存，生成路径未记录', tone: 'legacy' }
  }
}

export function answerVersionLabel(version: QaAnswerVersion): string {
  if (version.stage === 'legacy_committed') return '历史答案'
  if (version.stage === 'final') return '最终'
  if (version.stage === 'candidate_fallback') return '候选降级答案'
  return version.ordinal === 0 ? '首次候选' : `更新 ${version.ordinal + 1}`
}

export function elapsedAnswerLabel(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return '生成时间未知'
  const seconds = elapsedMs / 1_000
  const formatted = seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()
  return `+${formatted}秒`
}

export function orderedAnswerVersions(round: QaWorkspaceRound): readonly QaAnswerVersion[] {
  return [...round.versions].sort((left, right) => (
    left.ordinal - right.ordinal || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ))
}

export interface ResolvedVersionView {
  readonly selected: QaAnswerVersion | null
  readonly latest: QaAnswerVersion | null
  readonly hasNewer: boolean
}

export function resolveVersionView(
  round: QaWorkspaceRound,
  locallySelectedVersionId: string | null,
): ResolvedVersionView {
  const versions = orderedAnswerVersions(round)
  const latest = versions.at(-1) ?? null
  const local = locallySelectedVersionId === null
    ? null
    : versions.find((version) => version.id === locallySelectedVersionId) ?? null
  const serverSelected = versions.find((version) => version.id === round.selectedAnswerVersionId)
    ?? versions.find((version) => version.isSelected)
    ?? latest
  const selected = local ?? serverSelected
  return {
    selected,
    latest,
    hasNewer: local !== null && latest !== null && local.id !== latest.id,
  }
}

export function orderedWorkspaceRounds(
  page: QaWorkspacePage | null,
  activeRoundId: string | null,
): readonly QaWorkspaceRound[] {
  if (page === null) return []
  return [...page.items].sort((left, right) => {
    if (left.id === activeRoundId) return -1
    if (right.id === activeRoundId) return 1
    const startedAtOrder = right.startedAt - left.startedAt
    if (startedAtOrder !== 0) return startedAtOrder
    if (left.sessionId === right.sessionId && left.ordinal !== right.ordinal) {
      return right.ordinal - left.ordinal
    }
    return right.id.localeCompare(left.id)
  })
}

function mergeRounds(
  leading: readonly QaWorkspaceRound[],
  trailing: readonly QaWorkspaceRound[],
): readonly QaWorkspaceRound[] {
  const seen = new Set<string>()
  const merged: QaWorkspaceRound[] = []
  for (const round of [...leading, ...trailing]) {
    if (seen.has(round.id)) continue
    seen.add(round.id)
    merged.push(round)
  }
  return merged
}

/**
 * Refreshes the newest page without discarding older pages that the user may
 * currently be reading. The backend cursor is opaque; once older pages have
 * been loaded we retain their tail cursor and de-duplicate stable round ids.
 */
export function mergeWorkspaceRefresh(
  current: QaWorkspacePage | null,
  refreshed: QaWorkspacePage,
): QaWorkspacePage {
  if (current !== null && current.projectId !== refreshed.projectId) return refreshed
  if (current !== null && refreshed.dataRevision < current.dataRevision) return current
  if (current === null || current.items.length <= refreshed.items.length) return refreshed
  if (refreshed.totalRounds < current.totalRounds) return refreshed
  const revisionChanged = refreshed.dataRevision !== current.dataRevision
  return {
    projectId: refreshed.projectId,
    totalRounds: refreshed.totalRounds,
    items: mergeRounds(refreshed.items, current.items),
    // A cursor is pinned to the revision that created it. After any change,
    // restart paging from the refreshed first-page cursor and de-duplicate the
    // already visible tail instead of relabelling an old cursor as current.
    nextCursor: revisionChanged ? refreshed.nextCursor : current.nextCursor,
    dataRevision: Math.max(current.dataRevision, refreshed.dataRevision),
  }
}

export function appendWorkspacePage(
  current: QaWorkspacePage | null,
  next: QaWorkspacePage,
): QaWorkspacePage {
  if (current === null) return next
  if (current.projectId !== next.projectId) return current
  if (current.dataRevision === next.dataRevision && current.totalRounds !== next.totalRounds) return current
  return {
    projectId: current.projectId,
    totalRounds: current.totalRounds,
    items: mergeRounds(current.items, next.items),
    nextCursor: next.nextCursor,
    dataRevision: Math.max(current.dataRevision, next.dataRevision),
  }
}

export type WorkspaceExportOutcome = 'exported' | 'failed'

/**
 * Convert an untrusted bridge rejection into a bounded UI outcome. The
 * renderer deliberately never displays the thrown message because it may
 * contain a filesystem path; callers must render their fixed safe copy for a
 * failed outcome.
 */
export async function resolveWorkspaceExport(
  action: () => Promise<void>,
): Promise<WorkspaceExportOutcome> {
  try {
    await action()
    return 'exported'
  } catch {
    return 'failed'
  }
}
