import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationController, type ApplicationRepository, type AsrRuntime, type RagRuntime } from '../app/controller'
import { encodeAudioHelperEventForTest } from '../audio/protocol'
import { AudioHelperSupervisor, type AudioHelperChild, type AudioSupervisorEvent } from '../audio/supervisor'
import { SecureLogger } from '../security/secure-logger'
import { NativeAudioRuntime } from './adapters'

class FakeSupervisor {
  readonly listeners = new Set<(event: AudioSupervisorEvent) => void>()
  start = vi.fn<() => Promise<void>>(async () => undefined)
  stop = vi.fn<() => Promise<void>>(async () => undefined)
  abortActive = vi.fn()
  dispose = vi.fn()

  onEvent(listener: (event: AudioSupervisorEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: AudioSupervisorEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

class FakeAudioChild extends EventEmitter implements AudioHelperChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  kill(): boolean { this.killed = true; return true }
  exit(): void { this.emit('exit', 1, null) }
}

function emitStatus(
  child: FakeAudioChild,
  sessionId: string,
  state: 'ready' | 'starting' | 'capturing',
): void {
  child.stdout.write(encodeAudioHelperEventForTest({
    kind: 'status',
    sessionId: state === 'ready' ? '' : sessionId,
    source: state === 'ready' ? null : 'system',
    sequence: 0n,
    timestampMs: 1n,
    state,
  }))
}

describe('NativeAudioRuntime', () => {
  it('changes ready to recovering immediately on unexpected exit and returns ready after restart capture', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeAudioChild(), new FakeAudioChild()]
      let childIndex = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper',
        spawnChild: () => children[childIndex++]!,
        restartDelayMs: 10,
      })
      const runtime = new NativeAudioRuntime(supervisor)
      const started = runtime.start({
        sessionId: 's1', source: 'system', onPcmFrame: async () => undefined, onFailure: vi.fn(),
      })
      emitStatus(children[0]!, 's1', 'ready')
      emitStatus(children[0]!, 's1', 'starting')
      emitStatus(children[0]!, 's1', 'capturing')
      await started
      expect(runtime.status).toBe('ready')

      children[0]!.exit()
      expect(runtime.status).toBe('recovering')
      await vi.advanceTimersByTimeAsync(11)
      emitStatus(children[1]!, 's1', 'ready')
      emitStatus(children[1]!, 's1', 'starting')
      emitStatus(children[1]!, 's1', 'capturing')
      expect(runtime.status).toBe('ready')
      runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps level sequence across same-session restart and resets it for a new session', async () => {
    const supervisor = new FakeSupervisor()
    const samples: Array<{ sessionId: string; sequence: number }> = []
    const runtime = new NativeAudioRuntime(supervisor as never, undefined, undefined, (sample) => {
      samples.push({ sessionId: sample.sessionId, sequence: sample.sequence })
    })
    const input = (sessionId: string) => ({
      sessionId, source: 'microphone' as const, onPcmFrame: async () => undefined, onFailure: vi.fn(),
    })
    await runtime.start(input('s1'))
    supervisor.emit({
      kind: 'audio_level', sessionId: 's1', source: 'microphone', sequence: 1n, timestampMs: 1n, level: 0.1,
    })
    supervisor.emit({ kind: 'supervisor_error', code: 'UNEXPECTED_EXIT', retryable: true })
    supervisor.emit({
      kind: 'audio_level', sessionId: 's1', source: 'microphone', sequence: 1n, timestampMs: 2n, level: 0.2,
    })
    await runtime.stop()
    await runtime.start(input('s2'))
    supervisor.emit({
      kind: 'audio_level', sessionId: 's2', source: 'microphone', sequence: 1n, timestampMs: 3n, level: 0.3,
    })
    expect(samples).toEqual([
      { sessionId: 's1', sequence: 1 },
      { sessionId: 's1', sequence: 2 },
      { sessionId: 's2', sequence: 1 },
    ])
    runtime.dispose()
  })

  it('does not let an old rejected start clean up a newer session', async () => {
    const supervisor = new FakeSupervisor()
    let rejectOld: ((error: Error) => void) | undefined
    supervisor.start
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject }))
      .mockResolvedValueOnce(undefined)
    const runtime = new NativeAudioRuntime(supervisor as never)
    const input = (sessionId: string) => ({
      sessionId, source: 'microphone' as const, onPcmFrame: async () => undefined, onFailure: vi.fn(),
    })
    const oldStart = runtime.start(input('old'))
    const oldRejected = expect(oldStart).rejects.toThrow('old rejected late')
    runtime.abort()
    await runtime.start(input('new'))
    rejectOld?.(new Error('old rejected late'))
    await oldRejected

    await runtime.stop()
    expect(supervisor.stop).toHaveBeenLastCalledWith('new')
    runtime.dispose()
  })

  it('preserves retryable ASR PCM failures for the controller recovery gate', async () => {
    const supervisor = new FakeSupervisor()
    const failures: Array<{ code: string; retryable: boolean }> = []
    const runtime = new NativeAudioRuntime(supervisor as never)
    await runtime.start({
      sessionId: 's1',
      source: 'microphone',
      onPcmFrame: async () => {
        throw Object.assign(new Error('queue full'), { code: 'BACKPRESSURE', retryable: true })
      },
      onFailure: (code, retryable) => failures.push({ code, retryable }),
    })
    supervisor.emit({
      kind: 'pcm', sessionId: 's1', source: 'microphone', sequence: 1n, timestampMs: 1n,
      energy: 0.1, pcm16: Buffer.alloc(6_400),
    })
    await vi.waitFor(() => expect(failures).toEqual([{ code: 'BACKPRESSURE', retryable: true }]))
    runtime.dispose()
  })

  it('routes three real PCM write failures through exactly two controller recoveries', async () => {
    vi.useFakeTimers()
    try {
      const supervisor = new FakeSupervisor()
      const runtime = new NativeAudioRuntime(supervisor as never)
      const startAsr = vi.fn(async () => undefined)
      const sendPcmFrame = vi.fn(async () => {
        throw Object.assign(new Error('queue full'), { code: 'BACKPRESSURE', retryable: true })
      })
      const asr: AsrRuntime = {
        start: startAsr,
        sendPcmFrame,
        stopAndFinalize: vi.fn(async () => undefined),
        abort: vi.fn(),
      }
      const repository: ApplicationRepository = {
        beginSession: vi.fn(async () => ({ projectId: 'project-test' })),
        endSession: vi.fn(async () => undefined),
        saveTurn: vi.fn(async () => undefined),
        ensureQaRound: vi.fn(async () => ({ dataRevision: 1 })),
        saveQaAnswerVersion: vi.fn(async () => ({ versionId: 'v1', inserted: true, dataRevision: 2 })),
        commitQaRound: vi.fn(async () => ({ dataRevision: 3 })),
        closeQaRound: vi.fn(async () => ({ dataRevision: 4 })),
        persistFrontSnapshot: vi.fn(async () => undefined),
        persistFrontTranscript: vi.fn(async () => ({ documentId: 'unused' })),
        indexStructuredFront: vi.fn(async () => undefined),
      }
      const rag: RagRuntime = {
        streamAnswer: vi.fn(async (): ReturnType<RagRuntime['streamAnswer']> => ({
          references: [],
          retrievalRoute: 'source_document',
          refused: false,
        })),
        structureTranscript: vi.fn(async () => ''),
      }
      const controller = new ApplicationController({
        audio: runtime,
        asr,
        repository,
        rag,
        logger: new SecureLogger(() => undefined),
      })
      await controller.dispatch({ type: 'start_session' })
      const sessionId = controller.getState().sessionId
      expect(sessionId).not.toBeNull()

      const emitFailingPcm = (sequence: bigint): void => supervisor.emit({
        kind: 'pcm', sessionId: sessionId!, source: 'system', sequence, timestampMs: sequence,
        energy: 0.1, pcm16: Buffer.alloc(6_400),
      })

      emitFailingPcm(1n)
      await vi.waitFor(() => expect(sendPcmFrame).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(251)
      expect(supervisor.start).toHaveBeenCalledTimes(2)

      emitFailingPcm(2n)
      await vi.waitFor(() => expect(sendPcmFrame).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(501)
      expect(supervisor.start).toHaveBeenCalledTimes(3)

      emitFailingPcm(3n)
      await vi.waitFor(() => expect(controller.getState().qaPhase).toBe('error'))
      expect(supervisor.start).toHaveBeenCalledTimes(3)
      expect(startAsr).toHaveBeenCalledTimes(3)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
