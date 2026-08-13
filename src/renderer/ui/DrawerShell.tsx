import { CircleAlert, X, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { drawerEscapeShouldClose, restoreDrawerFocus } from './drawer-keyboard'

interface DrawerShellProps {
  readonly title: string
  readonly description: string
  readonly icon: LucideIcon
  readonly busy: boolean
  readonly actionError: string | null
  readonly panelClassName?: string
  readonly onClose: () => void
  readonly children: ReactNode
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function DrawerShell({
  title,
  description,
  icon: Icon,
  busy,
  actionError,
  panelClassName,
  onClose,
  children,
}: DrawerShellProps): React.JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const drawerRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    closeRef.current?.focus()
    return () => { restoreDrawerFocus(previouslyFocused) }
  }, [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (drawerEscapeShouldClose(event.key, busy)) {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
    if (focusable.length === 0) {
      event.preventDefault()
      drawerRef.current?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  return (
    <div className="drawer-layer">
      <button
        type="button"
        className="drawer-backdrop"
        aria-label="关闭抽屉"
        tabIndex={-1}
        onClick={() => { if (!busy) onClose() }}
      />
      <div
        ref={drawerRef}
        className={`drawer-panel${panelClassName ? ` ${panelClassName}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="drawer-header">
          <span className="drawer-header__icon"><Icon aria-hidden="true" /></span>
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            aria-label={`关闭${title}`}
            onClick={onClose}
            disabled={busy}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="drawer-content">
          {actionError !== null ? (
            <div className="drawer-action-error" role="alert">
              <CircleAlert aria-hidden="true" />
              <div><strong>操作未完成</strong><span>{actionError}</span></div>
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  )
}
