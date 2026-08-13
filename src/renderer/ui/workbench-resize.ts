export const WORKBENCH_MIN_WIDTH = 360
export const WORKBENCH_DEFAULT_WIDTH = 420
export const WORKBENCH_MAX_WIDTH = 620
export const WORKBENCH_COLLAPSED_WIDTH = 52
export const WORKBENCH_RESIZE_STEP = 16
export const WORKBENCH_DESKTOP_BREAKPOINT = 1_120
export const WORKBENCH_CENTER_MIN_WIDTH = 400
export const WORKBENCH_LEFT_WIDTH = 246
export const WORKBENCH_HORIZONTAL_CHROME = 52
export const WORKBENCH_STORAGE_KEY = 'qaing.ui.qa-workbench-width'

export interface WorkbenchDragState {
  readonly pointerId: number
  readonly clientX: number
  readonly width: number
}

export function workbenchLayoutMode(viewportWidth: number): 'desktop' | 'sheet' {
  return Number.isFinite(viewportWidth) && viewportWidth >= WORKBENCH_DESKTOP_BREAKPOINT
    ? 'desktop'
    : 'sheet'
}

export function clampWorkbenchPreference(width: number): number {
  if (!Number.isFinite(width)) return WORKBENCH_DEFAULT_WIDTH
  return Math.min(WORKBENCH_MAX_WIDTH, Math.max(WORKBENCH_MIN_WIDTH, Math.round(width)))
}

export function effectiveWorkbenchMaxWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth < WORKBENCH_DESKTOP_BREAKPOINT) {
    return WORKBENCH_MAX_WIDTH
  }
  return Math.max(
    WORKBENCH_MIN_WIDTH,
    Math.min(
      WORKBENCH_MAX_WIDTH,
      Math.floor(
        viewportWidth
        - WORKBENCH_LEFT_WIDTH
        - WORKBENCH_CENTER_MIN_WIDTH
        - WORKBENCH_HORIZONTAL_CHROME,
      ),
    ),
  )
}

export function effectiveWorkbenchWidth(width: number, viewportWidth: number): number {
  return Math.min(clampWorkbenchPreference(width), effectiveWorkbenchMaxWidth(viewportWidth))
}

export function workbenchWidthForKey(
  current: number,
  key: string,
  maxWidth = WORKBENCH_MAX_WIDTH,
): number | null {
  const clamp = (value: number): number => Math.min(maxWidth, clampWorkbenchPreference(value))
  switch (key) {
    case 'ArrowLeft':
      return clamp(current + WORKBENCH_RESIZE_STEP)
    case 'ArrowRight':
      return clamp(current - WORKBENCH_RESIZE_STEP)
    case 'PageUp':
      return clamp(current + WORKBENCH_RESIZE_STEP * 4)
    case 'PageDown':
      return clamp(current - WORKBENCH_RESIZE_STEP * 4)
    case 'Home':
      return WORKBENCH_MIN_WIDTH
    case 'End':
      return maxWidth
    default:
      return null
  }
}

/**
 * Resolves only the pointer that owns the active resize gesture. Callers clear
 * their active state before releasing pointer capture, so a following
 * lostpointercapture event becomes a no-op instead of persisting twice.
 */
export function finalizedWorkbenchDragWidth(
  drag: WorkbenchDragState | null,
  pointerId: number,
  pendingWidth: number,
  maxWidth: number,
): number | null {
  if (drag === null || drag.pointerId !== pointerId) return null
  return Math.min(maxWidth, clampWorkbenchPreference(pendingWidth))
}
