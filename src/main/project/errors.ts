import type { ProjectErrorCode } from './types'

export class ProjectSyncError extends Error {
  readonly code: ProjectErrorCode
  readonly retryable: boolean

  constructor(code: ProjectErrorCode, _message: string = code, retryable = false, options?: ErrorOptions) {
    // Error objects can cross generic logging boundaries. Keeping their public
    // message equal to the closed code prevents source text and paths from
    // leaking when an underlying parser/filesystem error is attached as cause.
    void _message
    super(code, options)
    this.name = 'ProjectSyncError'
    this.code = code
    this.retryable = retryable
  }
}

export function asProjectSyncError(error: unknown, fallback: ProjectErrorCode): ProjectSyncError {
  if (error instanceof ProjectSyncError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProjectSyncError('SYNC_CANCELLED', 'Project synchronization was cancelled', false, { cause: error })
  }
  return new ProjectSyncError(fallback, fallback, false, error instanceof Error ? { cause: error } : undefined)
}

export function abortError(signal: AbortSignal): ProjectSyncError {
  const reason = signal.reason as unknown
  if (reason instanceof ProjectSyncError) return reason
  return new ProjectSyncError('SYNC_CANCELLED', 'Project synchronization was cancelled', false,
    reason instanceof Error ? { cause: reason } : undefined)
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}
