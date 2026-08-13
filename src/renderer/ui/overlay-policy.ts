import type { AppMode } from '../../core/types'

export type ActiveDrawer = 'settings' | 'knowledge' | 'project' | null

export function workbenchSheetIsVisible(
  requested: boolean,
  externalDrawerOpen: boolean,
  mode: AppMode,
): boolean {
  return requested && !externalDrawerOpen && mode === 'qa'
}
