export function drawerEscapeShouldClose(key: string, busy: boolean): boolean {
  return key === 'Escape' && !busy
}

export function restoreDrawerFocus(target: Pick<HTMLElement, 'focus'> | null): void {
  target?.focus()
}
