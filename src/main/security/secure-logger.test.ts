import { describe, expect, it, vi } from 'vitest'
import { SecureLogger } from './secure-logger'

describe('SecureLogger', () => {
  it('redacts sensitive fields recursively', () => {
    const sink = vi.fn()
    const logger = new SecureLogger(sink)
    logger.log('error', 'provider.failed', {
      apiKey: 'secret-value',
      nested: { transcript: '敏感正文', status: 401 },
    })
    const line = String(sink.mock.calls[0]?.[0])
    expect(line).not.toContain('secret-value')
    expect(line).not.toContain('敏感正文')
    expect(line).toContain('[REDACTED]')
    expect(line).toContain('401')
  })

  it('never logs free-text Error messages or causes and keeps only safe machine metadata', () => {
    const sink = vi.fn()
    const logger = new SecureLogger(sink)
    const error = Object.assign(
      new Error('中文问题、/Users/private/qa.md 与 Authorization Bearer dangerous-value'),
      { code: 'UPSTREAM_TIMEOUT', status: 503, retryable: true, cause: new Error('资料正文') },
    )
    logger.log('warn', 'request.failed', { error })
    const line = String(sink.mock.calls[0]?.[0])
    expect(line).not.toContain('中文问题')
    expect(line).not.toContain('/Users/private')
    expect(line).not.toContain('资料正文')
    expect(line).not.toContain('dangerous-value')
    expect(line).toContain('UPSTREAM_TIMEOUT')
    expect(line).toContain('503')
    expect(line).toContain('true')
  })

  it('drops untrusted error codes instead of serializing them as free text', () => {
    const sink = vi.fn()
    const logger = new SecureLogger(sink)
    logger.log('warn', 'request.failed', {
      error: Object.assign(new Error('不应记录'), { code: '用户的问题正文' }),
    })
    const line = String(sink.mock.calls[0]?.[0])
    expect(line).not.toContain('不应记录')
    expect(line).not.toContain('用户的问题正文')
  })

  it('replaces an untrusted writable Error name with a fixed identifier', () => {
    const sink = vi.fn()
    const logger = new SecureLogger(sink)
    const error = Object.assign(new Error('不应记录'), {
      name: '问题正文 /Users/private Bearer dangerous-value',
    })
    logger.log('warn', 'request.failed', { error })
    const line = String(sink.mock.calls[0]?.[0])
    expect(line).not.toContain('问题正文')
    expect(line).not.toContain('/Users/private')
    expect(line).not.toContain('dangerous-value')
    expect(line).toContain('"name":"Error"')
  })

  it('rejects dynamic free-text event names', () => {
    expect(() => new SecureLogger(vi.fn()).log('info', '用户说了 一段内容')).toThrow()
  })
})
