import { describe, expect, it } from 'vitest'
import { developmentRendererUrl } from './window'

describe('development renderer URL boundary', () => {
  it('always ignores injected renderer URLs in packaged builds', () => {
    expect(developmentRendererUrl(true, 'https://attacker.example/renderer')).toBeNull()
    expect(developmentRendererUrl(true, 'http://localhost:5173')).toBeNull()
  })

  it('accepts only loopback HTTP(S) URLs during development', () => {
    expect(developmentRendererUrl(false, 'http://localhost:5173')).toBe('http://localhost:5173')
    expect(developmentRendererUrl(false, 'https://127.0.0.1:5173/')).toBe('https://127.0.0.1:5173/')
    expect(developmentRendererUrl(false, 'file:///tmp/renderer.html')).toBeNull()
    expect(developmentRendererUrl(false, 'https://attacker.example/renderer')).toBeNull()
    expect(developmentRendererUrl(false, 'not a URL')).toBeNull()
  })
})
