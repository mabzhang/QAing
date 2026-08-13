const SENSITIVE_FIELD = /(?:api.?key|authorization|token|secret|password|transcript|question|answer|content|body|audio|pcm|document|prompt)/iu
const SECRET_IN_TEXT = /(?:Bearer\s+[^\s,;]+|\bsk-[A-Za-z0-9_-]{8,}\b|\b[A-Fa-f0-9]{32,}\b)/gu

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogSink = (line: string) => void

function redactString(value: string): string {
  return value.replaceAll(SECRET_IN_TEXT, '[REDACTED]')
}

function safeError(value: Error): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    name: /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(value.name) ? value.name : 'Error',
  }
  // Error messages and causes may contain provider echoes of questions,
  // retrieved passages, paths or request bodies. Only copy explicitly typed,
  // bounded machine metadata from known error subclasses.
  const candidate = value as Error & {
    readonly code?: unknown
    readonly status?: unknown
    readonly retryable?: unknown
  }
  if (typeof candidate.code === 'string' && /^[A-Z0-9_:-]{1,80}$/u.test(candidate.code)) {
    result['code'] = candidate.code
  }
  if (typeof candidate.status === 'number' && Number.isInteger(candidate.status) && candidate.status >= 100 && candidate.status <= 599) {
    result['status'] = candidate.status
  }
  if (typeof candidate.retryable === 'boolean') result['retryable'] = candidate.retryable
  return result
}

function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_FIELD.test(key)) return '[REDACTED]'
  if (depth > 5) return '[TRUNCATED]'
  if (typeof value === 'string') return redactString(value).slice(0, 512)
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (value instanceof Error) return safeError(value)
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, key, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      sanitize(child, childKey, depth + 1),
    ]))
  }
  return typeof value === 'symbol' ? value.description ?? '[symbol]' : '[UNSUPPORTED]'
}

export class SecureLogger {
  readonly #sink: LogSink

  constructor(sink: LogSink = console.log) {
    this.#sink = sink
  }

  log(level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (!/^[a-z0-9_.:-]{1,80}$/u.test(event)) throw new Error('日志事件名必须是稳定标识符')
    this.#sink(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...sanitize(fields) as Record<string, unknown>,
    }))
  }
}
