import { describe, expect, it } from 'vitest'
import {
  AudioHelperFrameDecoder,
  encodeAudioHelperCommand,
  encodeAudioHelperEventForTest,
  type AudioHelperEvent,
} from './protocol'
import type { AudioHelperProtocolError } from './protocol'

const pcmEvent: AudioHelperEvent = {
  kind: 'pcm',
  sessionId: 'session-1',
  source: 'system',
  sequence: 9n,
  timestampMs: 1_234n,
  energy: 0.25,
  pcm16: Buffer.alloc(6_400, 7),
}

describe('audio helper binary protocol', () => {
  it('decodes one event split across arbitrary stdout chunks', () => {
    const encoded = encodeAudioHelperEventForTest(pcmEvent)
    const decoder = new AudioHelperFrameDecoder()
    expect(decoder.push(encoded.subarray(0, 3))).toEqual([])
    expect(decoder.push(encoded.subarray(3, 91))).toEqual([])
    expect(decoder.push(encoded.subarray(91))).toEqual([pcmEvent])
    expect(() => decoder.end()).not.toThrow()
  })

  it('decodes multiple coalesced frames without confusing their boundaries', () => {
    const status: AudioHelperEvent = {
      kind: 'status',
      sessionId: 'session-1',
      source: 'microphone',
      sequence: 0n,
      timestampMs: 1n,
      state: 'capturing',
      lastFrameTimestampMs: 123n,
    }
    const heartbeat: AudioHelperEvent = {
      kind: 'heartbeat',
      sessionId: 'session-1',
      source: 'microphone',
      sequence: 4n,
      timestampMs: 2n,
    }
    const decoder = new AudioHelperFrameDecoder()
    expect(decoder.push(Buffer.concat([
      encodeAudioHelperEventForTest(status),
      encodeAudioHelperEventForTest(heartbeat),
    ]))).toEqual([status, heartbeat])
  })

  it('accepts global ready status but still requires sessions for capture events', () => {
    const ready: AudioHelperEvent = {
      kind: 'status', sessionId: '', source: null, sequence: 0n, timestampMs: 1n, state: 'ready',
    }
    expect(new AudioHelperFrameDecoder().push(encodeAudioHelperEventForTest(ready))).toEqual([ready])
    const invalid = encodeAudioHelperEventForTest({ ...pcmEvent, sessionId: '' })
    expect(() => new AudioHelperFrameDecoder().push(invalid)).toThrowError(
      expect.objectContaining<Partial<AudioHelperProtocolError>>({ code: 'MISSING_SESSION' }),
    )
  })

  it('encodes length-prefixed commands and rejects unsafe session identifiers', () => {
    const encoded = encodeAudioHelperCommand({ command: 'start', sessionId: 'qa:session-2', source: 'system' })
    expect(encoded.readUInt32BE(0)).toBe(encoded.length - 4)
    expect(JSON.parse(encoded.subarray(4).toString('utf8'))).toEqual({
      command: 'start',
      sessionId: 'qa:session-2',
      source: 'system',
    })
    expect(() => encodeAudioHelperCommand({ command: 'stop', sessionId: 'newline\nattack' })).toThrowError(
      expect.objectContaining<Partial<AudioHelperProtocolError>>({ code: 'INVALID_SESSION_ID' }),
    )
  })

  it('rejects invalid PCM sizes and truncated streams', () => {
    const encoded = encodeAudioHelperEventForTest({ ...pcmEvent, pcm16: Buffer.alloc(2) })
    const decoder = new AudioHelperFrameDecoder()
    expect(() => decoder.push(encoded)).toThrowError(
      expect.objectContaining<Partial<AudioHelperProtocolError>>({ code: 'INVALID_PCM_FRAME' }),
    )
    const truncated = new AudioHelperFrameDecoder()
    truncated.push(encodeAudioHelperEventForTest(pcmEvent).subarray(0, 20))
    expect(() => truncated.end()).toThrowError(
      expect.objectContaining<Partial<AudioHelperProtocolError>>({ code: 'TRUNCATED_STREAM' }),
    )
  })
})
