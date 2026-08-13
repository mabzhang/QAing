import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeProjectInput } from './canonical'
import { IsolatedProjectConverter, type ProjectConverterProcess } from './converter-supervisor'
import { handleProjectConverterMessage } from './converter-worker'
import { PROJECT_CONVERTER_PROTOCOL, type ProjectConverterRequest } from './types'

class FakeProcess extends EventEmitter implements ProjectConverterProcess {
  readonly pid: number | undefined
  readonly messages: unknown[] = []
  readonly kill: ReturnType<typeof vi.fn<() => boolean>>
  constructor(options: { readonly pid?: number; readonly killResult?: boolean } = {}) {
    super()
    this.pid = options.pid
    this.kill = vi.fn(() => options.killResult ?? true)
  }
  postMessage(message: unknown): void { this.messages.push(message) }
  override on(event: 'message' | 'exit' | 'error', listener: (...args: unknown[]) => void): this {
    return super.on(event, listener)
  }
  override off(event: 'message' | 'exit' | 'error', listener: (...args: unknown[]) => void): this {
    return super.off(event, listener)
  }
}

const converters: IsolatedProjectConverter[] = []

function request(): ProjectConverterRequest {
  const input = Buffer.from('hello')
  return {
    projectId: 'project',
    sourceId: 'source',
    relativePath: '原始资料/a.txt',
    trustKind: 'document',
    detectedType: 'text',
    rawSha256: createHash('sha256').update(input).digest('hex'),
    input,
  }
}

function make(process: FakeProcess, timeoutMs = 100): IsolatedProjectConverter {
  const converter = new IsolatedProjectConverter({
    processFactory: async () => process,
    timeoutMs,
    maxConsecutiveRestarts: 1,
  })
  converters.push(converter)
  return converter
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(converters.splice(0).map((converter) => converter.dispose()))
})

describe('isolated project converter', () => {
  it('runs the production worker protocol without Electron or network access', () => {
    const input = request()
    const response = handleProjectConverterMessage({
      protocol: PROJECT_CONVERTER_PROTOCOL,
      id: 'request-1',
      kind: 'convert',
      request: input,
    })
    expect(response).toMatchObject({
      protocol: PROJECT_CONVERTER_PROTOCOL,
      id: 'request-1',
      ok: true,
      kind: 'converted',
    })
    expect(handleProjectConverterMessage({ protocol: 'wrong' })).toBeNull()
    expect(handleProjectConverterMessage({
      protocol: PROJECT_CONVERTER_PROTOCOL,
      id: 'bad',
      kind: 'convert',
      request: { input: '/arbitrary/path' },
    })).toMatchObject({ ok: false, code: 'CONVERTER_INVALID_RESPONSE' })
  })

  it('accepts a checksummed response and never exposes arbitrary worker fields', async () => {
    const process = new FakeProcess()
    const converter = make(process)
    const promise = converter.convert(request(), { signal: new AbortController().signal })
    await vi.waitFor(() => { expect(process.messages).toHaveLength(1) })
    const sent = process.messages[0] as { readonly id: string }
    const result = canonicalizeProjectInput(request())
    process.emit('message', {
      protocol: PROJECT_CONVERTER_PROTOCOL,
      id: sent.id,
      ok: true,
      kind: 'converted',
      ...result,
      arbitraryPath: '/tmp/ignored',
    })
    await expect(promise).resolves.toEqual(result)
  })

  it('kills the worker and rejects promptly on cancellation', async () => {
    const process = new FakeProcess()
    const converter = make(process)
    const controller = new AbortController()
    const promise = converter.convert(request(), { signal: controller.signal })
    await vi.waitFor(() => { expect(process.messages).toHaveLength(1) })
    controller.abort(new Error('cancel'))
    await expect(promise).rejects.toMatchObject({ code: 'SYNC_CANCELLED' })
    expect(process.kill).toHaveBeenCalledOnce()
  })

  it('bounds a hung worker by timeout and rejects malformed output hashes', async () => {
    vi.useFakeTimers()
    const hung = new FakeProcess()
    const converter = make(hung, 10)
    const promise = converter.convert(request(), { signal: new AbortController().signal })
    const assertion = expect(promise).rejects.toMatchObject({ code: 'CONVERTER_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(11)
    await assertion
    expect(hung.kill).toHaveBeenCalledOnce()

    vi.useRealTimers()
    const malformed = new FakeProcess()
    const malformedConverter = make(malformed)
    const malformedPromise = malformedConverter.convert(request(), { signal: new AbortController().signal })
    await vi.waitFor(() => { expect(malformed.messages).toHaveLength(1) })
    const sent = malformed.messages[0] as { readonly id: string }
    malformed.emit('message', {
      protocol: PROJECT_CONVERTER_PROTOCOL,
      id: sent.id,
      ok: true,
      kind: 'converted',
      canonicalMarkdown: '# wrong',
      outputSha256: '0'.repeat(64),
      canonicalBodySha256: '0'.repeat(64),
    })
    await expect(malformedPromise).rejects.toMatchObject({ code: 'CONVERTER_INVALID_RESPONSE' })
  })

  it('contains worker crashes and can create a bounded replacement', async () => {
    const first = new FakeProcess()
    const second = new FakeProcess()
    let index = 0
    const converter = new IsolatedProjectConverter({
      processFactory: async () => [first, second][index++]!,
      timeoutMs: 100,
      maxConsecutiveRestarts: 1,
    })
    converters.push(converter)
    const failed = converter.convert(request(), { signal: new AbortController().signal })
    await vi.waitFor(() => { expect(first.messages).toHaveLength(1) })
    first.emit('exit', 11)
    await expect(failed).rejects.toMatchObject({ code: 'CONVERTER_CRASHED' })
    const recovered = converter.convert(request(), { signal: new AbortController().signal })
    await vi.waitFor(() => { expect(second.messages).toHaveLength(1) })
    const sent = second.messages[0] as { readonly id: string }
    const result = canonicalizeProjectInput(request())
    second.emit('message', { protocol: PROJECT_CONVERTER_PROTOCOL, id: sent.id, ok: true, kind: 'converted', ...result })
    await expect(recovered).resolves.toEqual(result)
  })

  it('escalates a child that refuses graceful termination without targeting a replacement', async () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const stuck = new FakeProcess({ pid: 42_424 })
    const converter = new IsolatedProjectConverter({
      processFactory: async () => stuck,
      timeoutMs: 10,
      terminationTimeoutMs: 5,
    })
    converters.push(converter)
    const promise = converter.convert(request(), { signal: new AbortController().signal })
    const assertion = expect(promise).rejects.toMatchObject({ code: 'CONVERTER_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(16)
    await assertion
    expect(stuck.kill).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledWith(42_424, 'SIGKILL')
    kill.mockRestore()
  })
})
