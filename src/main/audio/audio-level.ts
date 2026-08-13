import type { AudioHelperPcmEvent, NativeAudioSource } from './protocol'

/**
 * Renderer-safe input-level sample. This deliberately contains no PCM bytes
 * and is emitted at the helper's native 200 ms frame cadence (5 Hz).
 */
export interface AudioInputLevelEvent {
  readonly kind: 'audio_level'
  readonly sessionId: string
  readonly source: NativeAudioSource
  readonly sequence: bigint
  readonly timestampMs: bigint
  readonly level: number
}

export function audioInputLevelFromPcm(event: AudioHelperPcmEvent): AudioInputLevelEvent {
  return {
    kind: 'audio_level',
    sessionId: event.sessionId,
    source: event.source,
    sequence: event.sequence,
    timestampMs: event.timestampMs,
    level: event.energy,
  }
}
