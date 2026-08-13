import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { encodeAudioHelperEventForTest, type NativeAudioSource } from './protocol'
import { AudioHelperSupervisor, type AudioHelperChild } from './supervisor'

class FakeChild extends EventEmitter implements AudioHelperChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  readonly commands: unknown[] = []
  readonly killSignals: Array<NodeJS.Signals | undefined> = []
  readonly killResults: boolean[] = []
  private input = Buffer.alloc(0)

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.input = Buffer.concat([this.input, chunk])
      while (this.input.length >= 4) {
        const length = this.input.readUInt32BE(0)
        if (this.input.length < length + 4) break
        this.commands.push(JSON.parse(this.input.subarray(4, 4 + length).toString('utf8')))
        this.input = Buffer.from(this.input.subarray(4 + length))
      }
    })
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true
    this.killSignals.push(signal)
    return this.killResults.shift() ?? true
  }

  exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
  }
}

function helperReady(child: FakeChild): void {
  child.stdout.write(encodeAudioHelperEventForTest({
    kind: 'status', sessionId: '', source: null, sequence: 0n, timestampMs: 1n, state: 'ready',
  }))
}

function heartbeat(child: FakeChild, sessionId = ''): void {
  child.stdout.write(encodeAudioHelperEventForTest({
    kind: 'heartbeat', sessionId, source: null, sequence: 0n, timestampMs: 1n,
  }))
}

function captureStatus(
  child: FakeChild,
  state: 'starting' | 'capturing' | 'stopped',
  sessionId = 's1',
  source: NativeAudioSource = 'system',
): void {
  child.stdout.write(encodeAudioHelperEventForTest({
    kind: 'status', sessionId, source, sequence: 0n, timestampMs: 1n, state,
  }))
}

async function completeStart(
  child: FakeChild,
  started: Promise<void>,
  sessionId = 's1',
  source: NativeAudioSource = 'system',
): Promise<void> {
  helperReady(child)
  captureStatus(child, 'starting', sessionId, source)
  captureStatus(child, 'capturing', sessionId, source)
  await started
}

describe('AudioHelperSupervisor', () => {
  it('waits for explicit ready, start, and capture acknowledgements and keeps start idempotent', async () => {
    const child = new FakeChild()
    const supervisor = new AudioHelperSupervisor({ helperPath: '/fake/helper', spawnChild: () => child })
    const started = supervisor.start('s1', 'system')
    expect(supervisor.start('s1', 'system')).toBe(started)
    expect(child.commands).toEqual([])

    heartbeat(child)
    expect(child.commands).toEqual([])
    let settled = false
    void started.finally(() => { settled = true })
    helperReady(child)
    expect(child.commands).toEqual([{ command: 'start', sessionId: 's1', source: 'system' }])
    captureStatus(child, 'starting', 's1', 'microphone')
    await Promise.resolve()
    expect(settled).toBe(false)
    captureStatus(child, 'starting')
    await Promise.resolve()
    expect(settled).toBe(false)
    captureStatus(child, 'capturing')
    await expect(started).resolves.toBeUndefined()

    expect(supervisor.status).toBe('active')
    expect(supervisor.activeSession).toEqual({ sessionId: 's1', source: 'system' })
    expect(() => supervisor.start('s2', 'microphone')).toThrow('Only one native audio source')
    supervisor.dispose()
  })

  it('does not publish active state when command validation fails', () => {
    const child = new FakeChild()
    const supervisor = new AudioHelperSupervisor({ helperPath: '/fake/helper', spawnChild: () => child })
    expect(() => supervisor.start('bad\nsession', 'system')).toThrow()
    expect(supervisor.status).toBe('idle')
    expect(supervisor.activeSession).toBeNull()
    supervisor.dispose()
  })

  it('rejects a ready timeout even while empty-session heartbeats remain healthy', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => child,
        helperReadyTimeoutMs: 100, heartbeatTimeoutMs: 1_000,
      })
      const started = supervisor.start('s1', 'system')
      const rejected = expect(started).rejects.toMatchObject({ code: 'HELPER_READY_TIMEOUT', retryable: true })
      heartbeat(child)
      await vi.advanceTimersByTimeAsync(101)
      await rejected
      expect(child.commands).toEqual([])
      expect(child.killSignals).toContain('SIGTERM')
      expect(supervisor.status).toBe('idle')
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('separately bounds command acceptance and hardware capture acknowledgements', async () => {
    vi.useFakeTimers()
    try {
      const first = new FakeChild()
      const firstSupervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => first, startAckTimeoutMs: 100,
      })
      const firstStart = firstSupervisor.start('s1', 'system')
      const firstRejected = expect(firstStart).rejects.toMatchObject({ code: 'START_ACK_TIMEOUT' })
      helperReady(first)
      await vi.advanceTimersByTimeAsync(101)
      await firstRejected
      firstSupervisor.dispose()

      const second = new FakeChild()
      const secondSupervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => second, captureAckTimeoutMs: 100,
      })
      const secondStart = secondSupervisor.start('s2', 'microphone')
      const secondRejected = expect(secondStart).rejects.toMatchObject({ code: 'CAPTURE_ACK_TIMEOUT' })
      helperReady(second)
      captureStatus(second, 'starting', 's2', 'microphone')
      heartbeat(second)
      await vi.advanceTimersByTimeAsync(101)
      await secondRejected
      secondSupervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts immediately, ignores stale child output, and remains reusable', async () => {
    const children = [new FakeChild(), new FakeChild()]
    let index = 0
    const supervisor = new AudioHelperSupervisor({
      helperPath: '/fake/helper', spawnChild: () => children[index++]!,
    })
    const events: string[] = []
    supervisor.onEvent((event) => events.push(event.kind))
    const firstStart = supervisor.start('s1', 'system')
    const firstRejected = expect(firstStart).rejects.toMatchObject({ code: 'AUDIO_START_ABORTED' })
    supervisor.abortActive()
    supervisor.abortActive()
    await firstRejected
    expect(children[0]!.killSignals).toEqual(['SIGTERM'])

    const secondStart = supervisor.start('s2', 'microphone')
    await completeStart(children[1]!, secondStart, 's2', 'microphone')
    events.length = 0
    children[0]!.stdout.write(encodeAudioHelperEventForTest({
      kind: 'pcm', sessionId: 's1', source: 'system', sequence: 1n, timestampMs: 1n,
      energy: 0, pcm16: Buffer.alloc(6_400),
    }))
    children[0]!.exit()
    expect(events).toEqual([])
    supervisor.dispose()
  })

  it('restarts capture after an explicit stream interruption error', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!, restartDelayMs: 10,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)
      const errors: string[] = []
      supervisor.onEvent((event) => {
        if (event.kind === 'supervisor_error') errors.push(event.code)
      })
      children[0]!.stdout.write(encodeAudioHelperEventForTest({
        kind: 'status', sessionId: 's1', source: 'system', sequence: 3n, timestampMs: 4n,
        state: 'error', code: 'CAPTURE_INTERRUPTED',
      }))
      children[0]!.exit()
      await vi.advanceTimersByTimeAsync(11)
      expect(children[1]!.commands).toEqual([])
      helperReady(children[1]!)
      expect(children[1]!.commands).toContainEqual({ command: 'start', sessionId: 's1', source: 'system' })
      captureStatus(children[1]!, 'starting')
      captureStatus(children[1]!, 'capturing')
      expect(errors).toContain('CAPTURE_INTERRUPTED')
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('escalates an ignored recovery SIGTERM and restarts the same capture after exit', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!,
        terminationTimeoutMs: 100, restartDelayMs: 10,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)

      children[0]!.stdout.write(encodeAudioHelperEventForTest({
        kind: 'status', sessionId: 's1', source: 'system', sequence: 3n, timestampMs: 4n,
        state: 'error', code: 'DEAD_AUDIO_STREAM',
      }))
      expect(children[0]!.killSignals).toEqual(['SIGTERM'])

      await vi.advanceTimersByTimeAsync(101)
      expect(children[0]!.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
      children[0]!.exit(null, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(11)
      helperReady(children[1]!)
      expect(children[1]!.commands).toContainEqual({ command: 'start', sessionId: 's1', source: 'system' })
      captureStatus(children[1]!, 'starting')
      captureStatus(children[1]!, 'capturing')
      expect(supervisor.activeSession).toEqual({ sessionId: 's1', source: 'system' })
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an old recovery deadline terminate a replacement child', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!,
        terminationTimeoutMs: 100, restartDelayMs: 10,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)
      children[0]!.stdout.write(encodeAudioHelperEventForTest({
        kind: 'status', sessionId: 's1', source: 'system', sequence: 3n, timestampMs: 4n,
        state: 'error', code: 'CAPTURE_INTERRUPTED',
      }))
      await vi.advanceTimersByTimeAsync(50)
      children[0]!.exit(null, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(11)
      helperReady(children[1]!)
      captureStatus(children[1]!, 'starting')
      captureStatus(children[1]!, 'capturing')

      await vi.advanceTimersByTimeAsync(200)
      expect(children[1]!.killSignals).toEqual([])
      expect(supervisor.activeSession).toEqual({ sessionId: 's1', source: 'system' })
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replaces a recovery deadline with bounded detached shutdown when disposed', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => child, terminationTimeoutMs: 100,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(child, started)
      child.stdout.write(encodeAudioHelperEventForTest({
        kind: 'status', sessionId: 's1', source: 'system', sequence: 3n, timestampMs: 4n,
        state: 'error', code: 'CAPTURE_INTERRUPTED',
      }))
      supervisor.dispose()
      await vi.advanceTimersByTimeAsync(201)
      expect(child.killSignals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('escalates a rejected detached SIGTERM directly to SIGKILL', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      child.killResults.push(false, true)
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => child, terminationTimeoutMs: 100,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(child, started)

      supervisor.abortActive()
      expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
      await vi.advanceTimersByTimeAsync(101)
      expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops locally without waiting for a helper already terminating for recovery', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!,
        terminationTimeoutMs: 100, restartDelayMs: 10,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)
      children[0]!.stdout.write(encodeAudioHelperEventForTest({
        kind: 'status', sessionId: 's1', source: 'system', sequence: 3n, timestampMs: 4n,
        state: 'error', code: 'CAPTURE_INTERRUPTED',
      }))

      await expect(supervisor.stop('s1')).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(250)
      expect(index).toBe(1)
      expect(children[0]!.killSignals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL'])
      expect(supervisor.status).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails a rejected termination request immediately into the bounded restart path', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      children[0]!.killResults.push(false)
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!,
        terminationTimeoutMs: 1_000, restartDelayMs: 10,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)
      children[0]!.stdout.write(encodeAudioHelperEventForTest({
        kind: 'status', sessionId: 's1', source: 'system', sequence: 3n, timestampMs: 4n,
        state: 'error', code: 'CAPTURE_INTERRUPTED',
      }))
      expect(children[0]!.killSignals).toEqual(['SIGTERM'])

      await vi.advanceTimersByTimeAsync(11)
      expect(index).toBe(2)
      helperReady(children[1]!)
      expect(children[1]!.commands).toContainEqual({ command: 'start', sessionId: 's1', source: 'system' })
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects start and aborts after a non-retryable permission failure', async () => {
    const child = new FakeChild()
    const supervisor = new AudioHelperSupervisor({ helperPath: '/fake/helper', spawnChild: () => child })
    const started = supervisor.start('s1', 'system')
    const rejected = expect(started).rejects.toMatchObject({ code: 'SCREEN_PERMISSION_REQUIRED', retryable: false })
    helperReady(child)
    captureStatus(child, 'starting')
    child.stdout.write(encodeAudioHelperEventForTest({
      kind: 'status', sessionId: 's1', source: 'system', sequence: 0n, timestampMs: 1n,
      state: 'error', code: 'SCREEN_PERMISSION_REQUIRED',
    }))
    await rejected
    expect(child.killSignals).toEqual(['SIGTERM'])
    expect(supervisor.status).toBe('idle')
    supervisor.dispose()
  })

  it('emits 5 Hz-safe scalar levels beside PCM without logging bytes and ignores stale output', async () => {
    const child = new FakeChild()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const supervisor = new AudioHelperSupervisor({ helperPath: '/fake/helper', spawnChild: () => child, logger })
    const events: unknown[] = []
    supervisor.onEvent((event) => events.push(event))
    const started = supervisor.start('s1', 'system')
    await completeStart(child, started)
    events.length = 0
    child.stdout.write(encodeAudioHelperEventForTest({
      kind: 'pcm', sessionId: 'stale', source: 'system', sequence: 1n, timestampMs: 1n,
      energy: 0.1, pcm16: Buffer.alloc(6_400, 33),
    }))
    child.stdout.write(encodeAudioHelperEventForTest({
      kind: 'pcm', sessionId: 's1', source: 'system', sequence: 2n, timestampMs: 2n,
      energy: 0.2, pcm16: Buffer.alloc(6_400, 44),
    }))
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      kind: 'audio_level', sessionId: 's1', source: 'system', sequence: 2n, timestampMs: 2n,
    })
    expect((events[0] as { level: number }).level).toBeCloseTo(0.2)
    expect(events[1]).toMatchObject({ kind: 'pcm', sessionId: 's1', sequence: 2n })
    expect((events[1] as { energy: number }).energy).toBeCloseTo(0.2)
    expect(JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])).not.toContain('44')
    expect('pcm16' in (events[0] as object)).toBe(false)
    supervisor.dispose()
  })

  it('stops idempotently when the helper confirms stopped', async () => {
    const child = new FakeChild()
    const supervisor = new AudioHelperSupervisor({ helperPath: '/fake/helper', spawnChild: () => child })
    const started = supervisor.start('s1', 'system')
    await completeStart(child, started)
    const first = supervisor.stop('s1')
    expect(supervisor.stop('s1')).toBe(first)
    expect(child.commands.at(-1)).toEqual({ command: 'stop', sessionId: 's1' })
    captureStatus(child, 'stopped')
    await first
    const second = supervisor.start('s2', 'microphone')
    expect(child.commands.at(-1)).toEqual({ command: 'start', sessionId: 's2', source: 'microphone' })
    captureStatus(child, 'starting', 's2', 'microphone')
    captureStatus(child, 'capturing', 's2', 'microphone')
    await second
    supervisor.dispose()
  })

  it('completes stop without restart when the helper exits during graceful stop', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!, restartDelayMs: 10,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)
      const stopped = supervisor.stop('s1')
      children[0]!.exit()
      await expect(stopped).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(20)
      expect(index).toBe(1)
      expect(supervisor.status).toBe('idle')
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a helper that ignores SIGTERM after the stop command write fails', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!, terminationTimeoutMs: 100,
      })
      const child = children[0]!
      const started = supervisor.start('s1', 'system')
      await completeStart(child, started)
      vi.spyOn(child.stdin, 'write').mockImplementationOnce(((...args: unknown[]) => {
        const callback = args.find((argument): argument is (error?: Error | null) => void => typeof argument === 'function')
        queueMicrotask(() => callback?.(new Error('simulated stop write failure')))
        return true
      }) as never)

      await expect(supervisor.stop('s1')).resolves.toBeUndefined()
      expect(child.killSignals).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(101)
      expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(index).toBe(1)
      expect(supervisor.status).toBe('idle')
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminates and completes stop without restart when the watchdog expires during stop', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!, heartbeatTimeoutMs: 100,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)
      const errors: string[] = []
      supervisor.onEvent((event) => {
        if (event.kind === 'supervisor_error') errors.push(event.code)
      })
      const stopped = supervisor.stop('s1')
      await vi.advanceTimersByTimeAsync(201)
      await expect(stopped).resolves.toBeUndefined()
      expect(children[0]!.killSignals).toContain('SIGKILL')
      expect(errors).not.toContain('HEARTBEAT_TIMEOUT')
      expect(index).toBe(1)
      expect(supervisor.status).toBe('idle')
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts an unexpected crash with the same source but stops at the bound', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!, maxRestarts: 2, restartDelayMs: 10,
      })
      const initial = supervisor.start('s1', 'system')
      await completeStart(children[0]!, initial)
      const errors: string[] = []
      supervisor.onEvent((event) => {
        if (event.kind === 'supervisor_error') errors.push(event.code)
      })
      children[0]!.exit()
      expect(errors).toEqual(['UNEXPECTED_EXIT'])
      await vi.advanceTimersByTimeAsync(11)
      helperReady(children[1]!)
      captureStatus(children[1]!, 'starting')
      captureStatus(children[1]!, 'capturing')
      children[1]!.exit()
      await vi.advanceTimersByTimeAsync(11)
      helperReady(children[2]!)
      captureStatus(children[2]!, 'starting')
      captureStatus(children[2]!, 'capturing')
      children[2]!.exit()
      expect(errors).toEqual(['UNEXPECTED_EXIT', 'UNEXPECTED_EXIT', 'RESTART_LIMIT'])
      expect(supervisor.status).toBe('idle')
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits recovering immediately for an unexpected child error before restart', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!,
        restartDelayMs: 10, terminationTimeoutMs: 100,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)
      const errors: Array<{ code: string; retryable: boolean }> = []
      supervisor.onEvent((event) => {
        if (event.kind === 'supervisor_error') errors.push(event)
      })

      children[0]!.emit('error', new Error('simulated child error'))
      expect(errors).toEqual([{ kind: 'supervisor_error', code: 'SPAWN_ERROR', retryable: true }])
      await vi.advanceTimersByTimeAsync(11)
      expect(index).toBe(2)
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits one recovering event when a restarted helper start write fails', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!,
        restartDelayMs: 10, terminationTimeoutMs: 100,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)
      const errors: string[] = []
      supervisor.onEvent((event) => {
        if (event.kind === 'supervisor_error') errors.push(event.code)
      })

      children[0]!.exit()
      await vi.advanceTimersByTimeAsync(11)
      vi.spyOn(children[1]!.stdin, 'write').mockImplementationOnce(((...args: unknown[]) => {
        const callback = args.find((argument): argument is (error?: Error | null) => void => typeof argument === 'function')
        queueMicrotask(() => callback?.(new Error('simulated restart write failure')))
        return true
      }) as never)
      helperReady(children[1]!)
      await Promise.resolve()

      expect(errors).toEqual(['UNEXPECTED_EXIT', 'COMMAND_WRITE_FAILED'])
      await vi.advanceTimersByTimeAsync(11)
      expect(index).toBe(3)
      await vi.advanceTimersByTimeAsync(90)
      expect(children[1]!.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(children[2]!.killSignals).toEqual([])
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a restarted helper that stays alive but never becomes ready', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!,
        maxRestarts: 1, restartDelayMs: 10, helperReadyTimeoutMs: 100, heartbeatTimeoutMs: 1_000,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)
      const errors: string[] = []
      supervisor.onEvent((event) => {
        if (event.kind === 'supervisor_error') errors.push(event.code)
      })

      children[0]!.exit()
      await vi.advanceTimersByTimeAsync(11)
      heartbeat(children[1]!)
      await vi.advanceTimersByTimeAsync(101)
      expect(children[1]!.killSignals).toContain('SIGKILL')
      expect(errors).toContain('HELPER_READY_TIMEOUT')
      children[1]!.exit()
      expect(errors).toContain('RESTART_LIMIT')
      expect(supervisor.status).toBe('idle')
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms capture acknowledgement after wake and bounds a helper that never resumes capture', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!,
        captureAckTimeoutMs: 100, restartDelayMs: 10,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)
      children[0]!.stdout.write(encodeAudioHelperEventForTest({
        kind: 'status', sessionId: 's1', source: 'system', sequence: 1n, timestampMs: 2n,
        state: 'suspended', code: 'SYSTEM_SLEEP',
      }))
      children[0]!.stdout.write(encodeAudioHelperEventForTest({
        kind: 'status', sessionId: 's1', source: 'system', sequence: 1n, timestampMs: 3n,
        state: 'starting', code: 'WAKE_RESTART',
      }))
      heartbeat(children[0]!, 's1')

      await vi.advanceTimersByTimeAsync(101)
      expect(children[0]!.killSignals).toContain('SIGKILL')
      children[0]!.exit()
      await vi.advanceTimersByTimeAsync(11)
      helperReady(children[1]!)
      expect(children[1]!.commands).toContainEqual({ command: 'start', sessionId: 's1', source: 'system' })
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a scheduled restart when the active session is aborted', async () => {
    vi.useFakeTimers()
    try {
      const children = [new FakeChild(), new FakeChild()]
      let index = 0
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => children[index++]!, restartDelayMs: 20,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(children[0]!, started)
      children[0]!.exit()
      supervisor.abortActive()
      await vi.advanceTimersByTimeAsync(21)
      expect(index).toBe(1)
      expect(supervisor.status).toBe('idle')
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects start while graceful stop is in progress', async () => {
    const child = new FakeChild()
    const supervisor = new AudioHelperSupervisor({ helperPath: '/fake/helper', spawnChild: () => child })
    const started = supervisor.start('s1', 'system')
    await completeStart(child, started)
    const stopped = supervisor.stop('s1')
    expect(supervisor.status).toBe('stopping')
    expect(() => supervisor.start('s2', 'microphone')).toThrow('is stopping')
    captureStatus(child, 'stopped')
    await stopped
    supervisor.dispose()
  })

  it('kills a started helper that misses heartbeats', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const supervisor = new AudioHelperSupervisor({
        helperPath: '/fake/helper', spawnChild: () => child, heartbeatTimeoutMs: 100,
      })
      const started = supervisor.start('s1', 'system')
      await completeStart(child, started)
      const errors: string[] = []
      supervisor.onEvent((event) => {
        if (event.kind === 'supervisor_error') errors.push(event.code)
      })
      await vi.advanceTimersByTimeAsync(201)
      expect(child.killSignals).toContain('SIGKILL')
      expect(errors).toContain('HEARTBEAT_TIMEOUT')
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
