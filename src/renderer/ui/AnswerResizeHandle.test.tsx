import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ANSWER_PANEL_DEFAULT_HEIGHT,
  ANSWER_PANEL_MAX_HEIGHT,
  ANSWER_PANEL_MIN_HEIGHT,
  answerPanelHeightForKey,
  clampAnswerPanelHeight,
} from './answer-resize'
import { AnswerResizeHandle } from './AnswerResizeHandle'

describe('AnswerResizeHandle', () => {
  it('clamps every input to the safe panel bounds', () => {
    expect(clampAnswerPanelHeight(-1)).toBe(ANSWER_PANEL_MIN_HEIGHT)
    expect(clampAnswerPanelHeight(9_999)).toBe(ANSWER_PANEL_MAX_HEIGHT)
    expect(clampAnswerPanelHeight(Number.NaN)).toBe(ANSWER_PANEL_DEFAULT_HEIGHT)
  })

  it('supports bounded keyboard resize and direct endpoints', () => {
    expect(answerPanelHeightForKey(ANSWER_PANEL_MIN_HEIGHT, 'ArrowDown')).toBe(ANSWER_PANEL_MIN_HEIGHT)
    expect(answerPanelHeightForKey(ANSWER_PANEL_MAX_HEIGHT, 'ArrowUp')).toBe(ANSWER_PANEL_MAX_HEIGHT)
    expect(answerPanelHeightForKey(320, 'Home')).toBe(ANSWER_PANEL_MIN_HEIGHT)
    expect(answerPanelHeightForKey(320, 'End')).toBe(ANSWER_PANEL_MAX_HEIGHT)
    expect(answerPanelHeightForKey(320, 'Escape')).toBeNull()
  })

  it('renders a named horizontal separator with its current bounds', () => {
    const html = renderToStaticMarkup(<AnswerResizeHandle height={360} onResize={() => undefined} />)
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="horizontal"')
    expect(html).toContain('aria-controls="answer-panel-region"')
    expect(html).toContain('aria-valuenow="360"')
    expect(html).toContain('方向键微调')
  })
})
