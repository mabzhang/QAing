import type { CSSProperties } from 'react'
import type { AudioLevelSample } from '../../core/contracts'
import type { AudioSourceKind } from '../../core/types'
import { AUDIO_SOURCE_LABELS } from './view-model'
import { AUDIO_LEVEL_HISTORY_SIZE, audioLevelPercent } from './audio-level'
import type { CaptureHealth } from './contracts'

interface AudioLevelWaveformProps {
  readonly levels: readonly AudioLevelSample[]
  readonly source: AudioSourceKind
  readonly captureHealth: CaptureHealth
  readonly compact?: boolean
}

function statusText(captureHealth: CaptureHealth, percent: number): string {
  switch (captureHealth) {
    case 'starting': return '正在等待音频'
    case 'reconnecting': return '正在恢复音频'
    case 'paused': return '音频已暂停'
    case 'silent': return '未检测到声音'
    case 'healthy': return `当前音量 ${percent}%`
    case 'idle': return '音频未启动'
  }
}

export function AudioLevelWaveform({
  levels,
  source,
  captureHealth,
  compact = false,
}: AudioLevelWaveformProps): React.JSX.Element {
  const samples = levels.slice(-AUDIO_LEVEL_HISTORY_SIZE)
  const paddedLevels = [
    ...Array.from({ length: Math.max(0, AUDIO_LEVEL_HISTORY_SIZE - samples.length) }, () => 0),
    ...samples.map((sample) => sample.level),
  ]
  const meterIsCurrent = captureHealth === 'healthy'
  const percent = meterIsCurrent ? audioLevelPercent(samples.at(-1)?.level) : 0
  const stateText = statusText(captureHealth, percent)

  return (
    <div
      className={`audio-level-meter audio-level-meter--${captureHealth}${compact ? ' audio-level-meter--compact' : ''}`}
      role="meter"
      aria-label={`${AUDIO_SOURCE_LABELS[source]}实时音量`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={stateText}
    >
      <span className="audio-level-meter__label" aria-hidden="true">
        <small>实时音量</small>
        <strong>{captureHealth === 'healthy' ? `${percent}%` : stateText}</strong>
      </span>
      <span className="audio-level-meter__wave" aria-hidden="true">
        {paddedLevels.map((level, index) => {
          const normalized = meterIsCurrent ? Math.min(1, Math.max(0, level)) : 0
          const style: CSSProperties = {
            height: `${3 + normalized * 25}px`,
            opacity: 0.28 + normalized * 0.72,
          }
          return <i key={index} style={style} />
        })}
      </span>
    </div>
  )
}
