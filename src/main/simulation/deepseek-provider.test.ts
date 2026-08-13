import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DeepSeekSimulationProvider } from './deepseek-provider'
import type { SimulationProviderPort } from './types'

function sse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200 })
}

function input(): Parameters<SimulationProviderPort['generateBatch']>[0] {
  const excerpt = '项目预算为100万元。'
  return {
    operationId: 'simop-1',
    generation: 2,
    fence: {
      projectId: 'project-a', knowledgeVersion: 3, projectDataRevision: 4,
      sourceManifestHash: 'a'.repeat(64), sourceCount: 1,
    },
    brief: {
      intervieweeIdentity: '项目负责人',
      audience: '评审专家',
      focusTopics: ['预算'],
      scenario: '评审',
      answerStyle: 'standard',
      excludedTopics: [],
    },
    slots: [{ id: 'slot-1', ordinal: 1, topic: '预算', lens: 'metrics', intent: '解释预算指标' }],
    evidence: [{
      slotId: 'slot-1',
      evidence: [{
        projectId: 'project-a',
        knowledgeVersion: 3,
        projectDataRevision: 4,
        sourceManifestHash: 'a'.repeat(64),
        reference: {
          sourceId: 'source-1',
          sourceRevisionId: 'revision-1',
          documentId: 'document-1',
          chunkId: 'chunk-1',
          contentHash: createHash('sha256').update(excerpt).digest('hex'),
        },
        title: '测试资料',
        excerpt,
      }],
    }],
    signal: new AbortController().signal,
  }
}

describe('DeepSeekSimulationProvider', () => {
  it('buffers a complete JSON response privately and sends the key only through the pinned client', async () => {
    const rawJson = '{"items":[]}'
    const fetchMock = vi.fn<typeof fetch>(async (_url, request) => {
      expect(typeof request?.body).toBe('string')
      const bodyText = typeof request?.body === 'string' ? request.body : ''
      const body = JSON.parse(bodyText) as { messages: Array<{ content: string }>; stream: boolean }
      expect(body.stream).toBe(true)
      expect(body.messages[0]?.content).toContain('严格JSON')
      expect(body.messages[1]?.content).toContain('project-a')
      return sse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: rawJson.slice(0, 5) } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: rawJson.slice(5) }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    })
    const provider = new DeepSeekSimulationProvider({ getApiKey: () => 'secret-key', fetch: fetchMock })
    await expect(provider.generateBatch(input())).resolves.toEqual({ rawJson })
    const request = fetchMock.mock.calls[0]?.[1]
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer secret-key')
    expect(typeof request?.body === 'string' ? request.body : '').not.toContain('secret-key')
  })

  it('fails before network access when no key is configured', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const provider = new DeepSeekSimulationProvider({ getApiKey: () => null, fetch: fetchMock })
    await expect(provider.generateBatch(input())).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
      retryable: false,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps transient HTTP failures to a retryable provider error without retaining the response body', async () => {
    const provider = new DeepSeekSimulationProvider({
      getApiKey: async () => 'secret-key',
      fetch: async () => new Response(JSON.stringify({ error: { message: 'upstream overloaded' } }), { status: 503 }),
    })
    await expect(provider.generateBatch(input())).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      retryable: true,
    })
  })
})
