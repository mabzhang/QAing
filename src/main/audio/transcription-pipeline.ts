import {
  SeedAsrSession,
  type SeedAsrCredentials,
  type SeedAsrSessionEvent,
  type SeedAsrSessionOptions,
  type SeedAsrTranscriptReplacement,
} from '../asr'
import type { NativeAudioSource } from './protocol'
import type { AudioHelperSupervisor, AudioSupervisorEvent } from './supervisor'

export interface MainTranscriptionStartOptions {
  readonly sessionId: string
  readonly source: NativeAudioSource
  readonly credentials: SeedAsrCredentials
  readonly uid: string
  readonly language?: string
  readonly signal?: AbortSignal
  readonly resultType?: 'full' | 'single'
}

export type MainTranscriptionEvent =
  | {
      readonly type: 'transcript'
      readonly sessionId: string
      readonly generation: number
      readonly replacement: SeedAsrTranscriptReplacement
    }
  | {
      readonly type: 'audio_status'
      readonly sessionId: string
      readonly generation: number
      readonly state: 'ready' | 'starting' | 'capturing' | 'silent' | 'suspended' | 'stopped' | 'error'
      readonly code?: string
      readonly lastFrameTimestampMs?: bigint
    }
  | {
      readonly type: 'error'
      readonly sessionId: string
      readonly generation: number
      readonly subsystem: 'audio' | 'asr'
      readonly code: string
      readonly retryable: boolean
    }

interface AsrSessionLike {
  onEvent(listener: (event: SeedAsrSessionEvent) => void): () => void
  start(): Promise<void>
  sendPcmFrame(pcm16: Uint8Array): Promise<void>
  stop(): Promise<void>
  abort(): void
}

export type AsrSessionFactory = (options: SeedAsrSessionOptions) => AsrSessionLike

type Listener = (event: MainTranscriptionEvent) => void

interface ActivePipeline {
  readonly sessionId: string
  readonly source: NativeAudioSource
  readonly generation: number
  readonly asr: AsrSessionLike
  removeAsrListener: () => void
  readonly pendingSends: Set<Promise<void>>
  audioStarted: boolean
  failing: boolean
}

/**
 * Keeps raw PCM inside the Electron main process:
 * Swift helper -> supervisor -> SeedASR. Renderer consumers receive status and
 * replacement transcripts only; this class never serializes PCM over IPC.
 */
export class MainTranscriptionPipeline {
  private readonly supervisor: AudioHelperSupervisor
  private readonly createAsrSession: AsrSessionFactory
  private readonly listeners = new Set<Listener>()
  private readonly removeSupervisorListener: () => void
  private active: ActivePipeline | null = null
  private generation = 0
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private disposed = false

  constructor(
    supervisor: AudioHelperSupervisor,
    createAsrSession: AsrSessionFactory = (options) => new SeedAsrSession(options),
  ) {
    this.supervisor = supervisor
    this.createAsrSession = createAsrSession
    this.removeSupervisorListener = supervisor.onEvent((event) => this.handleAudioEvent(event))
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(options: MainTranscriptionStartOptions): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Transcription pipeline is disposed'))
    if (this.stopPromise !== null) return Promise.reject(new Error('Transcription pipeline is stopping'))
    if (this.startPromise !== null) return this.startPromise
    if (this.active !== null) {
      if (this.active.sessionId === options.sessionId && this.active.source === options.source) {
        return Promise.resolve()
      }
      return Promise.reject(new Error('Only one transcription pipeline may be active'))
    }
    this.startPromise = this.startInternal(options).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  stop(sessionId: string): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise
    const current = this.active
    if (current === null) return Promise.resolve()
    if (current.sessionId !== sessionId) {
      return Promise.reject(new Error('Cannot stop a different transcription session'))
    }
    this.stopPromise = this.stopInternal(current).finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const current = this.active
    this.active = null
    current?.removeAsrListener()
    current?.asr.abort()
    this.removeSupervisorListener()
    this.supervisor.dispose()
    this.listeners.clear()
  }

  private async startInternal(options: MainTranscriptionStartOptions): Promise<void> {
    this.generation += 1
    const generation = this.generation
    const asr = this.createAsrSession({
      credentials: options.credentials,
      uid: options.uid,
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.resultType === undefined ? {} : { resultType: options.resultType }),
    })
    const current: ActivePipeline = {
      sessionId: options.sessionId,
      source: options.source,
      generation,
      asr,
      removeAsrListener: () => undefined,
      pendingSends: new Set(),
      audioStarted: false,
      failing: false,
    }
    current.removeAsrListener = asr.onEvent((event) => this.handleAsrEvent(current, event))
    this.active = current
    try {
      // Establish ASR before capture so the first 200 ms PCM frame is not lost.
      await asr.start()
      if (this.active !== current) throw new Error('Transcription start was superseded')
      await this.supervisor.start(options.sessionId, options.source)
      current.audioStarted = true
    } catch (error) {
      if (this.active === current) this.active = null
      current.removeAsrListener()
      asr.abort()
      this.supervisor.abortActive()
      throw error
    }
  }

  private async stopInternal(current: ActivePipeline): Promise<void> {
    if (this.active !== current) return
    let stopError: unknown
    try {
      if (current.audioStarted) await this.supervisor.stop(current.sessionId)
      await Promise.allSettled([...current.pendingSends])
      await current.asr.stop()
    } catch (error) {
      stopError = error
      current.asr.abort()
      this.supervisor.abortActive()
    } finally {
      current.removeAsrListener()
      if (this.active === current) this.active = null
    }
    if (stopError instanceof Error) throw stopError
    if (stopError !== undefined) throw new Error('Transcription stop failed', { cause: stopError })
  }

  private handleAudioEvent(event: AudioSupervisorEvent): void {
    const current = this.active
    if (current === null) return
    if (event.kind === 'pcm') {
      if (event.sessionId !== current.sessionId || event.source !== current.source || current.failing) return
      const send = current.asr.sendPcmFrame(event.pcm16)
        .catch((error: unknown) => {
          this.failCurrent(current, errorCode(error, 'ASR_WRITE_FAILED'), 'asr', true)
        })
      current.pendingSends.add(send)
      void send.finally(() => current.pendingSends.delete(send))
      return
    }
    if (event.kind === 'status') {
      if (event.sessionId !== '' && event.sessionId !== current.sessionId) return
      this.emit({
        type: 'audio_status',
        sessionId: current.sessionId,
        generation: current.generation,
        state: event.state,
        ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.lastFrameTimestampMs === undefined ? {} : { lastFrameTimestampMs: event.lastFrameTimestampMs }),
      })
      return
    }
    if (event.kind === 'supervisor_error') {
      this.emit({
        type: 'error',
        sessionId: current.sessionId,
        generation: current.generation,
        subsystem: 'audio',
        code: event.code,
        retryable: event.retryable,
      })
      if (!event.retryable) this.failCurrent(current, event.code, 'audio', false, false)
    }
  }

  private handleAsrEvent(current: ActivePipeline, event: SeedAsrSessionEvent): void {
    if (this.active !== current) return
    if (event.type === 'transcript') {
      this.emit({
        type: 'transcript',
        sessionId: current.sessionId,
        generation: current.generation,
        replacement: event.replacement,
      })
    } else if (event.type === 'error') {
      this.failCurrent(current, event.code, 'asr', event.retryable)
    }
  }

  private failCurrent(
    current: ActivePipeline,
    code: string,
    subsystem: 'audio' | 'asr',
    retryable: boolean,
    emitError = true,
  ): void {
    if (this.active !== current || current.failing) return
    current.failing = true
    if (emitError) {
      this.emit({
        type: 'error', sessionId: current.sessionId, generation: current.generation,
        subsystem, code, retryable,
      })
    }
    if (this.active === current) this.active = null
    current.removeAsrListener()
    current.asr.abort()
    this.supervisor.abortActive()
  }

  private emit(event: MainTranscriptionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function errorCode(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return fallback
}
