import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkbenchResizeHandle } from './WorkbenchResizeHandle'
import {
  WORKBENCH_DEFAULT_WIDTH,
  WORKBENCH_MAX_WIDTH,
  WORKBENCH_MIN_WIDTH,
  effectiveWorkbenchMaxWidth,
  effectiveWorkbenchWidth,
  finalizedWorkbenchDragWidth,
  workbenchLayoutMode,
  workbenchWidthForKey,
} from './workbench-resize'

describe('Conversation workbench resizing and responsive layout', () => {
  it('keeps the center at least 400px wide at the 1180px design viewport', () => {
    expect(workbenchLayoutMode(1_180)).toBe('desktop')
    expect(effectiveWorkbenchMaxWidth(1_180)).toBe(482)
    expect(effectiveWorkbenchWidth(WORKBENCH_DEFAULT_WIDTH, 1_180)).toBe(420)
    expect(effectiveWorkbenchWidth(WORKBENCH_MAX_WIDTH, 1_180)).toBe(482)
  })

  it('switches 1100px to the sheet instead of leaving an empty third grid column', () => {
    expect(workbenchLayoutMode(1_100)).toBe('sheet')
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
    expect(css).toContain('@media (max-width: 1119px)')
    expect(css).toContain('grid-template-columns: 210px minmax(0, 1fr);')
    expect(css).toContain('220px minmax(400px, 1fr) var(--qa-workbench-width, 420px)')
  })

  it('supports bounded keyboard adjustment, endpoints, and a named vertical separator', () => {
    expect(workbenchWidthForKey(420, 'ArrowLeft', 482)).toBe(436)
    expect(workbenchWidthForKey(420, 'ArrowRight', 482)).toBe(404)
    expect(workbenchWidthForKey(420, 'Home', 482)).toBe(WORKBENCH_MIN_WIDTH)
    expect(workbenchWidthForKey(420, 'End', 482)).toBe(482)
    expect(workbenchWidthForKey(420, 'Escape', 482)).toBeNull()

    const html = renderToStaticMarkup(
      <WorkbenchResizeHandle width={420} maxWidth={482} onResize={() => undefined} onCommit={() => undefined} />,
    )
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('aria-valuemin="360"')
    expect(html).toContain('aria-valuemax="482"')
    expect(html).toContain('双击恢复默认宽度')
  })

  it('finalizes cancel/lost-capture at a safe width and ignores a duplicate terminal event', () => {
    const drag = { pointerId: 7, clientX: 800, width: 420 }
    const first = finalizedWorkbenchDragWidth(drag, 7, 515.4, 482)
    expect(first).toBe(482)
    if (first === null) throw new Error('expected the owning pointer to finalize the drag')

    // The component clears its drag ref before releasing capture. Therefore a
    // synchronous lostpointercapture after pointerup/cancel is a no-op.
    expect(finalizedWorkbenchDragWidth(null, 7, first, 482)).toBeNull()
    expect(finalizedWorkbenchDragWidth(drag, 8, 400, 482)).toBeNull()
  })
})
