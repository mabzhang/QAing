import { EventEmitter } from 'node:events'
import { gunzipSync, gzipSync } from 'node:zlib'
import WebSocket, { type RawData } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { SeedAsrFlags, SeedAsrMessageType } from './protocol'
import {
  SeedAsrSession,
  type SeedAsrSafeLogger,
  type SeedAsrWebSocketFactory,
  type SeedAsrWebSocketLike,
} from './session'

class FakeSocket extends EventEmitter implements SeedAsrWebSocketLike {
  readyState: number = WebSocket.CONNECTING
  readonly sent: Buffer[] = []
  readonly closeCalls: Array<{ code?: number; reason?: string }> = []
  terminated = false
  deferWrites = false
  successfulWriteCallbackValue: null | undefined = undefined
  private readonly writeCallbacks: Array<(error?: Error | null) => void> = []

  send(data: Buffer, callback: (error?: Error | null) => void): void {
    this.sent.push(Buffer.from(data))
    if (this.deferWrites) this.writeCallbacks.push(callback)
    else queueMicrotask(() => callback(this.successfulWriteCallbackValue))
  }

  releaseOneWrite(error?: Error | null): void {
    this.writeCallbacks.shift()?.(error)
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
    this.readyState = WebSocket.CLOSING
  }

  terminate(): void {
    this.terminated = true
    this.readyState = WebSocket.CLOSED
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }

  message(frame: Buffer): void {
    this.emit('message', frame as RawData)
  }
}

function finalServerFrame(): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text: '完成', utterances: [] } })))
  const frame = Buffer.alloc(12 + payload.length)
  frame[0] = 0x11
  frame[1] = (SeedAsrMessageType.FULL_SERVER_RESPONSE << 4) | SeedAsrFlags.HAS_NEGATIVE_SEQUENCE
  frame[2] = 0x11
  frame.writeInt32BE(-2, 4)
  frame.writeUInt32BE(payload.length, 8)
  payload.copy(frame, 12)
  return frame
}

function makeSession(overrides: Partial<ConstructorParameters<typeof SeedAsrSession>[0]> = {}) {
  const socket = new FakeSocket()
  const observedHeaders: Record<string, string>[] = []
  const factory: SeedAsrWebSocketFactory = (_url, options) => {
    observedHeaders.push({ ...options.headers })
    return socket
  }
  const logger: SeedAsrSafeLogger = { info: vi.fn(), warn: vi.fn() }
  const session = new SeedAsrSession({
    credentials: { apiKey: 'test-only-secret', resourceId: 'test-resource' },
    uid: 'test-device',
    connectTimeoutMs: 50,
    finalTimeoutMs: 50,
    createSocket: factory,
    logger,
    ...overrides,
  })
  return { session, socket, observedHeaders, logger }
}

describe('SeedAsrSession', () => {
  it('accepts the null success value emitted by ws send callbacks', async () => {
    const { session, socket } = makeSession()
    socket.successfulWriteCallbackValue = null
    const started = session.start()
    socket.open()

    await expect(started).resolves.toBeUndefined()
    await expect(session.sendPcmFrame(new Uint8Array(6_400))).resolves.toBeUndefined()
    expect(session.getState()).toBe('open')
    expect(socket.sent).toHaveLength(2)
  })

  it('injects credentials only into headers and writes init before queued PCM', async () => {
    const { session, socket, observedHeaders, logger } = makeSession()
    const started = session.start()
    socket.open()
    await started
    await session.sendPcmFrame(new Uint8Array(6_400))

    expect(observedHeaders[0]).toMatchObject({
      'X-Api-Key': 'test-only-secret',
      'X-Api-Resource-Id': 'test-resource',
    })
    expect(socket.sent).toHaveLength(2)
    expect(socket.sent[0]?.[1]).toBe(0x11)
    expect(socket.sent[0]?.readInt32BE(4)).toBe(1)
    expect(socket.sent[1]?.readInt32BE(4)).toBe(2)
    expect(JSON.stringify(logger)).not.toContain('test-only-secret')
  })

  it('emits replacement transcripts rather than append chunks', async () => {
    const { session, socket } = makeSession()
    const replacements: string[] = []
    session.onEvent((event) => {
      if (event.type === 'transcript') replacements.push(event.replacement.fullText)
    })
    const started = session.start()
    socket.open()
    await started

    const first = finalServerFrame()
    first.writeInt32BE(1, 4)
    first[1] = (SeedAsrMessageType.FULL_SERVER_RESPONSE << 4) | SeedAsrFlags.HAS_POSITIVE_SEQUENCE
    socket.message(first)
    const secondPayload = gzipSync(Buffer.from(JSON.stringify({ result: { text: '完全替换', utterances: [] } })))
    const second = Buffer.alloc(12 + secondPayload.length)
    second[0] = 0x11
    second[1] = 0x91
    second[2] = 0x11
    second.writeInt32BE(2, 4)
    second.writeUInt32BE(secondPayload.length, 8)
    secondPayload.copy(second, 12)
    socket.message(second)

    expect(replacements).toEqual(['完成', '完全替换'])
  })

  it('serializes writes and enforces bounded backpressure', async () => {
    const { session, socket } = makeSession({ maxQueuedFrames: 2 })
    socket.deferWrites = true
    const started = session.start()
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    socket.releaseOneWrite()
    await started

    const one = session.sendPcmFrame(new Uint8Array(6_400))
    const two = session.sendPcmFrame(new Uint8Array(6_400))
    await expect(session.sendPcmFrame(new Uint8Array(6_400))).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    socket.releaseOneWrite()
    await one
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
    socket.releaseOneWrite()
    await two
    expect(socket.sent.slice(1).map((frame) => frame.readInt32BE(4))).toEqual([2, 3])
  })

  it('sends an empty gzip final packet with a negative sequence and stops idempotently', async () => {
    const { session, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started
    const firstStop = session.stop()
    expect(session.stop()).toBe(firstStop)
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const final = socket.sent[1]!
    expect(final.readInt32BE(4)).toBe(-2)
    expect(gunzipSync(final.subarray(12))).toHaveLength(0)
    socket.message(finalServerFrame())
    await firstStop
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'complete' }])
    expect(session.getState()).toBe('closed')
  })

  it('cancels through AbortSignal without waiting for the network', async () => {
    const abortController = new AbortController()
    const { session, socket } = makeSession({ signal: abortController.signal })
    const errors: string[] = []
    session.onEvent((event) => {
      if (event.type === 'error') errors.push(event.code)
    })
    const started = session.start()
    socket.open()
    await started
    abortController.abort()
    expect(session.getState()).toBe('failed')
    expect(socket.closeCalls).toContainEqual({ code: 1000, reason: 'cancelled' })
    expect(errors).toEqual(['ABORTED'])
  })

  it('rejects start if cancellation wins while the initial write is pending', async () => {
    const { session, socket } = makeSession()
    socket.deferWrites = true
    const started = session.start()
    const rejection = expect(started).rejects.toMatchObject({ code: 'ABORTED' })
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    session.abort()
    await rejection
    expect(session.getState()).toBe('failed')
  })

  it('times out a connection and never logs credentials or transcript bodies', async () => {
    vi.useFakeTimers()
    try {
      const { session, socket, logger } = makeSession({ connectTimeoutMs: 10 })
      const start = session.start()
      const rejection = expect(start).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(11)
      await rejection
      expect(socket.terminated).toBe(true)
      const serializedCalls = JSON.stringify([
        ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
        ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ])
      expect(serializedCalls).not.toContain('test-only-secret')
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns synchronous socket construction failures into a terminal state', async () => {
    const { session } = makeSession({
      createSocket: () => { throw new Error('construction failed') },
    })
    await expect(session.start()).rejects.toMatchObject({ code: 'SOCKET_CREATE_FAILED', retryable: true })
    expect(session.getState()).toBe('failed')
  })

  it('classifies overload server errors as retryable without exposing the body', async () => {
    const { session, socket } = makeSession()
    const observed: Array<{ code: string; retryable: boolean }> = []
    session.onEvent((event) => {
      if (event.type === 'error') observed.push({ code: event.code, retryable: event.retryable })
    })
    const started = session.start()
    socket.open()
    await started
    const message = Buffer.from('sensitive remote body')
    const error = Buffer.alloc(12 + message.length)
    error[0] = 0x11
    error[1] = 0xf0
    error[2] = 0
    error.writeUInt32BE(55_000_031, 4)
    error.writeUInt32BE(message.length, 8)
    message.copy(error, 12)
    socket.message(error)
    expect(observed).toEqual([{ code: 'SERVER_55000031', retryable: true }])
  })
})
