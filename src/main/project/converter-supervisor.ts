import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { canonicalBody } from './canonical'
import { ProjectSyncError, abortError } from './errors'
import {
  PROJECT_CONVERTER_PROTOCOL,
  type ProjectConverter,
  type ProjectConverterRequest,
  type ProjectConverterResult,
} from './types'

type WorkerEvent = 'message' | 'exit' | 'error'
type WorkerListener = ((message: unknown) => void) | ((code: number) => void) | (() => void)

export interface ProjectConverterProcess {
  readonly pid: number | undefined
  on(event: WorkerEvent, listener: WorkerListener): this
  off(event: WorkerEvent, listener: WorkerListener): this
  postMessage(message: unknown): void
  kill(): boolean
}

export type ProjectConverterProcessFactory = (
  workerPath: string,
  options: { readonly serviceName: string },
) => Promise<ProjectConverterProcess>

interface ElectronUtilityProcessModule {
  readonly utilityProcess: {
    fork(
      modulePath: string,
      args: readonly string[],
      options: {
        readonly serviceName: string
        readonly stdio: readonly ['ignore', 'ignore', 'ignore']
        readonly allowLoadingUnsignedLibraries: false
      },
    ): ProjectConverterProcess
  }
}

interface PendingConversion {
  readonly resolve: (result: ProjectConverterResult) => void
  readonly reject: (error: ProjectSyncError) => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
  readonly timeout: ReturnType<typeof setTimeout>
  readonly worker: ProjectConverterProcess
}

interface RecordLike {
  readonly [key: string]: unknown
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null
}

async function defaultProcessFactory(
  workerPath: string,
  options: { readonly serviceName: string },
): Promise<ProjectConverterProcess> {
  const electronModuleName: string = 'electron'
  const { utilityProcess } = await import(/* @vite-ignore */ electronModuleName) as ElectronUtilityProcessModule
  return utilityProcess.fork(workerPath, [], {
    serviceName: options.serviceName,
    stdio: ['ignore', 'ignore', 'ignore'],
    allowLoadingUnsignedLibraries: false,
  })
}

export class IsolatedProjectConverter implements ProjectConverter {
  readonly #workerPath: string
  readonly #factory: ProjectConverterProcessFactory
  readonly #timeoutMs: number
  readonly #maxInputBytes: number
  readonly #maxOutputBytes: number
  readonly #maxConsecutiveRestarts: number
  readonly #terminationTimeoutMs: number
  readonly #pending = new Map<string, PendingConversion>()
  readonly #workerListeners = new WeakMap<ProjectConverterProcess, {
    readonly message: WorkerListener
    readonly exit: WorkerListener
    readonly error: WorkerListener
  }>()
  readonly #terminating = new Set<ProjectConverterProcess>()
  readonly #terminationTimers = new Map<ProjectConverterProcess, ReturnType<typeof setTimeout>>()
  #worker: ProjectConverterProcess | null = null
  #spawning: Promise<ProjectConverterProcess> | null = null
  #consecutiveFailures = 0
  #disposed = false

  constructor(options: {
    readonly workerPath?: string
    readonly processFactory?: ProjectConverterProcessFactory
    readonly timeoutMs?: number
    readonly maxInputBytes?: number
    readonly maxOutputBytes?: number
    readonly maxConsecutiveRestarts?: number
    readonly terminationTimeoutMs?: number
  } = {}) {
    this.#workerPath = options.workerPath ?? fileURLToPath(new URL('./converter-worker.js', import.meta.url))
    this.#factory = options.processFactory ?? defaultProcessFactory
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#maxInputBytes = options.maxInputBytes ?? 50 * 1024 * 1024
    this.#maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024
    this.#maxConsecutiveRestarts = options.maxConsecutiveRestarts ?? 2
    this.#terminationTimeoutMs = options.terminationTimeoutMs ?? 1_500
    for (const [name, value] of [
      ['timeoutMs', this.#timeoutMs],
      ['maxInputBytes', this.#maxInputBytes],
      ['maxOutputBytes', this.#maxOutputBytes],
      ['terminationTimeoutMs', this.#terminationTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`)
    }
    if (!Number.isSafeInteger(this.#maxConsecutiveRestarts) || this.#maxConsecutiveRestarts < 0 ||
        this.#maxConsecutiveRestarts > 5) {
      throw new TypeError('maxConsecutiveRestarts must be between zero and five')
    }
  }

  async convert(
    request: ProjectConverterRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<ProjectConverterResult> {
    if (this.#disposed) throw new ProjectSyncError('CONVERTER_UNAVAILABLE')
    if (options.signal.aborted) throw abortError(options.signal)
    if (request.input.byteLength > this.#maxInputBytes) throw new ProjectSyncError('INPUT_TOO_LARGE')
    const worker = await this.#ensureWorker()
    if (options.signal.aborted) throw abortError(options.signal)
    const id = randomUUID()
    return new Promise<ProjectConverterResult>((resolve, reject) => {
      const onAbort = (): void => {
        worker.postMessage({ protocol: PROJECT_CONVERTER_PROTOCOL, kind: 'cancel', requestId: id })
        this.#settle(id, abortError(options.signal))
        this.#terminateWorker(worker, false)
      }
      const timeout = setTimeout(() => {
        this.#settle(id, new ProjectSyncError('CONVERTER_TIMEOUT', 'Project converter timed out', true))
        this.#terminateWorker(worker, true)
      }, this.#timeoutMs)
      this.#pending.set(id, { resolve, reject, signal: options.signal, onAbort, timeout, worker })
      options.signal.addEventListener('abort', onAbort, { once: true })
      try {
        worker.postMessage({ protocol: PROJECT_CONVERTER_PROTOCOL, id, kind: 'convert', request })
      } catch (error) {
        this.#settle(id, new ProjectSyncError('CONVERTER_CRASHED', 'Project converter request could not be sent', true,
          error instanceof Error ? { cause: error } : undefined))
        this.#terminateWorker(worker, true)
      }
    })
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const error = new ProjectSyncError('SYNC_CANCELLED', 'Project converter was disposed')
    for (const id of [...this.#pending.keys()]) this.#settle(id, error)
    if (this.#worker) this.#terminateWorker(this.#worker, false)
    try {
      await this.#spawning
    } catch {
      // A failed spawn is already surfaced to its request.
    }
  }

  async #ensureWorker(): Promise<ProjectConverterProcess> {
    if (this.#worker) return this.#worker
    if (this.#disposed || this.#consecutiveFailures > this.#maxConsecutiveRestarts) {
      throw new ProjectSyncError('CONVERTER_UNAVAILABLE', 'Project converter restart budget is exhausted')
    }
    this.#spawning ??= this.#factory(this.#workerPath, { serviceName: 'QAing Project Converter' })
      .then((worker) => {
        const listeners = {
          message: (message: unknown) => { this.#handleMessage(worker, message) },
          exit: () => { this.#handleExit(worker) },
          error: () => { this.#handleError(worker) },
        }
        this.#workerListeners.set(worker, listeners)
        worker.on('message', listeners.message)
        worker.on('exit', listeners.exit)
        worker.on('error', listeners.error)
        if (this.#disposed) {
          this.#terminateWorker(worker, false)
          throw new ProjectSyncError('CONVERTER_UNAVAILABLE')
        }
        this.#worker = worker
        return worker
      })
      .catch((error: unknown) => {
        this.#consecutiveFailures += 1
        if (error instanceof ProjectSyncError) throw error
        throw new ProjectSyncError('CONVERTER_UNAVAILABLE', 'Project converter could not start', true,
          error instanceof Error ? { cause: error } : undefined)
      })
      .finally(() => { this.#spawning = null })
    return this.#spawning
  }

  #handleMessage(worker: ProjectConverterProcess, message: unknown): void {
    const value = isRecord(message) && 'data' in message ? message.data : message
    if (!isRecord(value) || value.protocol !== PROJECT_CONVERTER_PROTOCOL || typeof value.id !== 'string') return
    const pending = this.#pending.get(value.id)
    if (!pending || pending.worker !== worker || this.#terminating.has(worker)) return
    if (value.ok !== true || value.kind !== 'converted') {
      const rawCode = value.code
      const code = rawCode === 'INPUT_ENCODING_INVALID' || rawCode === 'OUTPUT_INVALID' ||
        rawCode === 'INPUT_UNSUPPORTED' || rawCode === 'OUTPUT_TOO_LARGE'
        ? rawCode
        : 'CONVERTER_INVALID_RESPONSE'
      this.#settle(value.id, new ProjectSyncError(code, code, false))
      return
    }
    if (typeof value.canonicalMarkdown !== 'string' || typeof value.outputSha256 !== 'string' ||
        typeof value.canonicalBodySha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(value.outputSha256) || !/^[a-f0-9]{64}$/u.test(value.canonicalBodySha256) ||
        Buffer.byteLength(value.canonicalMarkdown, 'utf8') > this.#maxOutputBytes ||
        createHash('sha256').update(value.canonicalMarkdown, 'utf8').digest('hex') !== value.outputSha256 ||
        createHash('sha256').update(canonicalBody(value.canonicalMarkdown), 'utf8').digest('hex') !==
          value.canonicalBodySha256) {
      this.#settle(value.id, new ProjectSyncError('CONVERTER_INVALID_RESPONSE'))
      return
    }
    this.#consecutiveFailures = 0
    this.#settle(value.id, null, {
      canonicalMarkdown: value.canonicalMarkdown,
      outputSha256: value.outputSha256,
      canonicalBodySha256: value.canonicalBodySha256,
    })
  }

  #handleExit(worker: ProjectConverterProcess): void {
    const expectedTermination = this.#terminating.has(worker)
    this.#detachWorker(worker)
    if (!expectedTermination) this.#consecutiveFailures += 1
    for (const [id, pending] of this.#pending) {
      if (pending.worker === worker) this.#settle(id, new ProjectSyncError('CONVERTER_CRASHED', 'Project converter exited', true))
    }
  }

  #handleError(worker: ProjectConverterProcess): void {
    const expectedTermination = this.#terminating.has(worker)
    if (!expectedTermination) this.#consecutiveFailures += 1
    for (const [id, pending] of this.#pending) {
      if (pending.worker === worker) this.#settle(id, new ProjectSyncError('CONVERTER_CRASHED', 'Project converter failed', true))
    }
    this.#terminateWorker(worker, false)
  }

  #settle(id: string, error: ProjectSyncError | null, result?: ProjectConverterResult): void {
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    clearTimeout(pending.timeout)
    pending.signal.removeEventListener('abort', pending.onAbort)
    if (error) pending.reject(error)
    else if (result) pending.resolve(result)
    else pending.reject(new ProjectSyncError('CONVERTER_INVALID_RESPONSE'))
  }

  #terminateWorker(worker: ProjectConverterProcess, countFailure: boolean): void {
    if (this.#terminating.has(worker)) return
    this.#terminating.add(worker)
    if (this.#worker === worker) this.#worker = null
    if (countFailure) this.#consecutiveFailures += 1
    for (const [id, pending] of this.#pending) {
      if (pending.worker === worker) this.#settle(id, new ProjectSyncError('CONVERTER_CRASHED', 'Project converter terminated', true))
    }
    if (!worker.kill()) {
      this.#forceKill(worker)
      return
    }
    this.#terminationTimers.set(worker, setTimeout(() => {
      this.#forceKill(worker)
    }, this.#terminationTimeoutMs))
  }

  #detachWorker(worker: ProjectConverterProcess): void {
    const listeners = this.#workerListeners.get(worker)
    if (listeners) {
      worker.off('message', listeners.message)
      worker.off('exit', listeners.exit)
      worker.off('error', listeners.error)
      this.#workerListeners.delete(worker)
    }
    const timer = this.#terminationTimers.get(worker)
    if (timer) clearTimeout(timer)
    this.#terminationTimers.delete(worker)
    this.#terminating.delete(worker)
    if (this.#worker === worker) this.#worker = null
  }

  #forceKill(worker: ProjectConverterProcess): void {
    this.#terminationTimers.delete(worker)
    const pid = worker.pid
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The child may have exited immediately before the escalation.
      }
    }
    this.#detachWorker(worker)
  }
}
