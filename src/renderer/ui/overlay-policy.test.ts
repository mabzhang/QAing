import { describe, expect, it } from 'vitest'
import { workbenchSheetIsVisible } from './overlay-policy'

describe('renderer overlay policy', () => {
  it('never presents the narrow conversation workbench behind another drawer', () => {
    expect(workbenchSheetIsVisible(true, false, 'qa')).toBe(true)
    expect(workbenchSheetIsVisible(true, true, 'qa')).toBe(false)
    expect(workbenchSheetIsVisible(true, false, 'front')).toBe(false)
    expect(workbenchSheetIsVisible(false, false, 'qa')).toBe(false)
  })
})
