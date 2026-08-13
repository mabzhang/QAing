interface BootstrapScreenProps {
  readonly error: string | null
  readonly onRetry: () => void
}

export function BootstrapScreen({
  error,
  onRetry,
}: BootstrapScreenProps): React.JSX.Element {
  const hasError = error !== null

  return (
    <main className="bootstrap-screen" aria-busy={!hasError}>
      <span className={`bootstrap-mark${hasError ? ' is-error' : ' is-loading'}`} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <h1>{hasError ? '无法加载应用状态' : '正在准备 QAing'}</h1>
      <p role={hasError ? 'alert' : 'status'} aria-live={hasError ? 'assertive' : 'polite'}>
        {error ?? '正在检查本地资料库、模型配置与音频权限。'}
      </p>
      {hasError ? <button type="button" onClick={onRetry}>重试加载</button> : null}
    </main>
  )
}
