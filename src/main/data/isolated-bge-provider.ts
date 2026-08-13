import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BGE_MAX_INPUT_TOKENS, DeferredImportTokenCounter } from './chunking'
import {
  LOCAL_BGE_DIMENSION,
  LOCAL_BGE_MODEL_ID,
  LOCAL_BGE_PINNED_REVISION,
  LOCAL_BGE_PROTOCOL,
  type LocalBgeDtype,
  type LocalBgeProgress,
  type LocalBgeWorkerConfig,
  type LocalBgeWorkerFingerprint,
} from './local-bge-contract'
import {
  EmbeddingProviderError,
  type EmbedOptions,
  type EmbeddingProvider,
} from './vector'

type WorkerEvent = 'spawn' | 'message' | 'exit' | 'error'
type WorkerListener = ((message: unknown) => void) | ((code: number) => void) | (() => void)

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
    ): UtilityProcessLike
  }
}

export interface UtilityProcessLike {
  readonly pid: number | undefined
  on(event: WorkerEvent, listener: WorkerListener): this
  off(event: WorkerEvent, listener: WorkerListener): this
  postMessage(message: unknown): void
  kill(): boolean
}

export type UtilityProcessFactory = (
  workerPath: string,
  options: { readonly serviceName: string },
) => Promise<UtilityProcessLike>

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timeout: ReturnType<typeof setTimeout>
  readonly signal: AbortSignal
  readonly onAbort: () => void
  readonly generation: number
}

interface RecordLike {
  readonly [key: string]: unknown
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null
}

function fixedRevision(revision: string): string {
  const value = revision.trim()
  if (!/^[a-f0-9]{7,64}$/iu.test(value)) {
    throw new EmbeddingProviderError(
      'INVALID_PROVIDER',
      'Local BGE revision must be a pinned repository commit hash, never a mutable branch name',
      false,
    )
  }
  return value
}

function errorCode(value: unknown): EmbeddingProviderError['code'] {
  return value === 'INVALID_PROVIDER' || value === 'INVALID_RESPONSE' || value === 'TIMEOUT'
    ? value
    : 'UNAVAILABLE'
}

function infrastructureError(
  message: string,
  code: 'UNAVAILABLE' | 'TIMEOUT' = 'UNAVAILABLE',
  generation?: number,
): EmbeddingProviderError {
  const error = new EmbeddingProviderError(code, message, true)
  Object.defineProperty(error, 'workerInfrastructureFailure', { value: true })
  if (generation !== undefined) Object.defineProperty(error, 'workerGeneration', { value: generation })
  return error
}

function isInfrastructureError(error: unknown): boolean {
  return error instanceof EmbeddingProviderError &&
    (error as EmbeddingProviderError & { readonly workerInfrastructureFailure?: boolean }).workerInfrastructureFailure === true
}

function infrastructureGeneration(error: unknown): number | null {
  if (!isInfrastructureError(error)) return null
  const value = (error as EmbeddingProviderError & { readonly workerGeneration?: unknown }).workerGeneration
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason as unknown
  return reason instanceof Error ? reason : new Error('Local BGE request was aborted')
}

function validateProgress(value: unknown): LocalBgeProgress | null {
  if (!isRecord(value)) return null
  const status = typeof value.status === 'string' ? value.status : null
  const file = value.file === null || typeof value.file === 'string' ? value.file : null
  const progress = value.progress === null || (typeof value.progress === 'number' && Number.isFinite(value.progress))
    ? value.progress
    : null
  return status ? { status, file, progress } : null
}

function validateWorkerVector(value: unknown): Float32Array {
  if (!(value instanceof Float32Array) || value.length !== LOCAL_BGE_DIMENSION) {
    throw new EmbeddingProviderError('INVALID_RESPONSE', 'Local BGE worker returned an invalid vector shape', false)
  }
  let normSquared = 0
  for (const component of value) {
    if (!Number.isFinite(component)) {
      throw new EmbeddingProviderError('INVALID_RESPONSE', 'Local BGE worker returned a non-finite vector', false)
    }
    normSquared += component * component
  }
  if (Math.abs(Math.sqrt(normSquared) - 1) > 0.001) {
    throw new EmbeddingProviderError('INVALID_RESPONSE', 'Local BGE worker returned a non-normalized vector', false)
  }
  return new Float32Array(value)
}

async function defaultUtilityProcessFactory(
  workerPath: string,
  options: { readonly serviceName: string },
): Promise<UtilityProcessLike> {
  const electronModuleName: string = 'electron'
  const { utilityProcess } = await import(/* @vite-ignore */ electronModuleName) as ElectronUtilityProcessModule
  return utilityProcess.fork(workerPath, [], {
    serviceName: options.serviceName,
    stdio: ['ignore', 'ignore', 'ignore'],
    allowLoadingUnsignedLibraries: false,
  })
}

/**
 * Main-process proxy. It never imports Transformers.js or onnxruntime-node;
 * every native model operation occurs in a crash-contained Electron utility
 * process. SQLite remains the canonical source when this provider is failed.
 */
export class IsolatedLocalBgeEmbeddingProvider implements EmbeddingProvider {
  readonly usage = 'production' as const
  readonly modelId = LOCAL_BGE_MODEL_ID
  readonly modelRevision: string
  readonly maxInputTokens = BGE_MAX_INPUT_TOKENS
  readonly maxBatchSize: number
  readonly metadata
  readonly #cacheDir: string
  readonly #dtype: LocalBgeDtype
  readonly #workerPath: string
  readonly #factory: UtilityProcessFactory
  readonly #onProgress: ((progress: LocalBgeProgress) => void) | undefined
  readonly #prepareTimeoutMs: number
  readonly #requestTimeoutMs: number
  readonly #maxRestarts: number
  readonly #counter = new DeferredImportTokenCounter()
  readonly #pending = new Map<string, PendingRequest>()
  readonly #workerGenerations = new WeakMap<UtilityProcessLike, number>()
  readonly #consumedFailureGenerations = new Set<number>()
  #worker: UtilityProcessLike | null = null
  #spawnPromise: Promise<UtilityProcessLike> | null = null
  #preparing: Promise<void> | null = null
  #readiness: 'not_loaded' | 'loading' | 'ready' | 'failed' = 'not_loaded'
  #failure: EmbeddingProviderError | null = null
  #consecutiveInfrastructureFailures = 0
  #nextWorkerGeneration = 1
  #disposed = false

  constructor(options: {
    readonly revision?: string
    readonly cacheDir: string
    readonly dtype?: LocalBgeDtype
    readonly maxBatchSize?: number
    readonly workerPath?: string
    readonly utilityProcessFactory?: UtilityProcessFactory
    readonly prepareTimeoutMs?: number
    readonly requestTimeoutMs?: number
    readonly maxRestarts?: number
    readonly onProgress?: (progress: LocalBgeProgress) => void
  }) {
    this.modelRevision = fixedRevision(options.revision ?? LOCAL_BGE_PINNED_REVISION)
    this.#cacheDir = options.cacheDir.trim()
    if (!this.#cacheDir) throw new EmbeddingProviderError('INVALID_PROVIDER', 'Local BGE cache directory is required', false)
    this.#dtype = options.dtype ?? 'q4'
    if (this.#dtype !== 'q4') {
      throw new EmbeddingProviderError('INVALID_PROVIDER', 'This release requires the checksum-pinned q4 model', false)
    }
    this.maxBatchSize = options.maxBatchSize ?? 8
    if (!Number.isSafeInteger(this.maxBatchSize) || this.maxBatchSize < 1 || this.maxBatchSize > 16) {
      throw new EmbeddingProviderError('INVALID_PROVIDER', 'Isolated Local BGE batch size must be between 1 and 16', false)
    }
    this.#workerPath = options.workerPath ?? fileURLToPath(new URL('./bge-worker.js', import.meta.url))
    this.#factory = options.utilityProcessFactory ?? defaultUtilityProcessFactory
    this.#prepareTimeoutMs = options.prepareTimeoutMs ?? 15 * 60_000
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.#maxRestarts = options.maxRestarts ?? 2
    for (const [name, value] of [
      ['prepareTimeoutMs', this.#prepareTimeoutMs],
      ['requestTimeoutMs', this.#requestTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new EmbeddingProviderError('INVALID_PROVIDER', `${name} must be a positive integer`, false)
      }
    }
    if (!Number.isSafeInteger(this.#maxRestarts) || this.#maxRestarts < 0 || this.#maxRestarts > 5) {
      throw new EmbeddingProviderError('INVALID_PROVIDER', 'maxRestarts must be between zero and five', false)
    }
    this.#onProgress = options.onProgress
    this.metadata = {
      modelId: this.modelId,
      modelRevision: this.modelRevision,
      dimension: LOCAL_BGE_DIMENSION,
      normalized: true,
    } as const
  }

  get readiness(): 'not_loaded' | 'loading' | 'ready' | 'failed' {
    return this.#readiness
  }

  countTokens(text: string): number {
    return this.#counter.countTokens(text)
  }

  async prepare(options: EmbedOptions): Promise<void> {
    if (this.#disposed) throw new EmbeddingProviderError('UNAVAILABLE', 'Local BGE worker is disposed', false)
    if (this.#readiness === 'ready' && this.#worker) return
    if (this.#readiness === 'failed') {
      throw this.#failure ?? new EmbeddingProviderError('UNAVAILABLE', 'Local BGE worker is locked failed', false)
    }
    if (options.signal.aborted) throw abortReason(options.signal)
    if (!this.#preparing) {
      this.#readiness = 'loading'
      this.#preparing = this.#prepareWithRecovery(options.signal).finally(() => {
        this.#preparing = null
      })
    }
    await this.#preparing
  }

  async embed(texts: readonly string[], options: EmbedOptions): Promise<readonly Float32Array[]> {
    if (texts.length < 1 || texts.length > this.maxBatchSize) {
      throw new EmbeddingProviderError('INVALID_PROVIDER', 'Local BGE worker batch size is invalid', false)
    }
    let totalCharacters = 0
    for (const text of texts) {
      if (typeof text !== 'string' || text.length < 1 || text.length > 65_536) {
        throw new EmbeddingProviderError('INVALID_PROVIDER', 'Local BGE worker input text is invalid', false)
      }
      totalCharacters += text.length
    }
    if (totalCharacters > 262_144) {
      throw new EmbeddingProviderError('INVALID_PROVIDER', 'Local BGE worker input batch is too large', false)
    }
    for (;;) {
      await this.prepare(options)
      try {
        const response = await this.#request(
          { kind: 'embed', texts: [...texts] },
          options.signal,
          this.#requestTimeoutMs,
        )
        if (!isRecord(response) || response.kind !== 'embedded' || !Array.isArray(response.vectors) ||
            !this.#matchesFingerprint(response.fingerprint)) {
          throw infrastructureError(
            'Local BGE worker returned a malformed response',
            'UNAVAILABLE',
            this.#currentWorkerGeneration(),
          )
        }
        if (response.vectors.length !== texts.length) {
          throw new EmbeddingProviderError('INVALID_RESPONSE', 'Local BGE worker response count mismatch', false)
        }
        const vectors = response.vectors.map(validateWorkerVector)
        this.#consecutiveInfrastructureFailures = 0
        return vectors
      } catch (error) {
        if (options.signal.aborted) throw abortReason(options.signal)
        if (!isInfrastructureError(error)) {
          if (error instanceof EmbeddingProviderError && error.code === 'INVALID_RESPONSE') {
            this.#lockFailed(error)
          }
          throw error
        }
        if (!this.#consumeRestart(error as EmbeddingProviderError)) {
          throw this.#failure ?? new EmbeddingProviderError('UNAVAILABLE', 'Local BGE worker failed', false)
        }
        await this.#restartBackoff(options.signal)
      }
    }
  }

  retryPreparation(): void {
    if (this.#readiness !== 'failed' || this.#preparing || this.#disposed) return
    this.#failure = null
    this.#consecutiveInfrastructureFailures = 0
    this.#readiness = 'not_loaded'
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const error = new EmbeddingProviderError('UNAVAILABLE', 'Local BGE worker was disposed', false)
    this.#invalidateWorker(error, true)
    this.#readiness = 'failed'
    this.#failure = error
  }

  async #prepareWithRecovery(signal: AbortSignal): Promise<void> {
    for (;;) {
      try {
        const response = await this.#request(
          {
            kind: 'prepare',
            config: {
              cacheDir: this.#cacheDir,
              revision: this.modelRevision,
              dtype: this.#dtype,
              maxBatchSize: this.maxBatchSize,
            } satisfies LocalBgeWorkerConfig,
          },
          signal,
          this.#prepareTimeoutMs,
        )
        if (!isRecord(response) || response.kind !== 'prepared' || !this.#matchesFingerprint(response.fingerprint)) {
          throw infrastructureError(
            'Local BGE worker returned a malformed preparation response',
            'UNAVAILABLE',
            this.#currentWorkerGeneration(),
          )
        }
        this.#readiness = 'ready'
        this.#failure = null
        return
      } catch (error) {
        if (signal.aborted) {
          this.#readiness = 'not_loaded'
          throw abortReason(signal)
        }
        if (!isInfrastructureError(error)) {
          this.#lockFailed(
            error instanceof EmbeddingProviderError
              ? error
              : new EmbeddingProviderError('UNAVAILABLE', 'Local BGE worker failed to initialize', false, { cause: error }),
          )
          throw this.#failure ?? new EmbeddingProviderError('UNAVAILABLE', 'Local BGE worker failed to initialize', false)
        }
        if (!this.#consumeRestart(error as EmbeddingProviderError)) {
          throw this.#failure ?? new EmbeddingProviderError('UNAVAILABLE', 'Local BGE worker failed to initialize', false)
        }
        await this.#restartBackoff(signal)
        this.#readiness = 'loading'
      }
    }
  }

  #consumeRestart(error: EmbeddingProviderError): boolean {
    const generation = infrastructureGeneration(error)
    if (generation !== null && this.#consumedFailureGenerations.has(generation)) {
      return this.#readiness !== 'failed'
    }
    if (generation !== null) {
      this.#consumedFailureGenerations.add(generation)
      // Generations are strictly increasing; retaining a small tail is enough
      // to coalesce concurrent callers without unbounded memory growth.
      for (const consumed of this.#consumedFailureGenerations) {
        if (consumed < generation - 8) this.#consumedFailureGenerations.delete(consumed)
      }
    }
    this.#consecutiveInfrastructureFailures += 1
    const worker = this.#worker
    if (worker && (generation === null || this.#workerGenerations.get(worker) === generation)) {
      this.#invalidateWorker(error, true)
    }
    if (this.#consecutiveInfrastructureFailures > this.#maxRestarts) {
      this.#lockFailed(new EmbeddingProviderError(
        error.code,
        'Local BGE worker exceeded its bounded restart budget; keyword fallback remains available',
        false,
        { cause: error },
      ))
      return false
    }
    this.#readiness = 'not_loaded'
    return true
  }

  async #restartBackoff(signal: AbortSignal): Promise<void> {
    const delayMs = Math.min(1_000, 100 * (2 ** Math.max(0, this.#consecutiveInfrastructureFailures - 1)))
    if (signal.aborted) throw abortReason(signal)
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timeout)
        reject(abortReason(signal))
      }
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, delayMs)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  #lockFailed(error: EmbeddingProviderError): void {
    this.#invalidateWorker(error, true)
    this.#failure = error
    this.#readiness = 'failed'
  }

  #matchesFingerprint(value: unknown): value is LocalBgeWorkerFingerprint {
    if (!isRecord(value)) return false
    return value.modelId === this.metadata.modelId &&
      value.modelRevision === this.metadata.modelRevision &&
      value.dimension === this.metadata.dimension &&
      value.normalized === true
  }

  #currentWorkerGeneration(): number | undefined {
    return this.#worker ? this.#workerGenerations.get(this.#worker) : undefined
  }

  async #ensureWorker(): Promise<UtilityProcessLike> {
    if (this.#worker) return this.#worker
    if (this.#spawnPromise) return this.#spawnPromise
    this.#spawnPromise = this.#factory(this.#workerPath, { serviceName: 'QAing Local BGE' })
      .then((worker) => {
        if (this.#disposed) {
          worker.kill()
          throw new EmbeddingProviderError('UNAVAILABLE', 'Local BGE worker is disposed', false)
        }
        const generation = this.#nextWorkerGeneration
        this.#nextWorkerGeneration += 1
        this.#workerGenerations.set(worker, generation)
        this.#worker = worker
        worker.on('message', (message: unknown) => this.#onMessage(worker, message))
        worker.on('exit', (code: number) => this.#onExit(worker, code))
        worker.on('error', () => this.#onExit(worker, -1))
        return worker
      })
      .catch((error: unknown) => {
        throw isInfrastructureError(error)
          ? error
          : infrastructureError('Local BGE utility process failed to spawn')
      })
      .finally(() => {
        this.#spawnPromise = null
      })
    return this.#spawnPromise
  }

  async #request(
    body: RecordLike,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<unknown> {
    if (signal.aborted) throw abortReason(signal)
    const worker = await this.#ensureWorker()
    if (signal.aborted) {
      throw abortReason(signal)
    }
    const generation = this.#workerGenerations.get(worker)
    if (!generation || worker !== this.#worker) {
      throw infrastructureError('Local BGE utility process changed before request dispatch', 'UNAVAILABLE', generation)
    }
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        const reason = abortReason(signal)
        const pending = this.#takePending(id)
        if (!pending) return
        pending.reject(reason)
        try {
          worker.postMessage({
            protocol: LOCAL_BGE_PROTOCOL,
            id: randomUUID(),
            kind: 'cancel',
            requestId: id,
          })
        } catch {
          // The canceled caller has already been rejected; an eventual worker
          // exit is handled by its generation listener.
        }
      }
      const timeout = setTimeout(() => {
        this.#invalidateWorker(
          infrastructureError('Local BGE utility process request timed out', 'TIMEOUT', generation),
          true,
        )
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timeout, signal, onAbort, generation })
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        worker.postMessage({ protocol: LOCAL_BGE_PROTOCOL, id, ...body })
      } catch {
        this.#invalidateWorker(infrastructureError('Local BGE utility process IPC send failed', 'UNAVAILABLE', generation), true)
      }
    })
  }

  #onMessage(worker: UtilityProcessLike, message: unknown): void {
    if (worker !== this.#worker || !isRecord(message) || message.protocol !== LOCAL_BGE_PROTOCOL) return
    const id = typeof message.id === 'string' ? message.id : null
    if (!id) {
      this.#invalidateWorker(infrastructureError(
        'Local BGE utility process sent an invalid envelope',
        'UNAVAILABLE',
        this.#workerGenerations.get(worker),
      ), true)
      return
    }
    if (message.kind === 'progress') {
      const progress = validateProgress(message.progress)
      if (progress) this.#onProgress?.(progress)
      return
    }
    const pending = this.#takePending(id)
    if (!pending) return
    if (message.ok === false && message.kind === 'error') {
      pending.reject(new EmbeddingProviderError(
        errorCode(message.code),
        typeof message.message === 'string' ? message.message : 'Local BGE worker failed',
        message.retryable === true,
      ))
      return
    }
    if (message.ok !== true) {
      pending.reject(infrastructureError(
        'Local BGE utility process sent an invalid response',
        'UNAVAILABLE',
        pending.generation,
      ))
      return
    }
    pending.resolve(message)
  }

  #onExit(worker: UtilityProcessLike, code: number): void {
    if (worker !== this.#worker) return
    this.#worker = null
    this.#readiness = this.#disposed ? 'failed' : 'not_loaded'
    this.#rejectAll(infrastructureError(
      `Local BGE utility process exited (${String(code)})`,
      'UNAVAILABLE',
      this.#workerGenerations.get(worker),
    ))
  }

  #invalidateWorker(reason: unknown, kill: boolean): void {
    const worker = this.#worker
    this.#worker = null
    if (!this.#disposed && this.#readiness !== 'failed') this.#readiness = 'not_loaded'
    this.#rejectAll(reason)
    if (worker && kill) {
      try {
        worker.kill()
      } catch {
        // Already dead; pending requests were rejected above.
      }
    }
  }

  #takePending(id: string): PendingRequest | null {
    const pending = this.#pending.get(id)
    if (!pending) return null
    this.#pending.delete(id)
    clearTimeout(pending.timeout)
    pending.signal.removeEventListener('abort', pending.onAbort)
    return pending
  }

  #rejectAll(reason: unknown): void {
    for (const id of [...this.#pending.keys()]) this.#takePending(id)?.reject(reason)
  }
}
