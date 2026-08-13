import { GripHorizontal } from 'lucide-react'
import { useRef } from 'react'
import {
  ANSWER_PANEL_DEFAULT_HEIGHT,
  ANSWER_PANEL_MAX_HEIGHT,
  ANSWER_PANEL_MIN_HEIGHT,
  answerPanelHeightForKey,
  clampAnswerPanelHeight,
} from './answer-resize'

interface AnswerResizeHandleProps {
  readonly height: number
  readonly onResize: (height: number) => void
}

interface DragStart {
  readonly pointerId: number
  readonly clientY: number
  readonly height: number
}

export function AnswerResizeHandle({ height, onResize }: AnswerResizeHandleProps): React.JSX.Element {
  const dragStartRef = useRef<DragStart | null>(null)
  const value = clampAnswerPanelHeight(height)

  return (
    <div
      className="answer-resize-handle"
      role="separator"
      aria-label="调整答案面板高度"
      aria-controls="answer-panel-region"
      aria-orientation="horizontal"
      aria-valuemin={ANSWER_PANEL_MIN_HEIGHT}
      aria-valuemax={ANSWER_PANEL_MAX_HEIGHT}
      aria-valuenow={value}
      aria-valuetext={`答案面板高度 ${value} 像素`}
      tabIndex={0}
      title="拖动调整高度；方向键微调；双击复位"
      onDoubleClick={() => { onResize(ANSWER_PANEL_DEFAULT_HEIGHT) }}
      onKeyDown={(event) => {
        const next = answerPanelHeightForKey(value, event.key)
        if (next === null) return
        event.preventDefault()
        onResize(next)
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        dragStartRef.current = { pointerId: event.pointerId, clientY: event.clientY, height: value }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const start = dragStartRef.current
        if (start === null || start.pointerId !== event.pointerId) return
        onResize(clampAnswerPanelHeight(start.height + start.clientY - event.clientY))
      }}
      onPointerUp={(event) => {
        if (dragStartRef.current?.pointerId !== event.pointerId) return
        dragStartRef.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={() => { dragStartRef.current = null }}
    >
      <GripHorizontal aria-hidden="true" />
      <span className="sr-only">使用上下方向键调整，Home 最小，End 最大，双击恢复默认高度。</span>
    </div>
  )
}
