import { describe, expect, it, vi } from 'vitest'
import {
  ApplicationController,
  type ApplicationRepository,
  type AudioRuntime,
  type RagRuntime,
} from '../app/controller'
import type { SeedAsrSessionEvent, SeedAsrSessionOptions } from '../asr/session'
import { SecureLogger } from '../security/secure-logger'
import { SeedAsrRuntime } from './adapters'

class FakeSeedSession {
  readonly options: SeedAsrSessionOptions
  readonly listeners = new Set<(event: SeedAsrSessionEvent) => void>()
  startGate: Promise<void> = Promise.resolve()
  sentFrames = 0
  aborts = 0
  stopError: Error | null = null

  constructor(options: SeedAsrSessionOptions) {
    this.options = options
  }

  onEvent(listener: (event: SeedAsrSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> { await this.startGate }
  async sendPcmFrame(): Promise<void> { this.sentFrames += 1 }
  async stop(): Promise<void> {
    if (this.stopError !== null) throw this.stopError
  }
  abort(): void { this.aborts += 1 }

  emit(event: SeedAsrSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
} {
  let resolvePromise: ((value: T) => void) | undefined
  let rejectPromise: ((error: Error) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  }
}

function replacement(text: string): SeedAsrSessionEvent {
  return {
    type: 'transcript',
    replacement: {
      type: 'transcript_replace', sequence: 1, fullText: text, utterances: [], isFinalPacket: false,
    },
  }
}

const startInput = (sessionId: string) => ({
  sessionId,
  mode: 'qa' as const,
  onTranscript: vi.fn(),
  onFailure: vi.fn(),
})

describe('SeedAsrRuntime operation isolation', () => {
  it('does not create a socket after abort wins a deferred credential lookup', async () => {
    const firstCredential = deferred<string | null>()
    let credentialReads = 0
    const vault = {
      get: vi.fn(async () => {
        credentialReads += 1
        return credentialReads === 1 ? firstCredential.promise : 'test-api-key-new'
      }),
    }
    const sessions: FakeSeedSession[] = []
    const runtime = new SeedAsrRuntime(
      vault as never,
      new SecureLogger(() => undefined),
      (options) => {
        const session = new FakeSeedSession(options)
        sessions.push(session)
        return session as never
      },
    )

    const oldStart = runtime.start(startInput('old'))
    const oldRejected = expect(oldStart).rejects.toMatchObject({ code: 'ASR_START_CANCELLED' })
    runtime.abort()
    await runtime.start(startInput('new'))
    firstCredential.resolve('test-api-key-old')
    await oldRejected

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.options.uid).toBe('qaing-new')
    await runtime.sendPcmFrame(new Uint8Array(6_400))
    expect(sessions[0]?.sentFrames).toBe(1)
    runtime.abort()
  })

  it('does not let a late old start rejection clear a newly opened session', async () => {
    const oldGate = deferred<void>()
    const sessions: FakeSeedSession[] = []
    const runtime = new SeedAsrRuntime(
      { get: vi.fn(async () => 'test-api-key') } as never,
      new SecureLogger(() => undefined),
      (options) => {
        const session = new FakeSeedSession(options)
        if (sessions.length === 0) session.startGate = oldGate.promise
        sessions.push(session)
        return session as never
      },
    )

    const oldStart = runtime.start(startInput('old'))
    const oldRejected = expect(oldStart).rejects.toThrow('old start failed late')
    await vi.waitFor(() => expect(sessions).toHaveLength(1))
    runtime.abort()
    await runtime.start(startInput('new'))
    oldGate.reject(new Error('old start failed late'))
    await oldRejected

    await runtime.sendPcmFrame(new Uint8Array(6_400))
    expect(sessions[1]?.sentFrames).toBe(1)
    expect(sessions[1]?.aborts).toBe(0)
    runtime.abort()
  })

  it('continues transcript sequence across same-session recovery and resets it for a new session', async () => {
    const sessions: FakeSeedSession[] = []
    const updates: Array<{ sessionId: string; sequence: number }> = []
    const runtime = new SeedAsrRuntime(
      { get: vi.fn(async () => 'test-api-key') } as never,
      new SecureLogger(() => undefined),
      (options) => {
        const session = new FakeSeedSession(options)
        sessions.push(session)
        return session as never
      },
    )
    const input = (sessionId: string) => ({
      ...startInput(sessionId),
      onTranscript: (update: { sessionId: string; sequence: number }) => updates.push(update),
    })
    const transcriptEvent = replacement('replacement')

    await runtime.start(input('same'))
    sessions[0]?.emit(transcriptEvent)
    sessions[0]?.emit(transcriptEvent)
    runtime.abort()
    await runtime.start(input('same'))
    sessions[1]?.emit(transcriptEvent)
    runtime.abort()
    await runtime.start(input('new'))
    sessions[2]?.emit(transcriptEvent)

    expect(updates).toEqual([
      { sessionId: 'same', sequence: 1, kind: 'partial', text: 'replacement' },
      { sessionId: 'same', sequence: 2, kind: 'partial', text: 'replacement' },
      { sessionId: 'same', sequence: 3, kind: 'partial', text: 'replacementreplacement' },
      { sessionId: 'new', sequence: 1, kind: 'partial', text: 'replacement' },
    ])
    runtime.abort()
  })

  it('prefixes a same-session replacement after recovery without duplicating across multiple reconnects', async () => {
    const sessions: FakeSeedSession[] = []
    const texts: string[] = []
    const runtime = new SeedAsrRuntime(
      { get: vi.fn(async () => 'test-api-key') } as never,
      new SecureLogger(() => undefined),
      (options) => {
        const session = new FakeSeedSession(options)
        sessions.push(session)
        return session as never
      },
    )
    const input = {
      ...startInput('same'),
      onTranscript: (update: { text: string }) => texts.push(update.text),
    }

    await runtime.start(input)
    sessions[0]?.emit(replacement('故障前的部分'))
    runtime.abort()
    await runtime.start(input)
    sessions[1]?.emit(replacement('恢复后'))
    sessions[1]?.emit(replacement('恢复后继续'))
    runtime.abort()
    await runtime.start(input)
    sessions[2]?.emit(replacement('再次恢复'))

    expect(texts).toEqual([
      '故障前的部分',
      '故障前的部分恢复后',
      '故障前的部分恢复后继续',
      '故障前的部分恢复后继续再次恢复',
    ])
    runtime.abort()
  })

  it('clears replacement carry after a normal finalized round in the same session', async () => {
    const sessions: FakeSeedSession[] = []
    const texts: string[] = []
    const runtime = new SeedAsrRuntime(
      { get: vi.fn(async () => 'test-api-key') } as never,
      new SecureLogger(() => undefined),
      (options) => {
        const session = new FakeSeedSession(options)
        sessions.push(session)
        return session as never
      },
    )
    const input = {
      ...startInput('same'),
      onTranscript: (update: { text: string }) => texts.push(update.text),
    }

    await runtime.start(input)
    sessions[0]?.emit(replacement('第一题'))
    await runtime.stopAndFinalize()
    await runtime.start(input)
    sessions[1]?.emit(replacement('第二题'))

    expect(texts).toEqual(['第一题', '第二题'])
    runtime.abort()
  })

  it('clears replacement carry after a rejected finalize before the next same-session round', async () => {
    const sessions: FakeSeedSession[] = []
    const texts: string[] = []
    const runtime = new SeedAsrRuntime(
      { get: vi.fn(async () => 'test-api-key') } as never,
      new SecureLogger(() => undefined),
      (options) => {
        const session = new FakeSeedSession(options)
        sessions.push(session)
        return session as never
      },
    )
    const input = {
      ...startInput('same'),
      onTranscript: (update: { text: string }) => texts.push(update.text),
    }

    await runtime.start(input)
    sessions[0]?.emit(replacement('失败轮次'))
    sessions[0]!.stopError = new Error('final timeout')
    await expect(runtime.stopAndFinalize()).rejects.toThrow('final timeout')
    await runtime.start(input)
    sessions[1]?.emit(replacement('新问题'))

    expect(texts).toEqual(['失败轮次', '新问题'])
    runtime.abort()
  })

  it('clears replacement carry at a no-session finalize boundary', async () => {
    const sessions: FakeSeedSession[] = []
    const texts: string[] = []
    const runtime = new SeedAsrRuntime(
      { get: vi.fn(async () => 'test-api-key') } as never,
      new SecureLogger(() => undefined),
      (options) => {
        const session = new FakeSeedSession(options)
        sessions.push(session)
        return session as never
      },
    )
    const input = {
      ...startInput('same'),
      onTranscript: (update: { text: string }) => texts.push(update.text),
    }

    await runtime.start(input)
    sessions[0]?.emit(replacement('已中止轮次'))
    runtime.abort()
    await runtime.stopAndFinalize()
    await runtime.start(input)
    sessions[1]?.emit(replacement('新问题'))

    expect(texts).toEqual(['已中止轮次', '新问题'])
    runtime.abort()
  })

  it('clears replacement carry when a genuinely new session starts', async () => {
    const sessions: FakeSeedSession[] = []
    const texts: string[] = []
    const runtime = new SeedAsrRuntime(
      { get: vi.fn(async () => 'test-api-key') } as never,
      new SecureLogger(() => undefined),
      (options) => {
        const session = new FakeSeedSession(options)
        sessions.push(session)
        return session as never
      },
    )
    await runtime.start({ ...startInput('old'), onTranscript: (update) => texts.push(update.text) })
    sessions[0]?.emit(replacement('旧会话'))
    runtime.abort()
    await runtime.start({ ...startInput('new'), onTranscript: (update) => texts.push(update.text) })
    sessions[1]?.emit(replacement('新会话'))

    expect(texts).toEqual(['旧会话', '新会话'])
    runtime.abort()
  })

  it('owns a connecting failure through only the rejected start promise', async () => {
    const gate = deferred<void>()
    const failure = Object.assign(new Error('connect failed'), { code: 'SOCKET_ERROR', retryable: true })
    const session = new FakeSeedSession({
      credentials: { apiKey: 'unused-test-key', resourceId: 'unused-test-resource' }, uid: 'unused',
    })
    session.startGate = gate.promise
    const input = startInput('s1')
    const runtime = new SeedAsrRuntime(
      { get: vi.fn(async () => 'test-api-key') } as never,
      new SecureLogger(() => undefined),
      () => session as never,
    )

    const starting = runtime.start(input)
    const rejected = expect(starting).rejects.toMatchObject({ code: 'SOCKET_ERROR', retryable: true })
    await vi.waitFor(() => expect(session.listeners.size).toBe(1))
    session.emit({ type: 'error', code: 'SOCKET_ERROR', retryable: true })
    gate.reject(failure)
    await rejected

    expect(input.onFailure).not.toHaveBeenCalled()
    runtime.abort()
  })

  it('preserves a real partial replacement through controller recovery', async () => {
    vi.useFakeTimers()
    try {
      const sessions: FakeSeedSession[] = []
      const asr = new SeedAsrRuntime(
        { get: vi.fn(async () => 'test-api-key') } as never,
        new SecureLogger(() => undefined),
        (options) => {
          const session = new FakeSeedSession(options)
          sessions.push(session)
          return session as never
        },
      )
      const audio: AudioRuntime = {
        prepare: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
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
        audio, asr, repository, rag, logger: new SecureLogger(() => undefined),
      })
      await controller.dispatch({ type: 'start_session' })
      sessions[0]?.emit(replacement('故障前的 partial'))
      expect(controller.getState().partialSegment).toBe('故障前的 partial')
      sessions[0]?.emit({ type: 'error', code: 'SOCKET_ERROR', retryable: true })
      await vi.advanceTimersByTimeAsync(251)
      expect(sessions).toHaveLength(2)

      sessions[1]?.emit(replacement('，恢复后继续'))
      expect(controller.getState().partialSegment).toBe('故障前的 partial，恢复后继续')
      expect(controller.getState().lastTranscriptSequence).toBe(2)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
