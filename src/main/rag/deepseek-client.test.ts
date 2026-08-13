import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DEEPSEEK_MODEL, DeepSeekStreamingClient, type DeepSeekRequest } from './deepseek-client'
import type { DeepSeekClientError } from './deepseek-client'

function streamResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function baseRequest(overrides: Partial<DeepSeekRequest> = {}): DeepSeekRequest {
  return {
    requestKey: 'session-fixture',
    generationId: 1,
    apiKey: randomUUID(),
    messages: [{ role: 'user', content: '测试问题' }],
    ...overrides,
  }
}

describe('DeepSeekStreamingClient', () => {
  it('pins the flash model, disables thinking, and parses split SSE frames', async () => {
    let requestBody: Record<string, unknown> | null = null
    const fetchMock: typeof fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
      requestBody = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(
        streamResponse([
          'data: {"id":"req-fixture","choices":[{"delta":{"content":"你"}}]}\r',
          '\n\r\ndata: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n',
        ]),
      )
    }) as typeof fetch
    const deltas: string[] = []
    const result = await new DeepSeekStreamingClient({ fetch: fetchMock }).generate(
      baseRequest({ onDelta: (event) => void deltas.push(event.delta) }),
    )
    expect(result).toMatchObject({ content: '你好', finishReason: 'stop', requestId: 'req-fixture' })
    expect(deltas).toEqual(['你', '好'])
    expect(requestBody).toMatchObject({
      model: DEEPSEEK_MODEL,
      stream: true,
      thinking: { type: 'disabled' },
    })
  })

  it('aborts an older generation and rejects its late result', async () => {
    let callCount = 0
    const fetchMock: typeof fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1
      if (callCount === 1) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener(
            'abort',
            () => {
              const reason = signal.reason as unknown
              reject(reason instanceof Error ? reason : new Error('Fixture request aborted'))
            },
            { once: true },
          )
        })
      }
      return Promise.resolve(streamResponse(['data: {"choices":[{"delta":{"content":"new"}}]}\n\ndata: [DONE]\n\n']))
    }) as typeof fetch
    const client = new DeepSeekStreamingClient({ fetch: fetchMock })
    const old = client.generate(baseRequest({ generationId: 1 }))
    const latest = client.generate(baseRequest({ generationId: 2 }))
    await expect(old).rejects.toMatchObject({ code: 'SUPERSEDED' })
    await expect(latest).resolves.toMatchObject({ content: 'new', generationId: 2 })
  })

  it('classifies a bounded timeout as retryable', async () => {
    const fetchMock: typeof fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener(
          'abort',
          () => {
            const reason = signal.reason as unknown
            reject(reason instanceof Error ? reason : new Error('Fixture request aborted'))
          },
          { once: true },
        )
      }),
    ) as typeof fetch
    const client = new DeepSeekStreamingClient({ fetch: fetchMock, timeoutMs: 5 })
    await expect(client.generate(baseRequest())).rejects.toEqual(
      expect.objectContaining<Partial<DeepSeekClientError>>({ code: 'TIMEOUT', retryable: true }),
    )
  })

  it('rejects an unbounded streamed response before it can exhaust memory', async () => {
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(streamResponse(['data: {"choices":[{"delta":{"content":"123456"}}]}\n\ndata: [DONE]\n\n'])),
    )
    const client = new DeepSeekStreamingClient({ fetch: fetchMock, maxResponseCharacters: 5 })
    await expect(client.generate(baseRequest())).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false })
  })
})
