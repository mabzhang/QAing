export const DEEPSEEK_MODEL = 'deepseek-v4-flash'
export const DEEPSEEK_CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions'

export interface DeepSeekMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface DeepSeekDelta {
  readonly requestKey: string
  readonly generationId: number
  readonly delta: string
}

export interface DeepSeekRequest {
  readonly requestKey: string
  readonly generationId: number
  readonly apiKey: string
  readonly messages: readonly DeepSeekMessage[]
  readonly signal?: AbortSignal
  readonly onDelta?: (event: DeepSeekDelta) => void | Promise<void>
  readonly maxTokens?: number
}

export interface DeepSeekResult {
  readonly requestKey: string
  readonly generationId: number
  readonly content: string
  readonly finishReason: string | null
  readonly requestId: string | null
}

export type DeepSeekErrorCode =
  | 'INVALID_REQUEST'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'SUPERSEDED'

export class DeepSeekClientError extends Error {
  constructor(
    readonly code: DeepSeekErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DeepSeekClientError'
  }
}

interface ActiveRequest {
  readonly generationId: number
  readonly controller: AbortController
}

interface StreamState {
  content: string
  finishReason: string | null
  requestId: string | null
  done: boolean
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateEndpoint(endpoint: string, allowCustomEndpoint: boolean): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new DeepSeekClientError('INVALID_REQUEST', 'DeepSeek endpoint is not a valid URL', false)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new DeepSeekClientError('INVALID_REQUEST', 'DeepSeek endpoint must be credential-free HTTPS', false)
  }
  if (!allowCustomEndpoint && (parsed.hostname !== 'api.deepseek.com' || parsed.pathname !== '/chat/completions')) {
    throw new DeepSeekClientError('INVALID_REQUEST', 'DeepSeek credentials may only be sent to the pinned API endpoint', false)
  }
  if (parsed.search || parsed.hash) {
    throw new DeepSeekClientError('INVALID_REQUEST', 'DeepSeek endpoint must not contain a query or fragment', false)
  }
  return parsed.toString()
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as unknown
    if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
      return payload.error.message.slice(0, 300)
    }
  } catch {
    // The status is sufficient when the body is not JSON.
  }
  return `DeepSeek request failed with HTTP ${response.status}`
}

function parseSsePayload(payloadText: string, state: StreamState): string {
  let payload: unknown
  try {
    payload = JSON.parse(payloadText)
  } catch {
    throw new DeepSeekClientError('INVALID_RESPONSE', 'DeepSeek returned malformed SSE JSON', false)
  }
  if (!isRecord(payload)) throw new DeepSeekClientError('INVALID_RESPONSE', 'DeepSeek SSE payload is invalid', false)
  if (typeof payload.id === 'string') state.requestId = payload.id
  if (isRecord(payload.error)) {
    const message = typeof payload.error.message === 'string' ? payload.error.message.slice(0, 300) : 'DeepSeek stream error'
    throw new DeepSeekClientError('HTTP_ERROR', message, false)
  }

  const choices: unknown = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const choice: unknown = (choices as unknown[])[0]
  if (!isRecord(choice)) return ''
  if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason
  const delta = choice.delta
  return isRecord(delta) && typeof delta.content === 'string' ? delta.content : ''
}

function eventData(eventBlock: string): string | null {
  const lines = eventBlock.split('\n')
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /u, ''))
  return data.length > 0 ? data.join('\n') : null
}

export class DeepSeekStreamingClient {
  readonly #endpoint: string
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number
  readonly #maxResponseCharacters: number
  readonly #active = new Map<string, ActiveRequest>()

  constructor(
    options: {
      readonly endpoint?: string
      readonly fetch?: typeof fetch
      readonly timeoutMs?: number
      readonly maxResponseCharacters?: number
      readonly allowCustomEndpoint?: boolean
    } = {},
  ) {
    this.#endpoint = validateEndpoint(options.endpoint ?? DEEPSEEK_CHAT_ENDPOINT, options.allowCustomEndpoint ?? false)
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = options.timeoutMs ?? 45_000
    this.#maxResponseCharacters = options.maxResponseCharacters ?? 32_000
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new DeepSeekClientError('INVALID_REQUEST', 'DeepSeek timeout must be a positive integer', false)
    }
    if (!Number.isSafeInteger(this.#maxResponseCharacters) || this.#maxResponseCharacters < 1) {
      throw new DeepSeekClientError('INVALID_REQUEST', 'DeepSeek response limit must be a positive integer', false)
    }
  }

  cancel(requestKey: string): boolean {
    const active = this.#active.get(requestKey)
    if (!active) return false
    active.controller.abort(new DeepSeekClientError('ABORTED', 'DeepSeek request was cancelled', false))
    return true
  }

  async generate(request: DeepSeekRequest): Promise<DeepSeekResult> {
    if (!request.requestKey || !Number.isSafeInteger(request.generationId) || request.generationId < 0) {
      throw new DeepSeekClientError('INVALID_REQUEST', 'Request key and generation ID are required', false)
    }
    if (!request.apiKey.trim() || request.messages.length === 0) {
      throw new DeepSeekClientError('INVALID_REQUEST', 'Runtime API key and messages are required', false)
    }
    const existing = this.#active.get(request.requestKey)
    if (existing && request.generationId <= existing.generationId) {
      throw new DeepSeekClientError('SUPERSEDED', 'A newer generation is already active', false)
    }
    existing?.controller.abort(new DeepSeekClientError('SUPERSEDED', 'DeepSeek request was superseded', false))

    const controller = new AbortController()
    const abortFromParent = (): void =>
      controller.abort(request.signal?.reason ?? new DeepSeekClientError('ABORTED', 'DeepSeek request was cancelled', false))
    if (request.signal?.aborted) abortFromParent()
    else request.signal?.addEventListener('abort', abortFromParent, { once: true })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new DeepSeekClientError('TIMEOUT', 'DeepSeek request timed out', true))
    }, this.#timeoutMs)
    this.#active.set(request.requestKey, { generationId: request.generationId, controller })

    try {
      const response = await this.#performFetch(request, controller.signal)
      if (!response.ok) {
        throw new DeepSeekClientError(
          'HTTP_ERROR',
          await safeErrorMessage(response),
          retryableStatus(response.status),
          response.status,
        )
      }
      if (!response.body) throw new DeepSeekClientError('INVALID_RESPONSE', 'DeepSeek response has no stream body', true)
      const state = await this.#consumeStream(response.body, request, controller.signal)
      if (controller.signal.aborted) {
        const reason = controller.signal.reason as unknown
        if (reason instanceof DeepSeekClientError) throw reason
        throw new DeepSeekClientError('ABORTED', 'DeepSeek request was cancelled', false)
      }
      if (!state.done) throw new DeepSeekClientError('INVALID_RESPONSE', 'DeepSeek stream ended before [DONE]', true)
      this.#assertLatest(request.requestKey, request.generationId)
      return {
        requestKey: request.requestKey,
        generationId: request.generationId,
        content: state.content,
        finishReason: state.finishReason,
        requestId: state.requestId,
      }
    } catch (error) {
      if (error instanceof DeepSeekClientError) throw error
      if (timedOut) throw new DeepSeekClientError('TIMEOUT', 'DeepSeek request timed out', true, null, { cause: error })
      if (controller.signal.aborted) {
        const reason = controller.signal.reason as unknown
        if (reason instanceof DeepSeekClientError) throw reason
        throw new DeepSeekClientError('ABORTED', 'DeepSeek request was cancelled', false, null, { cause: error })
      }
      throw new DeepSeekClientError('NETWORK_ERROR', 'DeepSeek network request failed', true, null, { cause: error })
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abortFromParent)
      const active = this.#active.get(request.requestKey)
      if (active?.generationId === request.generationId) this.#active.delete(request.requestKey)
    }
  }

  async #performFetch(request: DeepSeekRequest, signal: AbortSignal): Promise<Response> {
    const maxTokens = Math.max(1, Math.min(8_192, request.maxTokens ?? 2_048))
    return this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: request.messages,
        stream: true,
        thinking: { type: 'disabled' },
        temperature: 0.2,
        max_tokens: maxTokens,
      }),
      signal,
      redirect: 'error',
    })
  }

  async #consumeStream(
    body: ReadableStream<Uint8Array>,
    request: DeepSeekRequest,
    signal: AbortSignal,
  ): Promise<StreamState> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const state: StreamState = { content: '', finishReason: null, requestId: null, done: false }
    let buffer = ''
    const cancelReader = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined)
    }
    signal.addEventListener('abort', cancelReader, { once: true })

    const consumeBlock = async (block: string): Promise<void> => {
      const data = eventData(block)
      if (data === null) return
      if (data.trim() === '[DONE]') {
        state.done = true
        return
      }
      const delta = parseSsePayload(data, state)
      if (!delta) return
      this.#assertLatest(request.requestKey, request.generationId)
      if (state.content.length + delta.length > this.#maxResponseCharacters) {
        throw new DeepSeekClientError('INVALID_RESPONSE', 'DeepSeek response exceeded the configured size limit', false)
      }
      state.content += delta
      await request.onDelta?.({ requestKey: request.requestKey, generationId: request.generationId, delta })
    }

    try {
      while (!state.done) {
        const result = await reader.read()
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        buffer = buffer.replaceAll('\r\n', '\n')
        if (buffer.endsWith('\r')) buffer = `${buffer.slice(0, -1).replaceAll('\r', '\n')}\r`
        else buffer = buffer.replaceAll('\r', '\n')
        if (buffer.length > Math.max(131_072, this.#maxResponseCharacters * 4)) {
          throw new DeepSeekClientError('INVALID_RESPONSE', 'DeepSeek SSE event exceeded the configured size limit', false)
        }
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          await consumeBlock(block)
          if (state.done) break
          boundary = buffer.indexOf('\n\n')
        }
      }
      buffer = `${buffer}${decoder.decode()}`.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      if (!state.done && buffer.trim()) await consumeBlock(buffer)
      return state
    } finally {
      signal.removeEventListener('abort', cancelReader)
      reader.releaseLock()
    }
  }

  #assertLatest(requestKey: string, generationId: number): void {
    const active = this.#active.get(requestKey)
    if (!active || active.generationId !== generationId || active.controller.signal.aborted) {
      throw new DeepSeekClientError('SUPERSEDED', 'DeepSeek response belongs to a stale generation', false)
    }
  }
}
