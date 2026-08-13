export type NativeAudioSource = 'microphone' | 'system'

export const AudioHelperEventKind = {
  STATUS: 1,
  PCM: 2,
  HEARTBEAT: 3,
} as const

export interface AudioHelperStatusEvent {
  readonly kind: 'status'
  readonly sessionId: string
  readonly source: NativeAudioSource | null
  readonly sequence: bigint
  readonly timestampMs: bigint
  readonly state: 'ready' | 'starting' | 'capturing' | 'silent' | 'suspended' | 'stopped' | 'error'
  readonly code?: string
  readonly lastFrameTimestampMs?: bigint
}

export interface AudioHelperPcmEvent {
  readonly kind: 'pcm'
  readonly sessionId: string
  readonly source: NativeAudioSource
  readonly sequence: bigint
  readonly timestampMs: bigint
  readonly energy: number
  readonly pcm16: Buffer
}

export interface AudioHelperHeartbeatEvent {
  readonly kind: 'heartbeat'
  readonly sessionId: string
  readonly source: NativeAudioSource | null
  readonly sequence: bigint
  readonly timestampMs: bigint
}

export type AudioHelperEvent = AudioHelperStatusEvent | AudioHelperPcmEvent | AudioHelperHeartbeatEvent

export type AudioHelperCommand =
  | { readonly command: 'start'; readonly sessionId: string; readonly source: NativeAudioSource }
  | { readonly command: 'stop'; readonly sessionId: string }
  | { readonly command: 'ping' }

const MAGIC = Buffer.from('QAG1')
const VERSION = 1
const PREFIX_BYTES = 4
const FIXED_BODY_BYTES = 28
const MAX_FRAME_BYTES = 1024 * 1024
const PCM_FRAME_BYTES = 6_400

export class AudioHelperProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AudioHelperProtocolError'
    this.code = code
  }
}

export class AudioHelperFrameDecoder {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  push(chunk: Uint8Array): AudioHelperEvent[] {
    if (chunk.byteLength === 0) return []
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    this.buffered = this.buffered.byteLength === 0
      ? Buffer.from(incoming)
      : Buffer.concat([this.buffered, incoming])
    if (this.buffered.byteLength > MAX_FRAME_BYTES + PREFIX_BYTES) {
      throw new AudioHelperProtocolError('BUFFER_LIMIT', 'Audio helper frame buffer exceeded its safety limit')
    }

    const events: AudioHelperEvent[] = []
    while (this.buffered.byteLength >= PREFIX_BYTES) {
      const length = this.buffered.readUInt32BE(0)
      if (length < FIXED_BODY_BYTES || length > MAX_FRAME_BYTES) {
        throw new AudioHelperProtocolError('INVALID_LENGTH', `Invalid helper frame length ${length}`)
      }
      if (this.buffered.byteLength < PREFIX_BYTES + length) break
      const body = this.buffered.subarray(PREFIX_BYTES, PREFIX_BYTES + length)
      events.push(decodeBody(body))
      this.buffered = Buffer.from(this.buffered.subarray(PREFIX_BYTES + length))
    }
    return events
  }

  end(): void {
    if (this.buffered.byteLength !== 0) {
      throw new AudioHelperProtocolError('TRUNCATED_STREAM', 'Audio helper stream ended in the middle of a frame')
    }
  }
}

export function encodeAudioHelperCommand(command: AudioHelperCommand): Buffer {
  validateCommand(command)
  const payload = Buffer.from(JSON.stringify(command), 'utf8')
  if (payload.byteLength > 16 * 1024) {
    throw new AudioHelperProtocolError('COMMAND_TOO_LARGE', 'Audio helper command is too large')
  }
  const frame = Buffer.allocUnsafe(PREFIX_BYTES + payload.byteLength)
  frame.writeUInt32BE(payload.byteLength, 0)
  payload.copy(frame, PREFIX_BYTES)
  return frame
}

/** Exported for deterministic protocol tests and fake-helper fixtures only. */
export function encodeAudioHelperEventForTest(event: AudioHelperEvent): Buffer {
  const sourceCode = event.source === 'microphone' ? 1 : event.source === 'system' ? 2 : 0
  let metadata: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let kind: number
  if (event.kind === 'status') {
    kind = AudioHelperEventKind.STATUS
    metadata = Buffer.from(JSON.stringify({
      state: event.state,
      ...(event.code === undefined ? {} : { code: event.code }),
      ...(event.lastFrameTimestampMs === undefined
        ? {}
        : { lastFrameTimestampMs: Number(event.lastFrameTimestampMs) }),
    }))
  } else if (event.kind === 'pcm') {
    kind = AudioHelperEventKind.PCM
    metadata = Buffer.allocUnsafe(4)
    metadata.writeFloatBE(event.energy, 0)
    payload = event.pcm16
  } else {
    kind = AudioHelperEventKind.HEARTBEAT
  }
  const session = Buffer.from(event.sessionId, 'utf8')
  const bodyLength = FIXED_BODY_BYTES + session.length + metadata.length + payload.length
  const frame = Buffer.allocUnsafe(PREFIX_BYTES + bodyLength)
  frame.writeUInt32BE(bodyLength, 0)
  MAGIC.copy(frame, 4)
  frame[8] = VERSION
  frame[9] = kind
  frame[10] = sourceCode
  frame[11] = 0
  frame.writeBigUInt64BE(event.sequence, 12)
  frame.writeBigUInt64BE(event.timestampMs, 20)
  frame.writeUInt16BE(session.length, 28)
  frame.writeUInt16BE(metadata.length, 30)
  session.copy(frame, 32)
  metadata.copy(frame, 32 + session.length)
  payload.copy(frame, 32 + session.length + metadata.length)
  return frame
}

function decodeBody(body: Buffer): AudioHelperEvent {
  if (!body.subarray(0, 4).equals(MAGIC)) {
    throw new AudioHelperProtocolError('INVALID_MAGIC', 'Audio helper frame has invalid magic bytes')
  }
  if (body[4] !== VERSION) {
    throw new AudioHelperProtocolError('UNSUPPORTED_VERSION', `Unsupported audio helper protocol version ${body[4]}`)
  }
  const kind = body[5]!
  const source = decodeSource(body[6]!)
  const sequence = body.readBigUInt64BE(8)
  const timestampMs = body.readBigUInt64BE(16)
  const sessionLength = body.readUInt16BE(24)
  const metadataLength = body.readUInt16BE(26)
  const fieldsLength = FIXED_BODY_BYTES + sessionLength + metadataLength
  if (fieldsLength > body.byteLength) {
    throw new AudioHelperProtocolError('TRUNCATED_FIELDS', 'Audio helper frame fields exceed the declared frame')
  }
  const sessionId = body.subarray(FIXED_BODY_BYTES, FIXED_BODY_BYTES + sessionLength).toString('utf8')
  if (sessionId !== '' && !isValidSessionId(sessionId)) {
    throw new AudioHelperProtocolError('INVALID_SESSION_ID', 'Audio helper event contains an invalid session identifier')
  }
  const metadataStart = FIXED_BODY_BYTES + sessionLength
  const metadata = body.subarray(metadataStart, metadataStart + metadataLength)
  const payload = body.subarray(metadataStart + metadataLength)

  if (kind === AudioHelperEventKind.PCM) {
    if (sessionId === '') throw new AudioHelperProtocolError('MISSING_SESSION', 'PCM event is missing its session identifier')
    if (source === null) throw new AudioHelperProtocolError('MISSING_SOURCE', 'PCM event is missing its source')
    if (metadata.length !== 4 || payload.length !== PCM_FRAME_BYTES) {
      throw new AudioHelperProtocolError('INVALID_PCM_FRAME', 'PCM event must contain energy and exactly 200ms PCM16')
    }
    const energy = metadata.readFloatBE(0)
    if (!Number.isFinite(energy) || energy < 0 || energy > 1) {
      throw new AudioHelperProtocolError('INVALID_ENERGY', 'PCM energy must be finite and normalized')
    }
    return { kind: 'pcm', sessionId, source, sequence, timestampMs, energy, pcm16: Buffer.from(payload) }
  }

  if (payload.length !== 0) {
    throw new AudioHelperProtocolError('UNEXPECTED_PAYLOAD', 'Non-PCM helper event contains a payload')
  }
  if (kind === AudioHelperEventKind.HEARTBEAT) {
    if (metadata.length !== 0) throw new AudioHelperProtocolError('INVALID_HEARTBEAT', 'Heartbeat metadata must be empty')
    return { kind: 'heartbeat', sessionId, source, sequence, timestampMs }
  }
  if (kind !== AudioHelperEventKind.STATUS) {
    throw new AudioHelperProtocolError('UNKNOWN_KIND', `Unknown audio helper event kind ${kind}`)
  }

  let value: unknown
  try {
    value = JSON.parse(metadata.toString('utf8'))
  } catch {
    throw new AudioHelperProtocolError('INVALID_STATUS_JSON', 'Status metadata is not valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AudioHelperProtocolError('INVALID_STATUS', 'Status metadata is not an object')
  }
  const record = value as Record<string, unknown>
  if (!isStatusState(record.state)) {
    throw new AudioHelperProtocolError('INVALID_STATUS', 'Status metadata contains an unknown state')
  }
  const code = typeof record.code === 'string' ? record.code : undefined
  if (code !== undefined && !/^[A-Z0-9_]{1,64}$/.test(code)) {
    throw new AudioHelperProtocolError('INVALID_STATUS', 'Status metadata contains an invalid code')
  }
  if (record.lastFrameTimestampMs !== undefined && (
    typeof record.lastFrameTimestampMs !== 'number'
    || !Number.isSafeInteger(record.lastFrameTimestampMs)
    || record.lastFrameTimestampMs < 0
  )) {
    throw new AudioHelperProtocolError('INVALID_STATUS', 'Status metadata contains an invalid last-frame timestamp')
  }
  const lastFrameTimestampMs = typeof record.lastFrameTimestampMs === 'number'
    ? BigInt(record.lastFrameTimestampMs)
    : undefined
  if (sessionId === '' && record.state !== 'ready' && record.state !== 'error') {
    throw new AudioHelperProtocolError('MISSING_SESSION', 'Capture status is missing its session identifier')
  }
  return {
    kind: 'status',
    sessionId,
    source,
    sequence,
    timestampMs,
    state: record.state,
    ...(code === undefined ? {} : { code }),
    ...(lastFrameTimestampMs === undefined ? {} : { lastFrameTimestampMs }),
  }
}

function decodeSource(code: number): NativeAudioSource | null {
  if (code === 0) return null
  if (code === 1) return 'microphone'
  if (code === 2) return 'system'
  throw new AudioHelperProtocolError('UNKNOWN_SOURCE', `Unknown audio source ${code}`)
}

function isStatusState(value: unknown): value is AudioHelperStatusEvent['state'] {
  return value === 'ready' || value === 'starting' || value === 'capturing' || value === 'silent'
    || value === 'suspended' || value === 'stopped' || value === 'error'
}

function validateCommand(command: AudioHelperCommand): void {
  if (command.command === 'ping') return
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(command.sessionId)) {
    throw new AudioHelperProtocolError('INVALID_SESSION_ID', 'Session identifier contains unsupported characters')
  }
  if (command.command === 'start' && command.source !== 'microphone' && command.source !== 'system') {
    throw new AudioHelperProtocolError('UNKNOWN_SOURCE', 'Start command contains an unknown source')
  }
}

function isValidSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)
}
