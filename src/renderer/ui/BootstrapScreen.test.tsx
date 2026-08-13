import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BootstrapScreen } from './BootstrapScreen'

describe('BootstrapScreen', () => {
  it('renders a visible, assertive recovery state when the secure bridge is unavailable', () => {
    const markup = renderToStaticMarkup(
      <BootstrapScreen
        error="安全桥接未加载。请重启 QAing。"
        onRetry={() => undefined}
      />,
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('安全桥接未加载')
    expect(markup).toContain('重试加载')
    expect(markup).toContain('aria-busy="false"')
  })

  it('marks the initial state as busy without showing a retry action', () => {
    const markup = renderToStaticMarkup(
      <BootstrapScreen error={null} onRetry={() => undefined} />,
    )

    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).not.toContain('重试加载')
  })
})
