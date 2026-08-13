import { gunzipSync, gzipSync } from 'node:zlib'

const PROTOCOL_VERSION = 1
const BASE_HEADER_BYTES = 4
const UINT32_BYTES = 4
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

export const SeedAsrMessageType = {
  FULL_CLIENT_REQUEST: 0x1,
  AUDIO_ONLY_REQUEST: 0x2,
  FULL_SERVER_RESPONSE: 0x9,
  ERROR_RESPONSE: 0xf,
} as const

export const SeedAsrFlags = {
  NONE: 0x0,
  HAS_POSITIVE_SEQUENCE: 0x1,
  FINAL_WITHOUT_SEQUENCE: 0x2,
  HAS_NEGATIVE_SEQUENCE: 0x3,
} as const

export const SeedAsrSerialization = {
  NONE: 0x0,
  JSON: 0x1,
} as const

export const SeedAsrCompression = {
  NONE: 0x0,
  GZIP: 0x1,
} as const

export interface SeedAsrUtterance {
  readonly text: string
  readonly definite: boolean
  readonly startTimeMs: number | null
  readonly endTimeMs: number | null
}

export interface SeedAsrTranscriptReplacement {
  readonly type: 'transcript_replace'
  readonly sequence: number | null
  readonly isFinalPacket: boolean
  readonly fullText: string
  readonly utterances: readonly SeedAsrUtterance[]
}

export interface SeedAsrAcknowledgement {
  readonly type: 'acknowledgement'
  readonly sequence: number | null
  readonly isFinalPacket: boolean
}

export interface SeedAsrServerError {
  readonly type: 'server_error'
  readonly code: number
  readonly message: string
}

export type SeedAsrDecodedMessage =
  | SeedAsrTranscriptReplacement
  | SeedAsrAcknowledgement
  | SeedAsrServerError

export class SeedAsrProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SeedAsrProtocolError'
    this.code = code
  }
}

interface HeaderFields {
  readonly messageType: number
  readonly flags: number
  readonly serialization: number
  readonly compression: number
}

export interface SeedAsrRequestPayload {
  readonly user: {
    readonly uid: string
  }
  readonly audio: {
    readonly format: 'pcm'
    readonly codec: 'raw'
    readonly rate: 16000
    readonly bits: 16
    readonly channel: 1
    readonly language: string
  }
  readonly request: {
    readonly model_name: 'bigmodel'
    readonly show_utterances: true
    readonly result_type: 'full' | 'single'
    readonly enable_itn: boolean
    readonly enable_punc: boolean
  }
}

export function createSeedAsrRequestPayload(options: {
  readonly uid: string
  readonly language?: string
  readonly enableItn?: boolean
  readonly enablePunctuation?: boolean
  readonly resultType?: 'full' | 'single'
}): SeedAsrRequestPayload {
  return {
    user: { uid: options.uid },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: 16000,
      bits: 16,
      channel: 1,
      language: options.language ?? 'zh-CN',
    },
    request: {
      model_name: 'bigmodel',
      show_utterances: true,
      result_type: options.resultType ?? 'full',
      enable_itn: options.enableItn ?? true,
      enable_punc: options.enablePunctuation ?? true,
    },
  }
}

/**
 * Converts official `result_type: single` responses into replacement snapshots.
 * Definite utterances are retained by absolute start time while the current
 * provisional utterances are replaced, never appended packet-by-packet.
 */
export class SeedAsrSingleResultAssembler {
  private readonly definiteByStart = new Map<number, SeedAsrUtterance>()
  private provisional: readonly SeedAsrUtterance[] = []

  apply(message: SeedAsrTranscriptReplacement): SeedAsrTranscriptReplacement {
    const incomingDefinite = message.utterances.filter((utterance) => utterance.definite)
    const incomingProvisional = message.utterances.filter((utterance) => !utterance.definite)
    for (const utterance of incomingDefinite) {
      const start = utterance.startTimeMs
      if (start === null) {
        throw new SeedAsrProtocolError(
          'MISSING_UTTERANCE_TIME',
          'Single-result definite utterances require an absolute start time',
        )
      }
      this.definiteByStart.set(start, utterance)
    }

    if (message.utterances.length > 0) {
      this.provisional = incomingProvisional
    } else if (message.fullText !== '') {
      // show_utterances=true should normally provide timestamps. Retaining an
      // untimed provisional fallback is safer than incorrectly committing it.
      this.provisional = [{
        text: message.fullText,
        definite: false,
        startTimeMs: null,
        endTimeMs: null,
      }]
    } else {
      this.provisional = []
    }

    const definite = [...this.definiteByStart.values()].sort(compareUtteranceTime)
    const provisional = [...this.provisional].sort(compareUtteranceTime)
    const utterances = [...definite, ...provisional]
    return {
      ...message,
      fullText: utterances.map((utterance) => utterance.text).join(''),
      utterances,
    }
  }
}

function compareUtteranceTime(left: SeedAsrUtterance, right: SeedAsrUtterance): number {
  return (left.startTimeMs ?? Number.MAX_SAFE_INTEGER) - (right.startTimeMs ?? Number.MAX_SAFE_INTEGER)
}

export function encodeFullClientRequest(payload: SeedAsrRequestPayload, sequence = 1): Buffer {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > 0x7fffffff) {
    throw new SeedAsrProtocolError('INVALID_SEQUENCE', 'Initial request sequence must be a positive int32')
  }
  const serialized = Buffer.from(JSON.stringify(payload), 'utf8')
  return encodeFrame(
    {
      messageType: SeedAsrMessageType.FULL_CLIENT_REQUEST,
      flags: SeedAsrFlags.HAS_POSITIVE_SEQUENCE,
      serialization: SeedAsrSerialization.JSON,
      compression: SeedAsrCompression.GZIP,
    },
    gzipSync(serialized),
    sequence,
  )
}

export function encodeAudioOnlyRequest(
  pcm16: Uint8Array,
  sequence: number,
  final = false,
): Buffer {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > 0x7fffffff) {
    throw new SeedAsrProtocolError('INVALID_SEQUENCE', 'Audio sequence must be a positive int32')
  }
  if (pcm16.byteLength === 0 && !final) {
    throw new SeedAsrProtocolError('EMPTY_AUDIO', 'A non-final audio packet cannot be empty')
  }

  const wireSequence = final ? -sequence : sequence
  const payload = gzipSync(Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength))
  return encodeFrame(
    {
      messageType: SeedAsrMessageType.AUDIO_ONLY_REQUEST,
      flags: final ? SeedAsrFlags.HAS_NEGATIVE_SEQUENCE : SeedAsrFlags.HAS_POSITIVE_SEQUENCE,
      serialization: SeedAsrSerialization.NONE,
      compression: SeedAsrCompression.GZIP,
    },
    payload,
    wireSequence,
  )
}

export function decodeServerFrame(frame: Uint8Array): SeedAsrDecodedMessage {
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
  if (bytes.byteLength < BASE_HEADER_BYTES) {
    throw new SeedAsrProtocolError('TRUNCATED_HEADER', 'Server frame is shorter than the base header')
  }

  const version = bytes[0]! >> 4
  const headerWords = bytes[0]! & 0x0f
  const headerBytes = headerWords * 4
  if (version !== PROTOCOL_VERSION) {
    throw new SeedAsrProtocolError('UNSUPPORTED_VERSION', `Unsupported protocol version ${version}`)
  }
  if (headerWords < 1 || headerBytes > bytes.byteLength) {
    throw new SeedAsrProtocolError('INVALID_HEADER_SIZE', 'Server frame declares an invalid header size')
  }

  const messageType = bytes[1]! >> 4
  const flags = bytes[1]! & 0x0f
  const serialization = bytes[2]! >> 4
  const compression = bytes[2]! & 0x0f
  validateEncoding(serialization, compression)

  if (messageType === SeedAsrMessageType.ERROR_RESPONSE) {
    return decodeErrorFrame(bytes, headerBytes, compression)
  }
  if (messageType !== SeedAsrMessageType.FULL_SERVER_RESPONSE) {
    throw new SeedAsrProtocolError('UNEXPECTED_MESSAGE_TYPE', `Unexpected server message type ${messageType}`)
  }

  let offset = headerBytes
  let sequence: number | null = null
  if (flags === SeedAsrFlags.HAS_POSITIVE_SEQUENCE || flags === SeedAsrFlags.HAS_NEGATIVE_SEQUENCE) {
    requireAvailable(bytes, offset, UINT32_BYTES, 'TRUNCATED_SEQUENCE')
    sequence = bytes.readInt32BE(offset)
    offset += UINT32_BYTES
    if (flags === SeedAsrFlags.HAS_POSITIVE_SEQUENCE && sequence <= 0) {
      throw new SeedAsrProtocolError('INVALID_SEQUENCE_SIGN', 'Positive-sequence flag requires a positive sequence')
    }
    if (flags === SeedAsrFlags.HAS_NEGATIVE_SEQUENCE && sequence >= 0) {
      throw new SeedAsrProtocolError('INVALID_SEQUENCE_SIGN', 'Negative-sequence flag requires a negative sequence')
    }
  } else if (flags !== SeedAsrFlags.NONE && flags !== SeedAsrFlags.FINAL_WITHOUT_SEQUENCE) {
    throw new SeedAsrProtocolError('UNSUPPORTED_FLAGS', `Unsupported server flags ${flags}`)
  }

  const compressedPayload = readLengthPrefixedPayload(bytes, offset)
  const payload = decompressPayload(compressedPayload, compression)
  if (serialization !== SeedAsrSerialization.JSON) {
    if (payload.byteLength === 0) {
      return {
        type: 'acknowledgement',
        sequence,
        isFinalPacket: isFinal(flags, sequence),
      }
    }
    throw new SeedAsrProtocolError('UNSUPPORTED_SERIALIZATION', 'A server result must use JSON serialization')
  }

  const decoded = parseJsonObject(payload)
  const result = asRecord(decoded.result)
  if (result === null) {
    return {
      type: 'acknowledgement',
      sequence,
      isFinalPacket: isFinal(flags, sequence),
    }
  }

  const fullText = typeof result.text === 'string' ? result.text : ''
  const utterances = Array.isArray(result.utterances)
    ? result.utterances.flatMap((value): SeedAsrUtterance[] => {
        const utterance = asRecord(value)
        if (utterance === null || typeof utterance.text !== 'string') return []
        return [{
          text: utterance.text,
          definite: utterance.definite === true,
          startTimeMs: finiteNumberOrNull(utterance.start_time),
          endTimeMs: finiteNumberOrNull(utterance.end_time),
        }]
      })
    : []

  return {
    type: 'transcript_replace',
    sequence,
    isFinalPacket: isFinal(flags, sequence),
    fullText,
    utterances,
  }
}

function encodeFrame(header: HeaderFields, payload: Buffer, sequence?: number): Buffer {
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new SeedAsrProtocolError('PAYLOAD_TOO_LARGE', 'Payload exceeds the protocol safety limit')
  }
  const sequenceBytes = sequence === undefined ? 0 : UINT32_BYTES
  const frame = Buffer.allocUnsafe(BASE_HEADER_BYTES + sequenceBytes + UINT32_BYTES + payload.byteLength)
  frame[0] = (PROTOCOL_VERSION << 4) | 1
  frame[1] = (header.messageType << 4) | header.flags
  frame[2] = (header.serialization << 4) | header.compression
  frame[3] = 0
  let offset = BASE_HEADER_BYTES
  if (sequence !== undefined) {
    frame.writeInt32BE(sequence, offset)
    offset += UINT32_BYTES
  }
  frame.writeUInt32BE(payload.byteLength, offset)
  payload.copy(frame, offset + UINT32_BYTES)
  return frame
}

function decodeErrorFrame(bytes: Buffer, headerBytes: number, compression: number): SeedAsrServerError {
  requireAvailable(bytes, headerBytes, UINT32_BYTES * 2, 'TRUNCATED_ERROR')
  const code = bytes.readUInt32BE(headerBytes)
  const messageLength = bytes.readUInt32BE(headerBytes + UINT32_BYTES)
  if (messageLength > MAX_PAYLOAD_BYTES) {
    throw new SeedAsrProtocolError('PAYLOAD_TOO_LARGE', 'Error message exceeds the protocol safety limit')
  }
  const messageOffset = headerBytes + UINT32_BYTES * 2
  requireExactFrameLength(bytes, messageOffset, messageLength)
  const messageBytes = decompressPayload(bytes.subarray(messageOffset), compression)
  return { type: 'server_error', code, message: messageBytes.toString('utf8') }
}

function readLengthPrefixedPayload(bytes: Buffer, offset: number): Buffer {
  requireAvailable(bytes, offset, UINT32_BYTES, 'TRUNCATED_PAYLOAD_SIZE')
  const payloadLength = bytes.readUInt32BE(offset)
  if (payloadLength > MAX_PAYLOAD_BYTES) {
    throw new SeedAsrProtocolError('PAYLOAD_TOO_LARGE', 'Payload exceeds the protocol safety limit')
  }
  const payloadOffset = offset + UINT32_BYTES
  requireExactFrameLength(bytes, payloadOffset, payloadLength)
  return bytes.subarray(payloadOffset)
}

function requireExactFrameLength(bytes: Buffer, offset: number, declaredLength: number): void {
  const actualLength = bytes.byteLength - offset
  if (actualLength !== declaredLength) {
    throw new SeedAsrProtocolError(
      actualLength < declaredLength ? 'TRUNCATED_PAYLOAD' : 'TRAILING_BYTES',
      `Declared payload length ${declaredLength} does not match actual length ${actualLength}`,
    )
  }
}

function requireAvailable(bytes: Buffer, offset: number, required: number, code: string): void {
  if (offset < 0 || required < 0 || offset + required > bytes.byteLength) {
    throw new SeedAsrProtocolError(code, 'Server frame ended before the declared field')
  }
}

function validateEncoding(serialization: number, compression: number): void {
  if (serialization !== SeedAsrSerialization.NONE && serialization !== SeedAsrSerialization.JSON) {
    throw new SeedAsrProtocolError('UNSUPPORTED_SERIALIZATION', `Unsupported serialization ${serialization}`)
  }
  if (compression !== SeedAsrCompression.NONE && compression !== SeedAsrCompression.GZIP) {
    throw new SeedAsrProtocolError('UNSUPPORTED_COMPRESSION', `Unsupported compression ${compression}`)
  }
}

function decompressPayload(payload: Buffer, compression: number): Buffer {
  if (compression === SeedAsrCompression.NONE) return payload
  try {
    const decompressed = gunzipSync(payload, { maxOutputLength: MAX_PAYLOAD_BYTES })
    if (decompressed.byteLength > MAX_PAYLOAD_BYTES) {
      throw new SeedAsrProtocolError('PAYLOAD_TOO_LARGE', 'Decompressed payload exceeds the safety limit')
    }
    return decompressed
  } catch (error) {
    if (error instanceof SeedAsrProtocolError) throw error
    throw new SeedAsrProtocolError('INVALID_GZIP', 'Server payload is not valid gzip data')
  }
}

function parseJsonObject(payload: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(payload.toString('utf8'))
    const object = asRecord(value)
    if (object === null) throw new Error('not an object')
    return object
  } catch {
    throw new SeedAsrProtocolError('INVALID_JSON', 'Server payload is not a JSON object')
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isFinal(flags: number, sequence: number | null): boolean {
  return flags === SeedAsrFlags.FINAL_WITHOUT_SEQUENCE
    || flags === SeedAsrFlags.HAS_NEGATIVE_SEQUENCE
    || (sequence !== null && sequence < 0)
}
