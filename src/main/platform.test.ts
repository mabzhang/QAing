import { describe, expect, it } from 'vitest'
import { supportsRequiredMacOs } from './platform'

describe('macOS platform requirement', () => {
  it('rejects macOS 13 and accepts macOS 14 or newer', () => {
    expect(supportsRequiredMacOs('13.6.9')).toBe(false)
    expect(supportsRequiredMacOs('14.0')).toBe(true)
    expect(supportsRequiredMacOs('15.4.1')).toBe(true)
  })

  it('fails closed for malformed versions', () => {
    expect(supportsRequiredMacOs('')).toBe(false)
    expect(supportsRequiredMacOs('14-beta')).toBe(false)
    expect(supportsRequiredMacOs('not-a-version')).toBe(false)
  })
})
