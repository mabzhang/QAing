import type { AudioLevelSample } from '../../core/contracts'
import type { AudioSourceKind } from '../../core/types'

export const AUDIO_LEVEL_HISTORY_SIZE = 16
export const MIN_AUDIO_LEVEL_INTERVAL_MS = 150

function sanitizeSample(sample: unknown): AudioLevelSample | null {
  if (typeof sample !== 'object' || sample === null) return null
  const candidate = sample as Record<string, unknown>
  if (
    typeof candidate['sessionId'] !== 'string'
    || candidate['sessionId'].length < 1
    || candidate['sessionId'].length > 128
    || (candidate['source'] !== 'microphone' && candidate['source'] !== 'system')
    || !Number.isSafeInteger(candidate['sequence'])
    || (candidate['sequence'] as number) < 0
    || typeof candidate['timestampMs'] !== 'number'
    || !Number.isFinite(candidate['timestampMs'])
    || candidate['timestampMs'] < 0
    || typeof candidate['level'] !== 'number'
    || !Number.isFinite(candidate['level'])
    || candidate['level'] < 0
    || candidate['level'] > 1
  ) return null
  return {
    sessionId: candidate['sessionId'],
    source: candidate['source'],
    sequence: candidate['sequence'] as number,
    timestampMs: candidate['timestampMs'],
    level: candidate['level'],
  }
}

/**
 * Keeps only monotonic, privacy-safe meter samples for the active capture.
 * The renderer never receives or stores PCM bytes.
 */
export function appendAudioLevelSample(
  history: readonly AudioLevelSample[],
  sample: unknown,
  activeSessionId: string | null,
  activeSource: AudioSourceKind,
): readonly AudioLevelSample[] {
  const sanitized = sanitizeSample(sample)
  if (
    sanitized === null
    || activeSessionId === null
    || sanitized.sessionId !== activeSessionId
    || sanitized.source !== activeSource
  ) return history

  const current = history.filter((item) => (
    item.sessionId === activeSessionId
    && item.source === activeSource
  ))
  const previous = current.at(-1)
  if (
    previous !== undefined
    && (
      sanitized.sequence <= previous.sequence
      || sanitized.timestampMs <= previous.timestampMs
      || sanitized.timestampMs - previous.timestampMs < MIN_AUDIO_LEVEL_INTERVAL_MS
    )
  ) return history
  return [...current, sanitized].slice(-AUDIO_LEVEL_HISTORY_SIZE)
}

export function audioLevelPercent(level: number | undefined): number {
  if (level === undefined || !Number.isFinite(level)) return 0
  return Math.round(Math.min(1, Math.max(0, level)) * 100)
}
