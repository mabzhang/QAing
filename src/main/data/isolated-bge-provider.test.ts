import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  LOCAL_BGE_DIMENSION,
  LOCAL_BGE_MODEL_ID,
  LOCAL_BGE_PINNED_REVISION,
  LOCAL_BGE_PROTOCOL,
} from './local-bge-contract'
import {
  IsolatedLocalBgeEmbeddingProvider,
  type UtilityProcessFactory,
  type UtilityProcessLike,
} from './isolated-bge-provider'

type Request = Record<string, unknown> & { readonly id: string; readonly kind: string }
type Handler = (worker: FakeUtilityProcess, request: Request) => void

class FakeUtilityProcess extends EventEmitter implements UtilityProcessLike {
  pid: number | undefined = 12_345
  killed = false

  constructor(readonly handler: Handler) {
    super()
  }

  postMessage(message: unknown): void {
    this.handler(this, message as Request)
  }

  kill(): boolean {
    this.killed = true
    this.pid = undefined
    return true
  }

  reply(request: Request, body: Record<string, unknown>): void {
    queueMicrotask(() => this.emit('message', { protocol: LOCAL_BGE_PROTOCOL, id: request.id, ...body }))
  }
}

function unitVector(): Float32Array {
  const vector = new Float32Array(LOCAL_BGE_DIMENSION)
  vector[0] = 1
  return vector
}

function fingerprint(): Record<string, unknown> {
  return {
    modelId: LOCAL_BGE_MODEL_ID,
    modelRevision: LOCAL_BGE_PINNED_REVISION,
    dimension: LOCAL_BGE_DIMENSION,
    normalized: true,
  }
}

function providerWith(
  handler: Handler,
  options: { readonly requestTimeoutMs?: number; readonly maxRestarts?: number } = {},
): {
  readonly provider: IsolatedLocalBgeEmbeddingProvider
  readonly factory: ReturnType<typeof vi.fn>
  readonly workers: FakeUtilityProcess[]
} {
  const workers: FakeUtilityProcess[] = []
  const factory = vi.fn<UtilityProcessFactory>(async () => {
    const worker = new FakeUtilityProcess(handler)
    workers.push(worker)
    return worker
  })
  return {
    provider: new IsolatedLocalBgeEmbeddingProvider({
      cacheDir: '/tmp/qaing-isolated-bge-fixture',
      workerPath: '/tmp/qaing-bge-worker-fixture.js',
      utilityProcessFactory: factory,
      prepareTimeoutMs: 100,
      requestTimeoutMs: options.requestTimeoutMs ?? 100,
      maxRestarts: options.maxRestarts ?? 0,
    }),
    factory,
    workers,
  }
}

describe('IsolatedLocalBgeEmbeddingProvider', () => {
  it('keeps all model work behind the utility-process RPC boundary', async () => {
    const { provider, factory } = providerWith((worker, request) => {
      if (request.kind === 'prepare') worker.reply(request, { ok: true, kind: 'prepared', fingerprint: fingerprint() })
      if (request.kind === 'embed') {
        worker.reply(request, { ok: true, kind: 'embedded', fingerprint: fingerprint(), vectors: [unitVector()] })
      }
    })
    const signal = new AbortController().signal

    expect(provider.readiness).toBe('not_loaded')
    expect(factory).not.toHaveBeenCalled()
    const vectors = await provider.embed(['退款期限'], { signal })
    expect(factory).toHaveBeenCalledTimes(1)
    expect(provider.readiness).toBe('ready')
    expect(vectors).toHaveLength(1)
    expect(vectors[0]).toHaveLength(LOCAL_BGE_DIMENSION)
  })

  it('contains repeated native-style worker exits and stops after the bounded restart budget', async () => {
    const { provider, factory } = providerWith((worker, request) => {
      if (request.kind === 'prepare') worker.reply(request, { ok: true, kind: 'prepared', fingerprint: fingerprint() })
      if (request.kind === 'embed') queueMicrotask(() => worker.emit('exit', 11))
    }, { maxRestarts: 2 })

    await expect(provider.embed(['触发隔离故障'], { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      retryable: false,
    })
    expect(factory).toHaveBeenCalledTimes(3)
    expect(provider.readiness).toBe('failed')
  })

  it('kills a timed-out worker and enters keyword-fallback readiness instead of hanging', async () => {
    const fixture = providerWith((created, request) => {
      if (request.kind === 'prepare') {
        created.reply(request, { ok: true, kind: 'prepared', fingerprint: fingerprint() })
      }
      // Embed intentionally never replies.
    }, { requestTimeoutMs: 10 })

    await expect(fixture.provider.embed(['超时请求'], { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
    expect(fixture.workers[0]?.killed).toBe(true)
    expect(fixture.provider.readiness).toBe('failed')
  })

  it('rejects malformed/non-finite vectors and terminates the untrusted worker', async () => {
    const fixture = providerWith((created, request) => {
      if (request.kind === 'prepare') {
        created.reply(request, { ok: true, kind: 'prepared', fingerprint: fingerprint() })
      }
      if (request.kind === 'embed') {
        const invalid = unitVector()
        invalid[10] = Number.NaN
        created.reply(request, { ok: true, kind: 'embedded', fingerprint: fingerprint(), vectors: [invalid] })
      }
    })

    await expect(fixture.provider.embed(['坏向量'], { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
    expect(fixture.workers[0]?.killed).toBe(true)
    expect(fixture.provider.readiness).toBe('failed')
  })

  it('rejects a mismatched model fingerprint even when vector bytes look valid', async () => {
    const fixture = providerWith((worker, request) => {
      if (request.kind === 'prepare') worker.reply(request, { ok: true, kind: 'prepared', fingerprint: fingerprint() })
      if (request.kind === 'embed') {
        worker.reply(request, {
          ok: true,
          kind: 'embedded',
          fingerprint: { ...fingerprint(), modelRevision: 'deadbeef' },
          vectors: [unitVector()],
        })
      }
    })

    await expect(fixture.provider.embed(['指纹不匹配'], { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      retryable: false,
    })
    expect(fixture.workers[0]?.killed).toBe(true)
  })

  it('coalesces one worker crash across concurrent callers into one restart-budget charge', async () => {
    let firstExitScheduled = false
    const fixture = providerWith((worker, request) => {
      if (request.kind === 'prepare') worker.reply(request, { ok: true, kind: 'prepared', fingerprint: fingerprint() })
      if (request.kind === 'embed' && fixture.workers[0] === worker) {
        if (!firstExitScheduled) {
          firstExitScheduled = true
          queueMicrotask(() => worker.emit('exit', 11))
        }
      } else if (request.kind === 'embed') {
        worker.reply(request, { ok: true, kind: 'embedded', fingerprint: fingerprint(), vectors: [unitVector()] })
      }
    }, { maxRestarts: 1 })
    const signal = new AbortController().signal
    await fixture.provider.prepare({ signal })

    const vectors = await Promise.all([
      fixture.provider.embed(['并发甲'], { signal }),
      fixture.provider.embed(['并发乙'], { signal }),
    ])
    expect(vectors).toHaveLength(2)
    expect(fixture.factory).toHaveBeenCalledTimes(2)
    expect(fixture.provider.readiness).toBe('ready')
  })

  it('cancels only the requesting RPC without killing the shared worker', async () => {
    let embedCount = 0
    const fixture = providerWith((worker, request) => {
      if (request.kind === 'prepare') worker.reply(request, { ok: true, kind: 'prepared', fingerprint: fingerprint() })
      if (request.kind === 'embed') {
        embedCount += 1
        if (embedCount > 1) {
          worker.reply(request, { ok: true, kind: 'embedded', fingerprint: fingerprint(), vectors: [unitVector()] })
        }
      }
    })
    const canceled = new AbortController()
    const first = fixture.provider.embed(['取消甲'], { signal: canceled.signal })
    await vi.waitFor(() => expect(embedCount).toBe(1))
    canceled.abort(new Error('TEST_CANCEL'))
    await expect(first).rejects.toThrow('TEST_CANCEL')
    expect(fixture.workers[0]?.killed).toBe(false)

    await expect(fixture.provider.embed(['继续乙'], { signal: new AbortController().signal })).resolves.toHaveLength(1)
    expect(fixture.factory).toHaveBeenCalledTimes(1)
  })
})
