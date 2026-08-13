export const MINIMUM_MACOS_MAJOR = 14

export function supportsRequiredMacOs(systemVersion: string): boolean {
  const match = /^(\d+)(?:\.\d+){0,2}$/u.exec(systemVersion.trim())
  if (!match) return false
  const major = Number.parseInt(match[1] ?? '', 10)
  return Number.isSafeInteger(major) && major >= MINIMUM_MACOS_MAJOR
}
