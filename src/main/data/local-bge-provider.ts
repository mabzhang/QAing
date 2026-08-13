import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { BGE_MAX_INPUT_TOKENS } from './chunking'
import {
  LOCAL_BGE_DIMENSION,
  LOCAL_BGE_MODEL_ID,
  LOCAL_BGE_PINNED_REVISION,
  LOCAL_BGE_Q4_SHA256,
  type LocalBgeDtype,
  type LocalBgeProgress,
} from './local-bge-contract'
import {
  EmbeddingProviderError,
  normalizeVector,
  type EmbedOptions,
  type EmbeddingProvider,
} from './vector'

export {
  LOCAL_BGE_DIMENSION,
  LOCAL_BGE_MODEL_ID,
  LOCAL_BGE_PINNED_REVISION,
  LOCAL_BGE_Q4_SHA256,
  type LocalBgeDtype,
  type LocalBgeProgress,
} from './local-bge-contract'

interface TokenizedIdsLike {
  readonly data?: ArrayLike<number | bigint>
  readonly size?: number
  readonly dims?: readonly number[]
  readonly input_ids?: unknown
}

export interface LocalBgePipeline {
  (
    texts: readonly string[],
    options: { readonly pooling: 'cls'; readonly normalize: true; readonly signal: AbortSignal },
  ): Promise<unknown>
  readonly tokenizer: {
    (text: string, options: { readonly add_special_tokens: true; readonly truncation: false }): unknown
    encode?: (text: string, options?: { readonly add_special_tokens?: boolean }) => unknown
  }
}

export interface LocalBgePipelineFactoryOptions {
  readonly modelId: typeof LOCAL_BGE_MODEL_ID
  readonly revision: string
  readonly dtype: LocalBgeDtype
  readonly cacheDir: string
  readonly signal: AbortSignal
  readonly onProgress?: (progress: LocalBgeProgress) => void
}

export type LocalBgePipelineFactory = (
  options: LocalBgePipelineFactoryOptions,
) => Promise<LocalBgePipeline>

export interface LocalBgeVerifyOptions {
  readonly cacheDir: string
  readonly revision: string
  readonly dtype: LocalBgeDtype
  readonly signal: AbortSignal
}

export type LocalBgeModelVerifier = (options: LocalBgeVerifyOptions) => Promise<void>

interface TransformersModule {
  readonly env: { cacheDir?: string }
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: {
      readonly revision: string
      readonly dtype: LocalBgeDtype
      readonly device: 'cpu'
      readonly cache_dir: string
      readonly signal: AbortSignal
      readonly progress_callback?: (progress: unknown) => void
    },
  ): Promise<LocalBgePipeline>
}

function progressFromUnknown(value: unknown): LocalBgeProgress {
  if (typeof value !== 'object' || value === null) return { status: 'unknown', file: null, progress: null }
  const record = value as Record<string, unknown>
  return {
    status: typeof record.status === 'string' ? record.status : 'unknown',
    file: typeof record.file === 'string' ? record.file : null,
    progress: typeof record.progress === 'number' && Number.isFinite(record.progress) ? record.progress : null,
  }
}

/** Default loader. The package is resolved only when prepare() is explicitly called. */
export const defaultLocalBgePipelineFactory: LocalBgePipelineFactory = async (options) => {
  const moduleName: string = '@huggingface/transformers'
  let transformers: TransformersModule
  try {
    transformers = (await import(/* @vite-ignore */ moduleName)) as TransformersModule
  } catch (error) {
    throw new EmbeddingProviderError(
      'UNAVAILABLE',
      'Local BGE runtime is not installed; retrieval remains in keyword fallback mode',
      false,
      { cause: error },
    )
  }
  transformers.env.cacheDir = options.cacheDir
  return transformers.pipeline('feature-extraction', options.modelId, {
    revision: options.revision,
    dtype: options.dtype,
    device: 'cpu',
    cache_dir: options.cacheDir,
    signal: options.signal,
    ...(options.onProgress
      ? { progress_callback: (progress: unknown) => options.onProgress?.(progressFromUnknown(progress)) }
      : {}),
  })
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason as unknown
  return reason instanceof Error ? reason : new Error('Local BGE verification was aborted')
}

function hashFile(path: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    const onAbort = (): void => { stream.destroy(abortError(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk: string | Buffer) => { hash.update(chunk) })
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
    stream.once('close', () => signal.removeEventListener('abort', onAbort))
  })
}

export function localBgeModelPath(cacheDir: string, revision: string, dtype: LocalBgeDtype): string {
  return join(cacheDir, LOCAL_BGE_MODEL_ID, revision, 'onnx', `model_${dtype}.onnx`)
}

/** q4 is the production default and has a verified upstream SHA-256. */
export const verifyLocalBgeModelFile: LocalBgeModelVerifier = async (options) => {
  if (options.dtype !== 'q4') {
    throw new EmbeddingProviderError(
      'INVALID_PROVIDER',
      'Only q4 has a pinned artifact checksum in this release',
      false,
    )
  }
  const path = localBgeModelPath(options.cacheDir, options.revision, options.dtype)
  let digest: string
  try {
    digest = await hashFile(path, options.signal)
  } catch (error) {
    if (options.signal.aborted) throw abortError(options.signal)
    throw new EmbeddingProviderError('INVALID_RESPONSE', 'Local BGE cache file is missing or unreadable', false, {
      cause: error,
    })
  }
  if (digest !== LOCAL_BGE_Q4_SHA256) {
    try {
      await unlink(path)
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null
      if (code !== 'ENOENT') {
        throw new EmbeddingProviderError(
          'INVALID_RESPONSE',
          'Local BGE cache checksum failed and the corrupted artifact could not be removed',
          false,
          { cause: error },
        )
      }
    }
    throw new EmbeddingProviderError(
      'INVALID_RESPONSE',
      'Local BGE cache checksum failed; the corrupted artifact was removed and requires an explicit retry',
      false,
    )
  }
}

function countArrayLike(value: unknown): number | null {
  if (Array.isArray(value)) {
    const values = value as unknown[]
    const first: unknown = values[0]
    return Array.isArray(first) ? first.length : values.length
  }
  if (typeof value !== 'object' || value === null) return null
  const tensor = value as TokenizedIdsLike
  if (tensor.input_ids !== undefined) return countArrayLike(tensor.input_ids)
  if (typeof tensor.size === 'number') return tensor.size
  if (tensor.data) return tensor.data.length
  if (tensor.dims && tensor.dims.length > 0) return tensor.dims.at(-1) ?? null
  return null
}

function toVectorRows(output: unknown, expectedRows: number): readonly Float32Array[] {
  let value = output
  if (typeof output === 'object' && output !== null) {
    const tensor = output as { readonly tolist?: () => unknown; readonly data?: ArrayLike<number>; readonly dims?: readonly number[] }
    if (typeof tensor.tolist === 'function') value = tensor.tolist()
    else if (tensor.data && tensor.dims) {
      const lastDimension = tensor.dims.at(-1)
      if (lastDimension !== LOCAL_BGE_DIMENSION || tensor.data.length !== expectedRows * LOCAL_BGE_DIMENSION) {
        throw new EmbeddingProviderError('INVALID_RESPONSE', 'Local BGE tensor shape mismatch', false)
      }
      return Array.from({ length: expectedRows }, (_, row) =>
        Float32Array.from(
          Array.from({ length: LOCAL_BGE_DIMENSION }, (_unused, column) =>
            Number(tensor.data?.[row * LOCAL_BGE_DIMENSION + column] ?? Number.NaN),
          ),
        ),
      )
    }
  }

  if (!Array.isArray(value)) {
    throw new EmbeddingProviderError('INVALID_RESPONSE', 'Local BGE returned an unsupported tensor', false)
  }
  const rows = value as unknown[]
  if (rows.length !== expectedRows) {
    throw new EmbeddingProviderError('INVALID_RESPONSE', 'Local BGE response count mismatch', false)
  }
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length !== LOCAL_BGE_DIMENSION) {
      throw new EmbeddingProviderError('INVALID_RESPONSE', 'Local BGE embedding dimension mismatch', false)
    }
    return Float32Array.from(row.map((component) => Number(component)))
  })
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

/**
 * Direct model runtime for the utility-process entry point and isolated real
 * model smoke tests only. Electron main must use LocalBgeEmbeddingProvider.
 */
export class LocalBgeWorkerRuntime implements EmbeddingProvider {
  readonly usage = 'production' as const
  readonly modelId = LOCAL_BGE_MODEL_ID
  readonly modelRevision: string
  readonly maxInputTokens = BGE_MAX_INPUT_TOKENS
  readonly maxBatchSize: number
  readonly metadata
  readonly #cacheDir: string
  readonly #dtype: LocalBgeDtype
  readonly #factory: LocalBgePipelineFactory
  readonly #verifier: LocalBgeModelVerifier | null
  readonly #onProgress: ((progress: LocalBgeProgress) => void) | undefined
  #pipeline: LocalBgePipeline | null = null
  #preparing: Promise<void> | null = null
  #readiness: 'not_loaded' | 'loading' | 'ready' | 'failed' = 'not_loaded'
  #failure: EmbeddingProviderError | null = null

  constructor(options: {
    readonly revision?: string
    readonly cacheDir: string
    readonly dtype?: LocalBgeDtype
    readonly maxBatchSize?: number
    readonly pipelineFactory?: LocalBgePipelineFactory
    readonly verifyModelFile?: LocalBgeModelVerifier | 'skip' | 'default'
    readonly onProgress?: (progress: LocalBgeProgress) => void
  }) {
    this.modelRevision = fixedRevision(options.revision ?? LOCAL_BGE_PINNED_REVISION)
    this.#cacheDir = options.cacheDir.trim()
    if (!this.#cacheDir) throw new EmbeddingProviderError('INVALID_PROVIDER', 'Local BGE cache directory is required', false)
    this.#dtype = options.dtype ?? 'q4'
    this.maxBatchSize = options.maxBatchSize ?? 16
    if (!Number.isSafeInteger(this.maxBatchSize) || this.maxBatchSize < 1 || this.maxBatchSize > 64) {
      throw new EmbeddingProviderError('INVALID_PROVIDER', 'Local BGE batch size must be between 1 and 64', false)
    }
    this.#factory = options.pipelineFactory ?? defaultLocalBgePipelineFactory
    if (options.pipelineFactory && options.verifyModelFile === undefined) {
      throw new EmbeddingProviderError(
        'INVALID_PROVIDER',
        'Injected Local BGE factories must explicitly choose a model verifier or test-only skip',
        false,
      )
    }
    this.#verifier =
      options.verifyModelFile === 'skip'
        ? null
        : options.verifyModelFile === undefined || options.verifyModelFile === 'default'
          ? verifyLocalBgeModelFile
          : options.verifyModelFile
    if (this.#dtype !== 'q4' && this.#verifier === verifyLocalBgeModelFile) {
      throw new EmbeddingProviderError(
        'INVALID_PROVIDER',
        'This release requires q4 unless a checksum verifier for another dtype is explicitly supplied',
        false,
      )
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

  async prepare(options: EmbedOptions): Promise<void> {
    if (this.#pipeline) return
    if (this.#readiness === 'failed') {
      throw this.#failure ?? new EmbeddingProviderError('UNAVAILABLE', 'Local BGE initialization is locked failed', false)
    }
    if (options.signal.aborted) throw options.signal.reason ?? new Error('Local BGE preparation aborted')
    if (!this.#preparing) {
      this.#readiness = 'loading'
      this.#preparing = this.#factory({
        modelId: LOCAL_BGE_MODEL_ID,
        revision: this.modelRevision,
        dtype: this.#dtype,
        cacheDir: this.#cacheDir,
        signal: options.signal,
        ...(this.#onProgress ? { onProgress: this.#onProgress } : {}),
      })
        .then(async (pipeline) => {
          if (!pipeline.tokenizer) {
            throw new EmbeddingProviderError('INVALID_RESPONSE', 'Local BGE pipeline has no tokenizer', false)
          }
          await this.#verifier?.({
            cacheDir: this.#cacheDir,
            revision: this.modelRevision,
            dtype: this.#dtype,
            signal: options.signal,
          })
          this.#pipeline = pipeline
          this.#readiness = 'ready'
        })
        .catch((error: unknown) => {
          if (options.signal.aborted) {
            this.#readiness = 'not_loaded'
            this.#failure = null
            throw abortError(options.signal)
          }
          this.#readiness = 'failed'
          this.#failure =
            error instanceof EmbeddingProviderError
              ? error
              : new EmbeddingProviderError('UNAVAILABLE', 'Local BGE failed to initialize', true, { cause: error })
          throw this.#failure
        })
        .finally(() => {
          this.#preparing = null
        })
    }
    await this.#preparing
  }

  /** A user-triggered retry boundary; failures never create an automatic download loop. */
  retryPreparation(): void {
    if (this.#readiness !== 'failed' || this.#preparing) return
    this.#failure = null
    this.#readiness = 'not_loaded'
  }

  countTokens(text: string): number {
    const pipeline = this.#pipeline
    if (!pipeline) {
      throw new EmbeddingProviderError(
        'UNAVAILABLE',
        'Local BGE tokenizer is not ready; prepare the provider before importing documents',
        true,
      )
    }
    const tokenized = pipeline.tokenizer(text, { add_special_tokens: true, truncation: false })
    const count = countArrayLike(tokenized)
    if (!Number.isSafeInteger(count) || (count ?? 0) < 0) {
      throw new EmbeddingProviderError('INVALID_RESPONSE', 'Local BGE tokenizer returned an invalid shape', false)
    }
    return count as number
  }

  async embed(texts: readonly string[], options: EmbedOptions): Promise<readonly Float32Array[]> {
    await this.prepare(options)
    const pipeline = this.#pipeline
    if (!pipeline) throw new EmbeddingProviderError('UNAVAILABLE', 'Local BGE pipeline is unavailable', true)
    if (options.signal.aborted) throw options.signal.reason ?? new Error('Local BGE inference aborted')
    const output = await pipeline(texts, { pooling: 'cls', normalize: true, signal: options.signal })
    if (options.signal.aborted) throw options.signal.reason ?? new Error('Local BGE inference aborted')
    return toVectorRows(output, texts.length).map((vector) => normalizeVector(vector, LOCAL_BGE_DIMENSION))
  }
}
