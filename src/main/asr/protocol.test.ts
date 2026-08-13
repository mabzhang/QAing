import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  createSeedAsrRequestPayload,
  decodeServerFrame,
  encodeAudioOnlyRequest,
  encodeFullClientRequest,
  SeedAsrCompression,
  SeedAsrFlags,
  SeedAsrMessageType,
  SeedAsrSerialization,
  SeedAsrSingleResultAssembler,
} from './protocol'
import type { SeedAsrProtocolError } from './protocol'

function serverFrame(options: {
  readonly payload: unknown
  readonly sequence?: number
  readonly flags?: number
  readonly compression?: number
  readonly headerWords?: number
}): Buffer {
  const compression = options.compression ?? SeedAsrCompression.GZIP
  const json = Buffer.from(JSON.stringify(options.payload), 'utf8')
  const payload = compression === SeedAsrCompression.GZIP ? gzipSync(json) : json
  const headerWords = options.headerWords ?? 1
  const headerBytes = headerWords * 4
  const flags = options.flags ?? SeedAsrFlags.HAS_POSITIVE_SEQUENCE
  const hasSequence = flags === SeedAsrFlags.HAS_POSITIVE_SEQUENCE || flags === SeedAsrFlags.HAS_NEGATIVE_SEQUENCE
  const frame = Buffer.alloc(headerBytes + (hasSequence ? 4 : 0) + 4 + payload.length)
  frame[0] = 0x10 | headerWords
  frame[1] = (SeedAsrMessageType.FULL_SERVER_RESPONSE << 4) | flags
  frame[2] = (SeedAsrSerialization.JSON << 4) | compression
  if (headerBytes > 4) frame.fill(0xa5, 4, headerBytes)
  let offset = headerBytes
  if (hasSequence) {
    frame.writeInt32BE(options.sequence ?? 1, offset)
    offset += 4
  }
  frame.writeUInt32BE(payload.length, offset)
  payload.copy(frame, offset + 4)
  return frame
}

describe('SeedASR v3 binary protocol', () => {
  it('encodes a gzip JSON full client request with fixed PCM metadata', () => {
    const request = createSeedAsrRequestPayload({ uid: 'anonymous-device', language: 'zh-CN' })
    const frame = encodeFullClientRequest(request)

    expect(frame[0]).toBe(0x11)
    expect(frame[1]).toBe(0x11)
    expect(frame[2]).toBe(0x11)
    expect(frame.subarray(0, 8).toString('hex')).toBe('1111110000000001')
    const payloadSize = frame.readUInt32BE(8)
    expect(payloadSize).toBe(frame.length - 12)
    const decoded = JSON.parse(gunzipSync(frame.subarray(12)).toString('utf8')) as Record<string, unknown>
    expect(decoded).toMatchObject({
      audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
      request: { model_name: 'bigmodel', show_utterances: true, result_type: 'full' },
    })
  })

  it('matches the official sequenced SAUC v3 initial-request golden layout', () => {
    const frame = encodeFullClientRequest(createSeedAsrRequestPayload({ uid: 'u' }))
    expect(frame[0]).toBe(0x11)
    expect(frame[1]).toBe(
      (SeedAsrMessageType.FULL_CLIENT_REQUEST << 4) | SeedAsrFlags.HAS_POSITIVE_SEQUENCE,
    )
    expect(frame[2]).toBe((SeedAsrSerialization.JSON << 4) | SeedAsrCompression.GZIP)
    expect(frame[3]).toBe(0)
    expect(frame.readInt32BE(4)).toBe(1)
    expect(frame.readUInt32BE(8)).toBe(frame.length - 12)
  })

  it('encodes positive audio sequences and a negative final sequence', () => {
    const pcm = Uint8Array.from([1, 2, 3, 4])
    const regular = encodeAudioOnlyRequest(pcm, 7)
    const final = encodeAudioOnlyRequest(new Uint8Array(), 8, true)

    expect(regular[1]).toBe((SeedAsrMessageType.AUDIO_ONLY_REQUEST << 4) | SeedAsrFlags.HAS_POSITIVE_SEQUENCE)
    expect(regular.readInt32BE(4)).toBe(7)
    expect(gunzipSync(regular.subarray(12))).toEqual(Buffer.from(pcm))
    expect(final[1]).toBe((SeedAsrMessageType.AUDIO_ONLY_REQUEST << 4) | SeedAsrFlags.HAS_NEGATIVE_SEQUENCE)
    expect(final.readInt32BE(4)).toBe(-8)
    expect(gunzipSync(final.subarray(12))).toHaveLength(0)
  })

  it('assembles single-result revisions by definite timestamps without duplicating history', () => {
    const assembler = new SeedAsrSingleResultAssembler()
    const first = assembler.apply({
      type: 'transcript_replace', sequence: 2, isFinalPacket: false, fullText: '你好',
      utterances: [{ text: '你好', definite: false, startTimeMs: 0, endTimeMs: 300 }],
    })
    const committed = assembler.apply({
      type: 'transcript_replace', sequence: 3, isFinalPacket: false, fullText: '你好。',
      utterances: [{ text: '你好。', definite: true, startTimeMs: 0, endTimeMs: 400 }],
    })
    const next = assembler.apply({
      type: 'transcript_replace', sequence: 4, isFinalPacket: false, fullText: '请问',
      utterances: [{ text: '请问', definite: false, startTimeMs: 500, endTimeMs: 800 }],
    })

    expect(first.fullText).toBe('你好')
    expect(committed.fullText).toBe('你好。')
    expect(next.fullText).toBe('你好。请问')
    expect(next.utterances).toHaveLength(2)
  })

  it('requires timestamps before committing single-result utterances', () => {
    const assembler = new SeedAsrSingleResultAssembler()
    expect(() => assembler.apply({
      type: 'transcript_replace', sequence: 2, isFinalPacket: false, fullText: 'x',
      utterances: [{ text: 'x', definite: true, startTimeMs: null, endTimeMs: null }],
    })).toThrowError(expect.objectContaining({ code: 'MISSING_UTTERANCE_TIME' }))
  })

  it('decodes full-result responses as replacements, including utterance certainty', () => {
    const frame = serverFrame({
      sequence: 11,
      payload: {
        result: {
          text: '已确定正在修订',
          utterances: [
            { text: '已确定', definite: true, start_time: 0, end_time: 500 },
            { text: '正在修订', definite: false, start_time: 500, end_time: 900 },
          ],
        },
      },
    })

    expect(decodeServerFrame(frame)).toEqual({
      type: 'transcript_replace',
      sequence: 11,
      isFinalPacket: false,
      fullText: '已确定正在修订',
      utterances: [
        { text: '已确定', definite: true, startTimeMs: 0, endTimeMs: 500 },
        { text: '正在修订', definite: false, startTimeMs: 500, endTimeMs: 900 },
      ],
    })
  })

  it('accepts extended headers and recognizes negative final server packets', () => {
    const frame = serverFrame({
      sequence: -12,
      flags: SeedAsrFlags.HAS_NEGATIVE_SEQUENCE,
      headerWords: 2,
      compression: SeedAsrCompression.NONE,
      payload: { result: { text: '最终', utterances: [] } },
    })
    expect(decodeServerFrame(frame)).toMatchObject({
      type: 'transcript_replace',
      sequence: -12,
      isFinalPacket: true,
      fullText: '最终',
    })
  })

  it('decodes the special server error frame boundary', () => {
    const message = Buffer.from('{"message":"busy"}', 'utf8')
    const frame = Buffer.alloc(12 + message.length)
    frame[0] = 0x11
    frame[1] = 0xf0
    frame[2] = 0x10
    frame.writeUInt32BE(55_000_031, 4)
    frame.writeUInt32BE(message.length, 8)
    message.copy(frame, 12)

    expect(decodeServerFrame(frame)).toEqual({
      type: 'server_error',
      code: 55_000_031,
      message: '{"message":"busy"}',
    })
  })

  it.each([
    ['truncated header', Buffer.from([0x11, 0x91, 0x11]), 'TRUNCATED_HEADER'],
    ['invalid header length', Buffer.from([0x13, 0x91, 0x11, 0]), 'INVALID_HEADER_SIZE'],
    ['truncated size', Buffer.from([0x11, 0x90, 0x11, 0]), 'TRUNCATED_PAYLOAD_SIZE'],
  ])('rejects %s', (_name, frame, expectedCode) => {
    expect(() => decodeServerFrame(frame)).toThrowError(expect.objectContaining({ code: expectedCode }))
  })

  it('rejects trailing bytes instead of silently accepting frame smuggling', () => {
    const valid = serverFrame({ payload: { result: { text: 'x' } } })
    const smuggled = Buffer.concat([valid, Buffer.from([0])])
    expect(() => decodeServerFrame(smuggled)).toThrowError(
      expect.objectContaining<Partial<SeedAsrProtocolError>>({ code: 'TRAILING_BYTES' }),
    )
  })

  it('rejects a sequence whose sign contradicts the flags', () => {
    const invalid = serverFrame({
      flags: SeedAsrFlags.HAS_NEGATIVE_SEQUENCE,
      sequence: 2,
      payload: {},
    })
    expect(() => decodeServerFrame(invalid)).toThrowError(
      expect.objectContaining<Partial<SeedAsrProtocolError>>({ code: 'INVALID_SEQUENCE_SIGN' }),
    )
  })

  it('rejects zero for both positive and negative sequenced server flags', () => {
    for (const flags of [SeedAsrFlags.HAS_POSITIVE_SEQUENCE, SeedAsrFlags.HAS_NEGATIVE_SEQUENCE]) {
      const invalid = serverFrame({ flags, sequence: 0, payload: {} })
      expect(() => decodeServerFrame(invalid)).toThrowError(
        expect.objectContaining<Partial<SeedAsrProtocolError>>({ code: 'INVALID_SEQUENCE_SIGN' }),
      )
    }
  })
})
