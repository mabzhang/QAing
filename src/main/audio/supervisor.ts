import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { audioInputLevelFromPcm, type AudioInputLevelEvent } from './audio-level'
import {
  AudioHelperFrameDecoder,
  encodeAudioHelperCommand,
  type AudioHelperEvent,
  type NativeAudioSource,
} from './protocol'

export interface AudioHelperChild {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly killed: boolean
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
}

export interface AudioHelperSupervisorOptions {
  readonly helperPath: string
  readonly spawnChild?: (helperPath: string) => AudioHelperChild
  readonly heartbeatTimeoutMs?: number
  readonly helperReadyTimeoutMs?: number
  readonly startAckTimeoutMs?: number
  readonly captureAckTimeoutMs?: number
  readonly terminationTimeoutMs?: number
  readonly gracefulStopTimeoutMs?: number
  readonly maxRestarts?: number
  readonly restartDelayMs?: number
  readonly logger?: AudioSafeLogger
}

export interface AudioSafeLogger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void
}

export type AudioSupervisorEvent =
  | AudioHelperEvent
  | AudioInputLevelEvent
  | { readonly kind: 'supervisor_error'; readonly code: string; readonly retryable: boolean }

type Listener = (event: AudioSupervisorEvent) => void

export interface ActiveAudioCapture {
  readonly sessionId: string
  readonly source: NativeAudioSource
}

export type AudioSupervisorStatus = 'idle' | 'active' | 'stopping' | 'disposed'

export type AudioHelperStartErrorCode =
  | 'HELPER_READY_TIMEOUT'
  | 'START_ACK_TIMEOUT'
  | 'CAPTURE_ACK_TIMEOUT'
  | 'AUDIO_START_ABORTED'
  | 'AUDIO_START_CANCELLED'
  | 'RESTART_LIMIT'

export class AudioHelperStartError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, retryable: boolean, message = 'Native audio capture could not start') {
    super(message)
    this.name = 'AudioHelperStartError'
    this.code = code
    this.retryable = retryable
  }
}

type StartHandshakePhase = 'helper_ready' | 'start_ack' | 'capture_ack'

export class AudioHelperSupervisor {
  private readonly options: Required<Pick<AudioHelperSupervisorOptions,
    | 'heartbeatTimeoutMs'
    | 'helperReadyTimeoutMs'
    | 'startAckTimeoutMs'
    | 'captureAckTimeoutMs'
    | 'terminationTimeoutMs'
    | 'gracefulStopTimeoutMs'
    | 'maxRestarts'
    | 'restartDelayMs'>> & AudioHelperSupervisorOptions
  private readonly spawnChild: (helperPath: string) => AudioHelperChild
  private readonly logger: AudioSafeLogger
  private readonly listeners = new Set<Listener>()
  private child: AudioHelperChild | null = null
  private readyChild: AudioHelperChild | null = null
  private active: ActiveAudioCapture | null = null
  private restartCount = 0
  private lastHeartbeatAt = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  private handshakePhase: StartHandshakePhase | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private startPromise: Promise<void> | null = null
  private startResolve: (() => void) | null = null
  private startReject: ((error: Error) => void) | null = null
  private stopPromise: Promise<void> | null = null
  private stopResolve: (() => void) | null = null
  private stopReject: ((error: Error) => void) | null = null
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private expectedExit = false
  private operationGeneration = 0
  private terminatingChild: AudioHelperChild | null = null
  private recoverySignalledChild: AudioHelperChild | null = null
  private readonly terminationTimers = new Map<AudioHelperChild, ReturnType<typeof setTimeout>>()

  constructor(options: AudioHelperSupervisorOptions) {
    this.options = {
      ...options,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 5_000,
      helperReadyTimeoutMs: options.helperReadyTimeoutMs ?? 2_000,
      startAckTimeoutMs: options.startAckTimeoutMs ?? 2_000,
      captureAckTimeoutMs: options.captureAckTimeoutMs ?? 10_000,
      terminationTimeoutMs: options.terminationTimeoutMs ?? 1_500,
      gracefulStopTimeoutMs: options.gracefulStopTimeoutMs ?? 2_000,
      maxRestarts: options.maxRestarts ?? 2,
      restartDelayMs: options.restartDelayMs ?? 250,
    }
    this.spawnChild = options.spawnChild ?? defaultSpawn
    this.logger = options.logger ?? noOpLogger
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get status(): AudioSupervisorStatus {
    if (this.disposed) return 'disposed'
    if (this.stopPromise !== null) return 'stopping'
    return this.active === null ? 'idle' : 'active'
  }

  get activeSession(): Readonly<ActiveAudioCapture> | null {
    return this.active === null ? null : { ...this.active }
  }

  start(sessionId: string, source: NativeAudioSource): Promise<void> {
    if (this.disposed) throw new Error('Audio helper supervisor is disposed')
    if (this.stopPromise !== null) throw new Error('Audio helper supervisor is stopping')
    if (this.active !== null) {
      if (this.active.sessionId === sessionId && this.active.source === source) {
        return this.startPromise ?? Promise.resolve()
      }
      throw new Error('Only one native audio source may be active')
    }
    const command = { command: 'start' as const, sessionId, source }
    encodeAudioHelperCommand(command)
    this.active = { sessionId, source }
    this.operationGeneration += 1
    this.restartCount = 0
    const promise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
    })
    this.startPromise = promise
    try {
      this.ensureChild()
      this.beginStartHandshake()
    } catch (error) {
      this.rejectStart(error instanceof Error ? error : new Error('Native audio helper could not start'))
      this.tearDownActive()
    }
    return promise
  }

  stop(sessionId: string): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise
    if (this.active === null) return Promise.resolve()
    if (this.active.sessionId !== sessionId) return Promise.reject(new Error('Cannot stop a different audio session'))
    if (this.startPromise !== null) {
      this.rejectStart(new AudioHelperStartError('AUDIO_START_CANCELLED', false))
      this.tearDownActive()
      return Promise.resolve()
    }
    if (this.child === null || this.terminatingChild === this.child) {
      // There is no healthy helper to acknowledge a graceful stop while a
      // recovery termination/restart is in flight. Treat the user's stop as a
      // local cancellation and invalidate the pending recovery generation.
      this.abortActive()
      return Promise.resolve()
    }

    const stopPromise = new Promise<void>((resolve, reject) => {
      this.stopResolve = resolve
      this.stopReject = reject
    })
    this.stopPromise = stopPromise
    try {
      this.writeCommand({ command: 'stop', sessionId })
      this.stopTimer = setTimeout(() => {
        this.logger.warn('audio_helper_stop_timeout')
        this.abortActive()
      }, this.options.gracefulStopTimeoutMs)
    } catch (error) {
      const reject = this.stopReject
      this.tearDownActive()
      reject?.(error instanceof Error ? error : new Error('Audio helper stop command failed'))
    }
    return stopPromise
  }

  /** Immediately tears down the active child while keeping this supervisor reusable. */
  abortActive(): void {
    if (this.disposed) return
    this.rejectStart(new AudioHelperStartError('AUDIO_START_ABORTED', false))
    this.stopResolve?.()
    this.tearDownActive()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.operationGeneration += 1
    this.active = null
    this.rejectStart(new AudioHelperStartError('AUDIO_START_ABORTED', false))
    this.clearStopTimer()
    this.clearWatchdog()
    this.clearHandshake()
    this.expectedExit = true
    const child = this.child
    this.child = null
    this.readyChild = null
    this.terminatingChild = null
    this.requestDetachedShutdown(child, 'SIGTERM')
    this.completeStop()
    this.listeners.clear()
  }

  private ensureChild(): void {
    if (this.child !== null) return
    this.expectedExit = false
    this.terminatingChild = null
    this.recoverySignalledChild = null
    const decoder = new AudioHelperFrameDecoder()
    const child = this.spawnChild(this.options.helperPath)
    this.child = child
    this.readyChild = null
    this.lastHeartbeatAt = Date.now()
    child.stdout.on('data', (chunk: Buffer) => this.handleStdout(child, decoder, chunk))
    child.stdout.on('end', () => {
      if (this.child !== child) return
      try {
        decoder.end()
      } catch {
        this.emit({ kind: 'supervisor_error', code: 'TRUNCATED_HELPER_STREAM', retryable: true })
        this.recoverySignalledChild = child
      }
    })
    child.stderr.on('data', () => {
      if (this.child !== child) return
      // Deliberately discard helper stderr content. It can contain OS-provided details.
      this.logger.warn('audio_helper_stderr')
    })
    child.once('error', () => this.handleChildFailure(child, 'SPAWN_ERROR'))
    child.once('exit', () => this.handleChildExit(child))
    this.startWatchdog()
  }

  private handleStdout(child: AudioHelperChild, decoder: AudioHelperFrameDecoder, chunk: Buffer): void {
    if (this.child !== child) return
    if (this.terminatingChild === child) return
    let events: AudioHelperEvent[]
    try {
      events = decoder.push(chunk)
    } catch {
      this.emit({ kind: 'supervisor_error', code: 'INVALID_HELPER_PROTOCOL', retryable: true })
      this.recoverySignalledChild = child
      this.expectedExit = false
      this.requestRecoveryTermination(child, 'SIGKILL')
      return
    }
    for (const event of events) {
      if (event.kind === 'heartbeat') this.lastHeartbeatAt = Date.now()
      if (event.kind === 'status' && event.sessionId === '' && event.state === 'ready') {
        this.readyChild = child
        if (this.handshakePhase === 'helper_ready') this.sendActiveStartCommand()
      }
      if (event.sessionId !== '' && (
        this.active === null
        || event.sessionId !== this.active.sessionId
        || event.source !== this.active.source
      )) {
        continue
      }
      this.advanceStartHandshake(event)
      if (event.kind === 'pcm') this.emit(audioInputLevelFromPcm(event))
      this.emit(event)
      if (event.kind === 'status' && event.state === 'stopped' && this.active?.sessionId === event.sessionId) {
        this.completeStop()
      }
      if (event.kind === 'status' && event.state === 'error') {
        const code = event.code ?? 'CAPTURE_ERROR'
        const retryable = code === 'CAPTURE_INTERRUPTED' || code === 'DEAD_AUDIO_STREAM'
        this.emit({ kind: 'supervisor_error', code, retryable })
        if (this.startPromise !== null) {
          this.rejectStart(new AudioHelperStartError(code, retryable))
          this.tearDownActive()
          return
        } else if (retryable) {
          this.recoverySignalledChild = child
          this.expectedExit = false
          this.requestRecoveryTermination(child, 'SIGTERM')
          return
        } else {
          this.abortActive()
        }
      }
    }
  }

  private handleChildExit(exitedChild: AudioHelperChild): void {
    this.clearTerminationTimer(exitedChild)
    if (this.child !== exitedChild) return
    const recoveryAlreadySignalled = this.recoverySignalledChild === exitedChild
    if (recoveryAlreadySignalled) this.recoverySignalledChild = null
    this.child = null
    if (this.readyChild === exitedChild) this.readyChild = null
    if (this.terminatingChild === exitedChild) this.terminatingChild = null
    this.clearWatchdog()
    this.clearHandshake()
    if (this.stopPromise !== null) {
      this.completeStop()
      return
    }
    if (this.expectedExit || this.disposed || this.active === null) {
      this.expectedExit = false
      return
    }
    this.restartOrFail('UNEXPECTED_EXIT', !recoveryAlreadySignalled)
  }

  private handleChildFailure(failedChild: AudioHelperChild, code: string): void {
    if (this.child !== failedChild) return
    if (this.expectedExit || this.disposed || this.active === null) return
    const recoveryAlreadySignalled = this.recoverySignalledChild === failedChild
    if (recoveryAlreadySignalled) this.recoverySignalledChild = null
    this.child = null
    if (this.readyChild === failedChild) this.readyChild = null
    if (this.terminatingChild === failedChild) this.terminatingChild = null
    this.clearWatchdog()
    this.clearHandshake()
    this.clearTerminationTimer(failedChild)
    this.requestDetachedShutdown(failedChild, 'SIGTERM')
    if (this.stopPromise !== null) {
      this.completeStop()
      return
    }
    this.restartOrFail(code, !recoveryAlreadySignalled)
  }

  private restartOrFail(code: string, emitRecovering = true): void {
    if (this.restartCount >= this.options.maxRestarts) {
      this.emit({ kind: 'supervisor_error', code: 'RESTART_LIMIT', retryable: false })
      this.rejectStart(new AudioHelperStartError('RESTART_LIMIT', false))
      this.active = null
      this.operationGeneration += 1
      this.clearHandshake()
      this.stopReject?.(new Error('Audio helper restart limit exceeded'))
      this.resetStopPromise()
      return
    }
    this.restartCount += 1
    if (emitRecovering) this.emit({ kind: 'supervisor_error', code, retryable: true })
    this.logger.warn('audio_helper_restart', { attempt: this.restartCount, reason: code })
    const generation = this.operationGeneration
    setTimeout(() => {
      if (this.disposed || generation !== this.operationGeneration || this.active === null || this.child !== null) return
      try {
        this.ensureChild()
        this.beginStartHandshake()
      } catch {
        this.abortActive()
        this.clearWatchdog()
        this.emit({ kind: 'supervisor_error', code: 'RESTART_SPAWN_FAILED', retryable: false })
      }
    }, this.options.restartDelayMs)
  }

  private startWatchdog(): void {
    this.clearWatchdog()
    const interval = Math.max(100, Math.floor(this.options.heartbeatTimeoutMs / 2))
    this.watchdog = setInterval(() => {
      if (this.child === null || this.active === null) return
      if (this.terminatingChild === this.child) return
      if (Date.now() - this.lastHeartbeatAt <= this.options.heartbeatTimeoutMs) return
      if (this.stopPromise !== null) {
        const child = this.child
        this.child = null
        if (this.readyChild === child) this.readyChild = null
        this.terminatingChild = null
        this.clearWatchdog()
        this.requestDetachedShutdown(child, 'SIGKILL')
        this.completeStop()
        return
      }
      this.emit({ kind: 'supervisor_error', code: 'HEARTBEAT_TIMEOUT', retryable: true })
      this.recoverySignalledChild = this.child
      this.expectedExit = false
      this.requestRecoveryTermination(this.child, 'SIGKILL')
    }, interval)
    this.watchdog.unref?.()
  }

  private writeCommand(command: Parameters<typeof encodeAudioHelperCommand>[0]): void {
    const child = this.child
    if (child === null || child.killed || !child.stdin.writable) {
      throw new Error('Audio helper is not writable')
    }
    const frame = encodeAudioHelperCommand(command)
    child.stdin.write(frame, (error) => {
      if (error !== null && error !== undefined) this.handleChildFailure(child, 'COMMAND_WRITE_FAILED')
    })
  }

  private beginStartHandshake(): void {
    if (this.active === null || this.child === null) return
    if (this.readyChild === this.child) {
      this.sendActiveStartCommand()
      return
    }
    this.armHandshake('helper_ready', this.options.helperReadyTimeoutMs)
  }

  private sendActiveStartCommand(): void {
    const active = this.active
    if (active === null || this.child === null || this.readyChild !== this.child) return
    try {
      this.armHandshake('start_ack', this.options.startAckTimeoutMs)
      this.writeCommand({ command: 'start', sessionId: active.sessionId, source: active.source })
    } catch (error) {
      this.rejectStart(error instanceof Error ? error : new Error('Native audio start command failed'))
      this.tearDownActive()
    }
  }

  private advanceStartHandshake(event: AudioHelperEvent): void {
    const active = this.active
    if (active === null) return
    if (event.sessionId !== active.sessionId || event.source !== active.source) return
    if (event.kind === 'status' && event.state === 'starting') {
      if (
        this.stopPromise === null
        && (this.handshakePhase === 'start_ack' || this.handshakePhase === null)
      ) this.armHandshake('capture_ack', this.options.captureAckTimeoutMs)
      return
    }
    if (this.handshakePhase === null) return
    const captureConfirmed = event.kind === 'pcm'
      || (event.kind === 'status' && (event.state === 'capturing' || event.state === 'silent'))
    if (!captureConfirmed) return
    this.clearHandshake()
    const resolve = this.startResolve
    this.resetStartPromise()
    resolve?.()
  }

  private armHandshake(phase: StartHandshakePhase, timeoutMs: number): void {
    this.clearHandshakeTimer()
    this.handshakePhase = phase
    const generation = this.operationGeneration
    const child = this.child
    this.handshakeTimer = setTimeout(() => {
      if (this.disposed || generation !== this.operationGeneration || child === null || this.child !== child) return
      if (this.handshakePhase !== phase || this.active === null) return
      const code = phase === 'helper_ready'
        ? 'HELPER_READY_TIMEOUT'
        : phase === 'start_ack' ? 'START_ACK_TIMEOUT' : 'CAPTURE_ACK_TIMEOUT'
      this.logger.warn('audio_helper_handshake_timeout', { phase })
      this.emit({ kind: 'supervisor_error', code, retryable: true })
      this.recoverySignalledChild = child
      this.clearHandshake()
      if (this.startPromise !== null) {
        this.rejectStart(new AudioHelperStartError(code, true))
        this.tearDownActive()
        return
      }
      this.expectedExit = false
      this.requestRecoveryTermination(child, 'SIGKILL')
    }, timeoutMs)
    this.handshakeTimer.unref?.()
  }

  private clearHandshake(): void {
    this.clearHandshakeTimer()
    this.handshakePhase = null
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  private requestRecoveryTermination(child: AudioHelperChild, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.child !== child || this.active === null || this.disposed) return
    this.terminatingChild = child
    if (!child.kill(signal)) {
      this.handleTerminationRequestFailure(child)
      return
    }
    this.armTerminationDeadline(child, signal === 'SIGTERM')
  }

  private armTerminationDeadline(child: AudioHelperChild, escalateToKill: boolean): void {
    this.clearTerminationTimer(child)
    const generation = this.operationGeneration
    const timer = setTimeout(() => {
      this.terminationTimers.delete(child)
      if (
        this.disposed
        || generation !== this.operationGeneration
        || this.child !== child
        || this.terminatingChild !== child
        || this.active === null
      ) return
      if (!escalateToKill) {
        this.handleTerminationRequestFailure(child)
        return
      }
      if (!child.kill('SIGKILL')) {
        this.handleTerminationRequestFailure(child)
        return
      }
      // A successful kill request is not proof that the process exited. Keep a
      // second, child-scoped deadline so a broken ChildProcess implementation
      // cannot leave the active session permanently stuck in recovering.
      this.armTerminationDeadline(child, false)
    }, this.options.terminationTimeoutMs)
    this.terminationTimers.set(child, timer)
    timer.unref?.()
  }

  private requestDetachedShutdown(
    child: AudioHelperChild | null,
    signal: 'SIGTERM' | 'SIGKILL',
  ): void {
    if (child === null) return
    this.clearTerminationTimer(child)
    if (!child.kill(signal)) {
      this.logger.warn('audio_helper_termination_rejected', { signal })
      if (signal === 'SIGTERM' && child.kill('SIGKILL')) this.armDetachedKillCheck(child)
      return
    }
    const timer = setTimeout(() => {
      this.terminationTimers.delete(child)
      if (signal === 'SIGTERM') {
        if (!child.kill('SIGKILL')) {
          this.logger.warn('audio_helper_termination_rejected', { signal: 'SIGKILL' })
          return
        }
        this.armDetachedKillCheck(child)
      }
    }, this.options.terminationTimeoutMs)
    this.terminationTimers.set(child, timer)
    timer.unref?.()
  }

  private armDetachedKillCheck(child: AudioHelperChild): void {
    this.clearTerminationTimer(child)
    const timer = setTimeout(() => {
      this.terminationTimers.delete(child)
      this.logger.warn('audio_helper_did_not_exit_after_sigkill')
    }, this.options.terminationTimeoutMs)
    this.terminationTimers.set(child, timer)
    timer.unref?.()
  }

  private handleTerminationRequestFailure(child: AudioHelperChild): void {
    if (this.child !== child) return
    const recoveryAlreadySignalled = this.recoverySignalledChild === child
    if (recoveryAlreadySignalled) this.recoverySignalledChild = null
    this.child = null
    if (this.readyChild === child) this.readyChild = null
    if (this.terminatingChild === child) this.terminatingChild = null
    this.clearWatchdog()
    this.clearHandshake()
    this.clearTerminationTimer(child)
    if (this.stopPromise !== null) {
      this.completeStop()
      return
    }
    this.restartOrFail('TERMINATION_REQUEST_FAILED', !recoveryAlreadySignalled)
  }

  private clearTerminationTimer(child: AudioHelperChild): void {
    const timer = this.terminationTimers.get(child)
    if (timer !== undefined) clearTimeout(timer)
    this.terminationTimers.delete(child)
  }

  private rejectStart(error: Error): void {
    const reject = this.startReject
    this.resetStartPromise()
    reject?.(error)
  }

  private resetStartPromise(): void {
    this.startPromise = null
    this.startResolve = null
    this.startReject = null
  }

  private completeStop(): void {
    this.clearStopTimer()
    this.clearHandshake()
    this.active = null
    this.stopResolve?.()
    this.resetStopPromise()
  }

  private tearDownActive(): void {
    const child = this.child
    this.operationGeneration += 1
    this.active = null
    this.child = null
    this.readyChild = null
    this.terminatingChild = null
    this.recoverySignalledChild = null
    this.clearStopTimer()
    this.clearWatchdog()
    this.clearHandshake()
    if (child !== null) this.clearTerminationTimer(child)
    this.requestDetachedShutdown(child, 'SIGTERM')
    this.resetStopPromise()
    this.expectedExit = false
  }

  private resetStopPromise(): void {
    this.stopPromise = null
    this.stopResolve = null
    this.stopReject = null
  }

  private clearStopTimer(): void {
    if (this.stopTimer !== null) clearTimeout(this.stopTimer)
    this.stopTimer = null
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog)
    this.watchdog = null
  }

  private emit(event: AudioSupervisorEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function defaultSpawn(helperPath: string): ChildProcessWithoutNullStreams {
  return spawn(helperPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    env: {},
  })
}

const noOpLogger: AudioSafeLogger = {
  info: () => undefined,
  warn: () => undefined,
}
