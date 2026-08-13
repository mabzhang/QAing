export const ANSWER_PANEL_MIN_HEIGHT = 210
export const ANSWER_PANEL_DEFAULT_HEIGHT = 320
export const ANSWER_PANEL_MAX_HEIGHT = 620
export const ANSWER_PANEL_RESIZE_STEP = 16

export function clampAnswerPanelHeight(height: number): number {
  if (!Number.isFinite(height)) return ANSWER_PANEL_DEFAULT_HEIGHT
  return Math.min(ANSWER_PANEL_MAX_HEIGHT, Math.max(ANSWER_PANEL_MIN_HEIGHT, Math.round(height)))
}

export function answerPanelHeightForKey(current: number, key: string): number | null {
  switch (key) {
    case 'ArrowUp':
      return clampAnswerPanelHeight(current + ANSWER_PANEL_RESIZE_STEP)
    case 'ArrowDown':
      return clampAnswerPanelHeight(current - ANSWER_PANEL_RESIZE_STEP)
    case 'PageUp':
      return clampAnswerPanelHeight(current + ANSWER_PANEL_RESIZE_STEP * 4)
    case 'PageDown':
      return clampAnswerPanelHeight(current - ANSWER_PANEL_RESIZE_STEP * 4)
    case 'Home':
      return ANSWER_PANEL_MIN_HEIGHT
    case 'End':
      return ANSWER_PANEL_MAX_HEIGHT
    default:
      return null
  }
}
