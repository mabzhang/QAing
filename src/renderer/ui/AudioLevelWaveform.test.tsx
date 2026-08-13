import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioLevelSample } from '../../core/contracts'
import { AudioLevelWaveform } from './AudioLevelWaveform'
import { AUDIO_LEVEL_HISTORY_SIZE, appendAudioLevelSample } from './audio-level'

function sample(sequence: number, level: number, sessionId = 'session-1'): AudioLevelSample {
  return { sessionId, source: 'microphone', sequence, timestampMs: 1_000 + sequence * 200, level }
}

describe('audio level waveform', () => {
  it('accepts only active monotonic scalar samples and retains a bounded history', () => {
    let history: readonly AudioLevelSample[] = []
    for (let index = 0; index < AUDIO_LEVEL_HISTORY_SIZE + 4; index += 1) {
      history = appendAudioLevelSample(history, sample(index, index / 100), 'session-1', 'microphone')
    }

    expect(history).toHaveLength(AUDIO_LEVEL_HISTORY_SIZE)
    expect(history[0]?.sequence).toBe(4)
    expect(appendAudioLevelSample(history, sample(19, 0.9), 'session-1', 'microphone')).toBe(history)
    expect(appendAudioLevelSample(history, sample(20, 0.9, 'stale-session'), 'session-1', 'microphone')).toBe(history)
    expect(appendAudioLevelSample(history, sample(20, Number.NaN), 'session-1', 'microphone')).toBe(history)
    expect(appendAudioLevelSample(history, null, 'session-1', 'microphone')).toBe(history)
    expect(JSON.stringify(history)).not.toMatch(/pcm|buffer|payload/iu)
  })

  it('strips unexpected binary fields and rejects an event flood at the renderer boundary', () => {
    const unsafeSample = {
      ...sample(1, 0.5),
      pcm16: new Uint8Array([1, 2, 3]),
      payload: 'must-not-cross',
    }
    const first = appendAudioLevelSample([], unsafeSample, 'session-1', 'microphone')
    const flooded = appendAudioLevelSample(first, {
      ...sample(2, 0.7),
      timestampMs: unsafeSample.timestampMs + 20,
    }, 'session-1', 'microphone')

    expect(flooded).toBe(first)
    expect(JSON.stringify(first)).toBe(JSON.stringify([sample(1, 0.5)]))
    expect(Object.keys(first[0] ?? {})).toEqual(['sessionId', 'source', 'sequence', 'timestampMs', 'level'])
  })

  it('renders only real sample history as an accessible, non-live meter', () => {
    const html = renderToStaticMarkup(
      <AudioLevelWaveform
        levels={[sample(1, 0.12), sample(2, 0.42)]}
        source="microphone"
        captureHealth="healthy"
      />,
    )
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-valuenow="42"')
    expect(html).toContain('aria-valuetext="当前音量 42%"')
    expect(html.match(/<i /g)).toHaveLength(AUDIO_LEVEL_HISTORY_SIZE)
    expect(html).not.toContain('aria-live')
    expect(html).not.toMatch(/pcm|buffer|payload/iu)
  })

  it('does not present a stale level while capture is still connecting', () => {
    const html = renderToStaticMarkup(
      <AudioLevelWaveform
        levels={[sample(1, 0.84)]}
        source="microphone"
        captureHealth="starting"
      />,
    )
    expect(html).toContain('aria-valuenow="0"')
    expect(html).toContain('aria-valuetext="正在等待音频"')
    expect(html).not.toContain('84%')
  })
})
