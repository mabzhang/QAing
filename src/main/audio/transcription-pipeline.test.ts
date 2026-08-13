import { describe, expect, it, vi } from 'vitest'
import type { SeedAsrSessionEvent } from '../asr'
import type { AudioSupervisorEvent } from './supervisor'
import { MainTranscriptionPipeline, type AsrSessionFactory } from './transcription-pipeline'

class FakeSupervisor {
  readonly order: string[]
  readonly starts: unknown[] = []
  readonly stops: string[] = []
  disposed = false
  startError: Error | null = null
  private readonly listeners = new Set<(event: AudioSupervisorEvent) => void>()

  constructor(order: string[]) { this.order = order }

  onEvent(listener: (event: AudioSupervisorEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(sessionId: string, source: 'microphone' | 'system'): Promise<void> {
    this.order.push('audio:start')
    this.starts.push({ sessionId, source })
    if (this.startError !== null) throw this.startError
  }

  async stop(sessionId: string): Promise<void> {
    this.order.push('audio:stop')
    this.stops.push(sessionId)
  }

  abortActive(): void {
    this.order.push('audio:abort')
  }

  dispose(): void { this.disposed = true }

  emit(event: AudioSupervisorEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

class FakeAsr {
  readonly order: string[]
  readonly frames: Buffer[] = []
  abortCalls = 0
  private readonly listeners = new Set<(event: SeedAsrSessionEvent) => void>()

  constructor(order: string[]) { this.order = order }

  onEvent(listener: (event: SeedAsrSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> { this.order.push('asr:start') }
  async sendPcmFrame(frame: Uint8Array): Promise<void> { this.frames.push(Buffer.from(frame)) }
  async stop(): Promise<void> { this.order.push('asr:stop') }
  abort(): void { this.abortCalls += 1 }

  emit(event: SeedAsrSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function makePipeline() {
  const order: string[] = []
  const supervisor = new FakeSupervisor(order)
  const asr = new FakeAsr(order)
  const factory: AsrSessionFactory = () => asr
  const pipeline = new MainTranscriptionPipeline(supervisor as never, factory)
  return { order, supervisor, asr, pipeline }
}

const startOptions = {
  sessionId: 's1',
  source: 'system' as const,
  credentials: { apiKey: 'test-only', resourceId: 'test-resource' },
  uid: 'device',
}

describe('MainTranscriptionPipeline', () => {
  it('starts ASR first and routes helper PCM directly inside main', async () => {
    const { pipeline, supervisor, asr, order } = makePipeline()
    await pipeline.start(startOptions)
    supervisor.emit({
      kind: 'pcm', sessionId: 'stale', source: 'system', sequence: 1n,
      timestampMs: 1n, energy: 0.1, pcm16: Buffer.alloc(6_400, 1),
    })
    supervisor.emit({
      kind: 'pcm', sessionId: 's1', source: 'system', sequence: 2n,
      timestampMs: 2n, energy: 0.2, pcm16: Buffer.alloc(6_400, 7),
    })
    await vi.waitFor(() => expect(asr.frames).toHaveLength(1))
    expect(order).toEqual(['asr:start', 'audio:start'])
    expect(asr.frames[0]).toEqual(Buffer.alloc(6_400, 7))
    pipeline.dispose()
  })

  it('stops capture, drains PCM, then finalizes ASR idempotently', async () => {
    const { pipeline, order } = makePipeline()
    await pipeline.start(startOptions)
    const first = pipeline.stop('s1')
    expect(pipeline.stop('s1')).toBe(first)
    await first
    expect(order).toEqual(['asr:start', 'audio:start', 'audio:stop', 'asr:stop'])
  })

  it('only exposes status and replacement transcripts, never PCM events', async () => {
    const { pipeline, supervisor, asr } = makePipeline()
    const events: unknown[] = []
    pipeline.onEvent((event) => events.push(event))
    await pipeline.start(startOptions)
    supervisor.emit({
      kind: 'pcm', sessionId: 's1', source: 'system', sequence: 1n,
      timestampMs: 1n, energy: 0, pcm16: Buffer.alloc(6_400),
    })
    supervisor.emit({
      kind: 'audio_level', sessionId: 's1', source: 'system', sequence: 1n,
      timestampMs: 1n, level: 0,
    })
    supervisor.emit({
      kind: 'status', sessionId: 's1', source: 'system', sequence: 1n,
      timestampMs: 1n, state: 'silent', code: 'ZERO_ENERGY',
    })
    asr.emit({
      type: 'transcript',
      replacement: {
        type: 'transcript_replace', sequence: 2, isFinalPacket: false,
        fullText: 'replacement', utterances: [],
      },
    })
    expect(events).toEqual([
      expect.objectContaining({ type: 'audio_status', state: 'silent', generation: 1 }),
      expect.objectContaining({ type: 'transcript', generation: 1 }),
    ])
    expect(events.some((event) => typeof event === 'object' && event !== null && 'pcm16' in event)).toBe(false)
    pipeline.dispose()
  })

  it('aborts ASR after a non-retryable native capture failure', async () => {
    const { pipeline, supervisor, asr } = makePipeline()
    await pipeline.start(startOptions)
    supervisor.emit({ kind: 'supervisor_error', code: 'SCREEN_PERMISSION_REQUIRED', retryable: false })
    expect(asr.abortCalls).toBe(1)
    expect(supervisor.stops).toEqual([])
    expect(supervisor.order).toContain('audio:abort')
    pipeline.dispose()
  })

  it('waits for the native capture acknowledgement and aborts ASR if startup times out', async () => {
    const { pipeline, supervisor, asr, order } = makePipeline()
    supervisor.startError = Object.assign(new Error('capture timeout'), {
      code: 'CAPTURE_ACK_TIMEOUT', retryable: true,
    })
    await expect(pipeline.start(startOptions)).rejects.toMatchObject({ code: 'CAPTURE_ACK_TIMEOUT' })
    expect(order).toEqual(['asr:start', 'audio:start', 'audio:abort'])
    expect(asr.abortCalls).toBe(1)
    expect(supervisor.starts).toEqual([{ sessionId: 's1', source: 'system' }])
    pipeline.dispose()
  })
})
