import { describe, expect, it, vi } from 'vitest'
import { drawerEscapeShouldClose, restoreDrawerFocus } from './drawer-keyboard'

describe('drawer keyboard contract', () => {
  it('allows Escape to close an idle drawer but not an action in flight', () => {
    expect(drawerEscapeShouldClose('Escape', false)).toBe(true)
    expect(drawerEscapeShouldClose('Escape', true)).toBe(false)
    expect(drawerEscapeShouldClose('Enter', false)).toBe(false)
  })

  it('restores focus to the invoker when a drawer unmounts', () => {
    const focus = vi.fn()
    restoreDrawerFocus({ focus })
    expect(focus).toHaveBeenCalledOnce()
    expect(() => { restoreDrawerFocus(null) }).not.toThrow()
  })
})
