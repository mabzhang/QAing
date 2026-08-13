import { ProjectSyncError } from './errors'
import { canonicalizeProjectInput } from './canonical'
import {
  PROJECT_CONVERTER_PROTOCOL,
  type ProjectConverterRequest,
  type ProjectDetectedType,
  type ProjectTrustKind,
} from './types'

interface RecordLike {
  readonly [key: string]: unknown
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null
}

function isTrustKind(value: unknown): value is ProjectTrustKind {
  return value === 'document' || value === 'preset_qa'
}

function isLocalType(value: unknown): value is Extract<ProjectDetectedType, 'text' | 'markdown' | 'json' | 'csv' | 'tsv'> {
  return value === 'text' || value === 'markdown' || value === 'json' || value === 'csv' || value === 'tsv'
}

function validatedRequest(value: unknown): ProjectConverterRequest {
  if (!isRecord(value) ||
      typeof value.projectId !== 'string' || value.projectId.length < 1 || value.projectId.length > 128 ||
      typeof value.sourceId !== 'string' || value.sourceId.length < 1 || value.sourceId.length > 128 ||
      typeof value.relativePath !== 'string' || value.relativePath.length < 1 || value.relativePath.length > 4_096 ||
      !isTrustKind(value.trustKind) || !isLocalType(value.detectedType) ||
      typeof value.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.rawSha256) ||
      !(value.input instanceof Uint8Array) || value.input.byteLength > 50 * 1024 * 1024) {
    throw new ProjectSyncError('CONVERTER_INVALID_RESPONSE')
  }
  return {
    projectId: value.projectId,
    sourceId: value.sourceId,
    relativePath: value.relativePath,
    trustKind: value.trustKind,
    detectedType: value.detectedType,
    rawSha256: value.rawSha256,
    input: value.input,
  }
}

function safeCode(error: unknown): string {
  if (error instanceof ProjectSyncError &&
      (error.code === 'INPUT_ENCODING_INVALID' || error.code === 'OUTPUT_INVALID' ||
        error.code === 'INPUT_UNSUPPORTED' || error.code === 'OUTPUT_TOO_LARGE')) {
    return error.code
  }
  return 'CONVERTER_INVALID_RESPONSE'
}

export function handleProjectConverterMessage(value: unknown): RecordLike | null {
  if (!isRecord(value) || value.protocol !== PROJECT_CONVERTER_PROTOCOL || typeof value.id !== 'string' ||
      value.kind !== 'convert') return null
  try {
    const result = canonicalizeProjectInput(validatedRequest(value.request))
    if (Buffer.byteLength(result.canonicalMarkdown, 'utf8') > 10 * 1024 * 1024) {
      throw new ProjectSyncError('OUTPUT_TOO_LARGE')
    }
    return { protocol: PROJECT_CONVERTER_PROTOCOL, id: value.id, ok: true, kind: 'converted', ...result }
  } catch (error) {
    return {
      protocol: PROJECT_CONVERTER_PROTOCOL,
      id: value.id,
      ok: false,
      kind: 'error',
      code: safeCode(error),
    }
  }
}

const parentPort = process.parentPort
if (parentPort) {
  parentPort.on('message', (event: { readonly data: unknown }) => {
    const response = handleProjectConverterMessage(event.data)
    if (response) parentPort.postMessage(response)
  })
}
