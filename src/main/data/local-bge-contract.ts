export const LOCAL_BGE_MODEL_ID = 'Xenova/bge-large-zh-v1.5'
export const LOCAL_BGE_PINNED_REVISION = 'a48549b3259a6165364f226599cd91f39923d5d5'
export const LOCAL_BGE_Q4_SHA256 = '470b1a4f914b2f40c72b7a495240a75fc8858f52f7b6ed8fb13185e571f98f71'
export const LOCAL_BGE_DIMENSION = 1_024
export const LOCAL_BGE_PROTOCOL = 'qaing-local-bge-v1'

export type LocalBgeDtype = 'q4' | 'q4f16' | 'int8'

export interface LocalBgeProgress {
  readonly status: string
  readonly file: string | null
  readonly progress: number | null
}

export interface LocalBgeWorkerConfig {
  readonly cacheDir: string
  readonly revision: string
  readonly dtype: LocalBgeDtype
  readonly maxBatchSize: number
}

export interface LocalBgeWorkerFingerprint {
  readonly modelId: typeof LOCAL_BGE_MODEL_ID
  readonly modelRevision: string
  readonly dimension: typeof LOCAL_BGE_DIMENSION
  readonly normalized: true
}

export interface LocalBgePrepareRequest {
  readonly protocol: typeof LOCAL_BGE_PROTOCOL
  readonly id: string
  readonly kind: 'prepare'
  readonly config: LocalBgeWorkerConfig
}

export interface LocalBgeEmbedRequest {
  readonly protocol: typeof LOCAL_BGE_PROTOCOL
  readonly id: string
  readonly kind: 'embed'
  readonly texts: readonly string[]
}

export interface LocalBgeCancelRequest {
  readonly protocol: typeof LOCAL_BGE_PROTOCOL
  readonly id: string
  readonly kind: 'cancel'
  readonly requestId: string
}

export type LocalBgeWorkerRequest = LocalBgePrepareRequest | LocalBgeEmbedRequest | LocalBgeCancelRequest

export interface LocalBgePreparedResponse {
  readonly protocol: typeof LOCAL_BGE_PROTOCOL
  readonly id: string
  readonly ok: true
  readonly kind: 'prepared'
  readonly fingerprint: LocalBgeWorkerFingerprint
}

export interface LocalBgeEmbeddedResponse {
  readonly protocol: typeof LOCAL_BGE_PROTOCOL
  readonly id: string
  readonly ok: true
  readonly kind: 'embedded'
  readonly fingerprint: LocalBgeWorkerFingerprint
  readonly vectors: readonly Float32Array[]
}

export interface LocalBgeProgressResponse {
  readonly protocol: typeof LOCAL_BGE_PROTOCOL
  readonly id: string
  readonly ok: true
  readonly kind: 'progress'
  readonly progress: LocalBgeProgress
}

export interface LocalBgeErrorResponse {
  readonly protocol: typeof LOCAL_BGE_PROTOCOL
  readonly id: string
  readonly ok: false
  readonly kind: 'error'
  readonly code: 'UNAVAILABLE' | 'INVALID_PROVIDER' | 'INVALID_RESPONSE' | 'TIMEOUT'
  readonly retryable: boolean
  readonly message: string
}

export type LocalBgeWorkerResponse =
  | LocalBgePreparedResponse
  | LocalBgeEmbeddedResponse
  | LocalBgeProgressResponse
  | LocalBgeErrorResponse
