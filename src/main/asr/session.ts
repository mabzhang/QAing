import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import {
  createSeedAsrRequestPayload,
  decodeServerFrame,
  encodeAudioOnlyRequest,
  encodeFullClientRequest,
  SeedAsrProtocolError,
  SeedAsrSingleResultAssembler,
  type SeedAsrDecodedMessage,
  type SeedAsrTranscriptReplacement,
} from './protocol'

const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'

export interface SeedAsrCredentials {
  readonly apiKey: string
  readonly resourceId: string
}

export interface SeedAsrSessionOptions {
  readonly credentials: SeedAsrCredentials
  readonly uid: string
  readonly language?: string
  readonly endpoint?: string
  readonly connectTimeoutMs?: number
  readonly finalTimeoutMs?: number
  readonly maxQueuedFrames?: number
  readonly signal?: AbortSignal
  readonly createSocket?: SeedAsrWebSocketFactory
  readonly logger?: SeedAsrSafeLogger
  readonly resultType?: 'full' | 'single'
}

export interface SeedAsrSafeLogger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void
}

export type SeedAsrSessionEvent =
  | { readonly type: 'state'; readonly state: SeedAsrSessionState }
  | { readonly type: 'transcript'; readonly replacement: SeedAsrTranscriptReplacement }
  | { readonly type: 'error'; readonly code: string; readonly retryable: boolean }

export type SeedAsrSessionState = 'idle' | 'connecting' | 'open' | 'finalizing' | 'closed' | 'failed'

export interface SeedAsrWebSocketLike {
  readonly readyState: number
  // ws currently calls successful send callbacks with `null` even though its
  // public TypeScript declaration only documents `undefined`. Model the
  // runtime contract here so a successful native write can never be mistaken
  // for an Error.
  send(data: Buffer, callback: (error?: Error | null) => void): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(event: 'open', listener: () => void): this
  on(event: 'message', listener: (data: RawData) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this
}

export type SeedAsrWebSocketFactory = (
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) => SeedAsrWebSocketLike

type EventListener = (event: SeedAsrSessionEvent) => void

export class SeedAsrSession {
  private readonly options: Required<Pick<SeedAsrSessionOptions,
    'endpoint' | 'connectTimeoutMs' | 'finalTimeoutMs' | 'maxQueuedFrames'>> & SeedAsrSessionOptions
  private readonly createSocket: SeedAsrWebSocketFactory
  private readonly logger: SeedAsrSafeLogger
  private readonly listeners = new Set<EventListener>()
  private socket: SeedAsrWebSocketLike | null = null
  private state: SeedAsrSessionState = 'idle'
  private sequence = 0
  private pendingWrites = 0
  private writeChain: Promise<void> = Promise.resolve()
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private finalTimer: ReturnType<typeof setTimeout> | null = null
  private resolveFinal: (() => void) | null = null
  private rejectFinal: ((error: Error) => void) | null = null
  private abortListener: (() => void) | null = null
  private readonly singleResultAssembler: SeedAsrSingleResultAssembler | null
  private pendingWriteRejects = new Set<(error: Error) => void>()

  constructor(options: SeedAsrSessionOptions) {
    validateCredentials(options.credentials)
    this.options = {
      ...options,
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
      connectTimeoutMs: options.connectTimeoutMs ?? 8_000,
      finalTimeoutMs: options.finalTimeoutMs ?? 5_000,
      maxQueuedFrames: options.maxQueuedFrames ?? 25,
    }
    this.createSocket = options.createSocket ?? ((url, socketOptions) => new WebSocket(url, socketOptions))
    this.logger = options.logger ?? noOpLogger
    this.singleResultAssembler = options.resultType === 'single' ? new SeedAsrSingleResultAssembler() : null
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): SeedAsrSessionState {
    return this.state
  }

  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise
    if (this.state !== 'idle') return Promise.reject(new Error(`Cannot start session from ${this.state}`))
    this.startPromise = this.openSocket()
    return this.startPromise
  }

  async sendPcmFrame(pcm16: Uint8Array): Promise<void> {
    if (this.state !== 'open') throw new Error(`Cannot send audio while session is ${this.state}`)
    if (pcm16.byteLength !== 6_400) {
      throw new SeedAsrProtocolError('INVALID_AUDIO_FRAME', 'Expected one 200ms 16kHz mono PCM16 frame')
    }
    this.sequence += 1
    await this.enqueueWrite(encodeAudioOnlyRequest(pcm16, this.sequence))
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise
    this.stopPromise = this.finalizeAndClose()
    return this.stopPromise
  }

  abort(): void {
    if (this.state === 'closed' || this.state === 'failed') return
    const error = new SeedAsrSessionError('ABORTED', false, 'ASR session was cancelled')
    this.fail(error, 1000)
  }

  private openSocket(): Promise<void> {
    this.setState('connecting')
    if (this.options.signal?.aborted === true) {
      this.abort()
      return Promise.reject(new SeedAsrSessionError('ABORTED', false, 'ASR session was cancelled'))
    }

    const connectId = randomUUID()
    let socket: SeedAsrWebSocketLike
    try {
      socket = this.createSocket(this.options.endpoint, {
        headers: {
          'X-Api-Key': this.options.credentials.apiKey,
          'X-Api-Resource-Id': this.options.credentials.resourceId,
          'X-Api-Connect-Id': connectId,
        },
      })
    } catch (error) {
      const sessionError = normalizeSessionError(error, 'SOCKET_CREATE_FAILED', true)
      this.fail(sessionError, 1011)
      return Promise.reject(sessionError)
    }
    this.socket = socket

    if (this.options.signal !== undefined) {
      this.abortListener = () => this.abort()
      this.options.signal.addEventListener('abort', this.abortListener, { once: true })
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settleReject = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      this.connectTimer = setTimeout(() => {
        const error = new SeedAsrSessionError('CONNECT_TIMEOUT', true, 'ASR connection timed out')
        this.fail(error, 1011)
        settleReject(error)
      }, this.options.connectTimeoutMs)

      socket.on('open', () => {
        if (settled || this.state !== 'connecting') return
        settled = true
        this.clearConnectTimer()
        // The official SAUC v3 demo starts the sequenced stream at 1 for the
        // full request. PCM therefore starts at 2 and the final packet uses
        // the negative value of the next sequence.
        this.sequence = 1
        const initialRequest = encodeFullClientRequest(createSeedAsrRequestPayload({
          uid: this.options.uid,
          ...(this.options.language === undefined ? {} : { language: this.options.language }),
          resultType: this.options.resultType ?? 'full',
        }), this.sequence)
        this.enqueueWrite(initialRequest).then(() => {
          if (this.state !== 'connecting') {
            reject(new SeedAsrSessionError('START_CANCELLED', false, 'ASR start did not complete'))
            return
          }
          this.setState('open')
          this.logger.info('seed_asr_connected')
          resolve()
        }, (error: unknown) => {
          const sessionError = normalizeSessionError(error, 'INITIAL_WRITE_FAILED', true)
          this.fail(sessionError, 1011)
          reject(sessionError)
        })
      })
      socket.on('message', (data) => this.handleMessage(data))
      socket.on('error', (error) => {
        const sessionError = new SeedAsrSessionError('SOCKET_ERROR', true, error.message)
        this.logger.warn('seed_asr_socket_error', { code: sessionError.code })
        if (!settled) settleReject(sessionError)
        this.fail(sessionError, 1011)
      })
      socket.on('close', (code) => {
        this.clearTimers()
        this.removeAbortListener()
        if (!settled && this.state === 'connecting') {
          settleReject(new SeedAsrSessionError('CLOSED_DURING_CONNECT', true, 'ASR socket closed during connect'))
        }
        if (this.state !== 'closed' && this.state !== 'failed') {
          this.fail(new SeedAsrSessionError('UNEXPECTED_CLOSE', isRetryableClose(code), 'ASR socket closed unexpectedly'))
        }
      })
    })
  }

  private async finalizeAndClose(): Promise<void> {
    if (this.state === 'idle') {
      this.setState('closed')
      return
    }
    if (this.state === 'connecting') {
      this.abort()
      return
    }
    if (this.state === 'closed') return
    if (this.state === 'failed') throw new SeedAsrSessionError('SESSION_FAILED', false, 'ASR session has already failed')

    this.setState('finalizing')
    this.sequence += 1
    const finalResponse = new Promise<void>((resolve, reject) => {
      this.resolveFinal = resolve
      this.rejectFinal = reject
    })
    try {
      await this.enqueueWrite(encodeAudioOnlyRequest(new Uint8Array(), this.sequence, true))
    } catch (error) {
      this.resolveFinal = null
      this.rejectFinal = null
      const sessionError = normalizeSessionError(error, 'FINAL_WRITE_FAILED', true)
      this.fail(sessionError, 1011)
      throw sessionError
    }
    // Install the timeout only after the final write drains. The promise is
    // registered before the write so an immediate final response cannot race
    // past the waiter.
    if (this.resolveFinal !== null) {
      this.finalTimer = setTimeout(() => {
        const error = new SeedAsrSessionError('FINAL_TIMEOUT', true, 'ASR final response timed out')
        this.rejectFinal?.(error)
        this.resolveFinal = null
        this.rejectFinal = null
        this.fail(error, 1000)
      }, this.options.finalTimeoutMs)
    }
    await finalResponse
    this.setState('closed')
    this.socket?.close(1000, 'complete')
    this.clearTimers()
    this.removeAbortListener()
  }

  private enqueueWrite(frame: Buffer): Promise<void> {
    if (this.pendingWrites >= this.options.maxQueuedFrames) {
      return Promise.reject(new SeedAsrSessionError('BACKPRESSURE', true, 'ASR send queue is full'))
    }
    this.pendingWrites += 1
    const write = this.writeChain.then(() => this.writeFrame(frame))
    this.writeChain = write.catch(() => undefined)
    return write.finally(() => {
      this.pendingWrites -= 1
    })
  }

  private writeFrame(frame: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.socket
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        reject(new SeedAsrSessionError('SOCKET_NOT_OPEN', true, 'ASR socket is not open'))
        return
      }
      let settled = false
      const rejectPending = (error: Error): void => {
        if (settled) return
        settled = true
        this.pendingWriteRejects.delete(rejectPending)
        reject(error)
      }
      this.pendingWriteRejects.add(rejectPending)
      socket.send(frame, (error) => {
        if (settled) return
        settled = true
        this.pendingWriteRejects.delete(rejectPending)
        if (error === undefined || error === null) resolve()
        else reject(new SeedAsrSessionError('WRITE_FAILED', true, error.message))
      })
    })
  }

  private handleMessage(rawData: RawData): void {
    try {
      const message = decodeServerFrame(toBuffer(rawData))
      this.handleDecodedMessage(message)
    } catch (error) {
      const sessionError = normalizeSessionError(error, 'PROTOCOL_ERROR', false)
      this.logger.warn('seed_asr_protocol_error', { code: sessionError.code })
      this.fail(sessionError, 1002)
    }
  }

  private handleDecodedMessage(message: SeedAsrDecodedMessage): void {
    if (message.type === 'server_error') {
      const retryable = message.code === 45_000_081 || message.code === 55_000_031 || Math.floor(message.code / 100_000) === 550
      this.fail(new SeedAsrSessionError(`SERVER_${message.code}`, retryable, 'ASR service returned an error'), 1011)
      return
    }
    if (message.type === 'transcript_replace') {
      this.emit({
        type: 'transcript',
        replacement: this.singleResultAssembler?.apply(message) ?? message,
      })
    }
    if (message.isFinalPacket && this.state === 'finalizing') {
      this.clearFinalTimer()
      this.resolveFinal?.()
      this.resolveFinal = null
      this.rejectFinal = null
    }
  }

  private fail(error: SeedAsrSessionError, closeCode?: number): void {
    if (this.state === 'failed' || this.state === 'closed') return
    this.setState('failed')
    this.clearTimers()
    this.removeAbortListener()
    for (const rejectWrite of this.pendingWriteRejects) rejectWrite(error)
    this.pendingWriteRejects.clear()
    this.rejectFinal?.(error)
    this.resolveFinal = null
    this.rejectFinal = null
    if (closeCode === 1000) this.socket?.close(closeCode, 'cancelled')
    else this.socket?.terminate()
    this.emit({ type: 'error', code: error.code, retryable: error.retryable })
  }

  private setState(state: SeedAsrSessionState): void {
    if (this.state === state) return
    this.state = state
    this.emit({ type: 'state', state })
  }

  private emit(event: SeedAsrSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private clearTimers(): void {
    this.clearConnectTimer()
    this.clearFinalTimer()
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private clearFinalTimer(): void {
    if (this.finalTimer !== null) clearTimeout(this.finalTimer)
    this.finalTimer = null
  }

  private removeAbortListener(): void {
    if (this.abortListener !== null) this.options.signal?.removeEventListener('abort', this.abortListener)
    this.abortListener = null
  }
}

export class SeedAsrSessionError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, retryable: boolean, message: string) {
    super(message)
    this.name = 'SeedAsrSessionError'
    this.code = code
    this.retryable = retryable
  }
}

function validateCredentials(credentials: SeedAsrCredentials): void {
  if (credentials.apiKey.trim() === '' || credentials.resourceId.trim() === '') {
    throw new SeedAsrSessionError('MISSING_CREDENTIALS', false, 'ASR credentials are required')
  }
}

function normalizeSessionError(error: unknown, code: string, retryable: boolean): SeedAsrSessionError {
  if (error instanceof SeedAsrSessionError) return error
  if (error instanceof SeedAsrProtocolError) return new SeedAsrSessionError(error.code, false, error.message)
  return new SeedAsrSessionError(code, retryable, error instanceof Error ? error.message : 'Unknown ASR failure')
}

function isRetryableClose(code: number): boolean {
  return code === 1006 || code === 1011 || code === 1012 || code === 1013
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data)
}

const noOpLogger: SeedAsrSafeLogger = {
  info: () => undefined,
  warn: () => undefined,
}
