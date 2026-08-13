import {
  LOCAL_BGE_PROTOCOL,
  type LocalBgeDtype,
  type LocalBgeWorkerConfig,
} from './local-bge-contract'
import { LocalBgeWorkerRuntime } from './local-bge-provider'
import { EmbeddingProviderError } from './vector'

interface RecordLike {
  readonly [key: string]: unknown
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null
}

function isConfig(value: unknown): value is LocalBgeWorkerConfig {
  if (!isRecord(value)) return false
  return typeof value.cacheDir === 'string' && value.cacheDir.length > 0 && value.cacheDir.length <= 4_096 &&
    typeof value.revision === 'string' && /^[a-f0-9]{7,64}$/iu.test(value.revision) &&
    value.dtype === 'q4' && Number.isSafeInteger(value.maxBatchSize) &&
    (value.maxBatchSize as number) >= 1 && (value.maxBatchSize as number) <= 16
}

function safeWorkerError(error: unknown): {
  readonly code: EmbeddingProviderError['code']
  readonly retryable: boolean
  readonly message: string
} {
  if (error instanceof EmbeddingProviderError) {
    return { code: error.code, retryable: error.retryable, message: error.message.slice(0, 240) }
  }
  return { code: 'UNAVAILABLE', retryable: false, message: 'Local BGE worker operation failed' }
}

const parentPort = process.parentPort
if (!parentPort) throw new Error('Local BGE worker requires an Electron utility-process parent port')

let runtime: LocalBgeWorkerRuntime | null = null
let configFingerprint: string | null = null
let queue: Promise<void> = Promise.resolve()
const controllers = new Map<string, AbortController>()
const canceled = new Set<string>()
const queued = new Set<string>()

function respond(message: RecordLike): void {
  parentPort.postMessage({ protocol: LOCAL_BGE_PROTOCOL, ...message })
}

function configurationFingerprint(config: LocalBgeWorkerConfig): string {
  return `${config.cacheDir}\0${config.revision}\0${config.dtype}\0${String(config.maxBatchSize)}`
}

function runtimeFingerprint(current: LocalBgeWorkerRuntime): RecordLike {
  return {
    modelId: current.metadata.modelId,
    modelRevision: current.metadata.modelRevision,
    dimension: current.metadata.dimension,
    normalized: current.metadata.normalized,
  }
}

async function prepare(id: string, configValue: unknown): Promise<void> {
  if (!isConfig(configValue)) {
    throw new EmbeddingProviderError('INVALID_PROVIDER', 'Local BGE worker configuration is invalid', false)
  }
  const fingerprint = configurationFingerprint(configValue)
  if (configFingerprint !== null && configFingerprint !== fingerprint) {
    throw new EmbeddingProviderError('INVALID_PROVIDER', 'Local BGE worker configuration cannot change in-process', false)
  }
  if (!runtime) {
    const dtype: LocalBgeDtype = configValue.dtype
    runtime = new LocalBgeWorkerRuntime({
      cacheDir: configValue.cacheDir,
      revision: configValue.revision,
      dtype,
      maxBatchSize: configValue.maxBatchSize,
      onProgress: (progress) => respond({ id, ok: true, kind: 'progress', progress }),
    })
    configFingerprint = fingerprint
  }
  const controller = controllers.get(id)
  if (!controller) throw new Error('Local BGE worker request controller is missing')
  await runtime.prepare({ signal: controller.signal })
  respond({ id, ok: true, kind: 'prepared', fingerprint: runtimeFingerprint(runtime) })
}

async function embed(id: string, textsValue: unknown): Promise<void> {
  if (!runtime || runtime.readiness !== 'ready') {
    throw new EmbeddingProviderError('UNAVAILABLE', 'Local BGE worker is not prepared', true)
  }
  if (!Array.isArray(textsValue) || textsValue.length < 1 || textsValue.length > runtime.maxBatchSize ||
      textsValue.some((text: unknown) => typeof text !== 'string' || text.length < 1 || text.length > 65_536)) {
    throw new EmbeddingProviderError('INVALID_PROVIDER', 'Local BGE worker input batch is invalid', false)
  }
  const texts = textsValue as string[]
  if (texts.reduce((sum, text) => sum + text.length, 0) > 262_144) {
    throw new EmbeddingProviderError('INVALID_PROVIDER', 'Local BGE worker input batch is too large', false)
  }
  for (const text of texts) {
    const tokenCount = runtime.countTokens(text)
    if (!Number.isSafeInteger(tokenCount) || tokenCount < 1 || tokenCount > runtime.maxInputTokens) {
      throw new EmbeddingProviderError('INVALID_RESPONSE', 'A deferred import chunk exceeds the BGE token limit', false)
    }
  }
  const controller = controllers.get(id)
  if (!controller) throw new Error('Local BGE worker request controller is missing')
  const vectors = await runtime.embed(texts, { signal: controller.signal })
  respond({ id, ok: true, kind: 'embedded', fingerprint: runtimeFingerprint(runtime), vectors })
}

async function handle(value: unknown): Promise<void> {
  if (!isRecord(value) || value.protocol !== LOCAL_BGE_PROTOCOL || typeof value.id !== 'string') return
  const id = value.id
  if (value.kind === 'cancel' && typeof value.requestId === 'string') {
    const controller = controllers.get(value.requestId)
    if (controller) controller.abort(new Error('Local BGE worker request canceled'))
    else if (queued.has(value.requestId)) canceled.add(value.requestId)
    return
  }
  if (value.kind !== 'prepare' && value.kind !== 'embed') {
    respond({
      id,
      ok: false,
      kind: 'error',
      code: 'INVALID_PROVIDER',
      retryable: false,
      message: 'Local BGE worker request type is invalid',
    })
    return
  }
  queued.delete(id)
  if (canceled.delete(id)) return
  const controller = new AbortController()
  controllers.set(id, controller)
  try {
    if (value.kind === 'prepare') await prepare(id, value.config)
    else await embed(id, value.texts)
  } catch (error) {
    if (!controller.signal.aborted) {
      const safe = safeWorkerError(error)
      respond({ id, ok: false, kind: 'error', ...safe })
    }
  } finally {
    controllers.delete(id)
  }
}

parentPort.on('message', (event: { readonly data: unknown }) => {
  const value = event.data
  // Cancellation bypasses the serial inference queue.
  if (isRecord(value) && value.kind === 'cancel') {
    void handle(value)
    return
  }
  if (isRecord(value) && typeof value.id === 'string') queued.add(value.id)
  queue = queue.then(() => handle(value)).catch(() => {
    // handle() converts request-scoped failures to protocol errors. Keeping the
    // queue alive prevents a rejected JS request from terminating the worker.
  })
})
