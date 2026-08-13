import { GripVertical } from 'lucide-react'
import { useRef } from 'react'
import {
  WORKBENCH_DEFAULT_WIDTH,
  WORKBENCH_MIN_WIDTH,
  clampWorkbenchPreference,
  finalizedWorkbenchDragWidth,
  type WorkbenchDragState,
  workbenchWidthForKey,
} from './workbench-resize'

interface WorkbenchResizeHandleProps {
  readonly width: number
  readonly maxWidth: number
  readonly onResize: (width: number) => void
  readonly onCommit: (width: number) => void
}

export function WorkbenchResizeHandle({
  width,
  maxWidth,
  onResize,
  onCommit,
}: WorkbenchResizeHandleProps): React.JSX.Element {
  const dragStartRef = useRef<WorkbenchDragState | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingWidthRef = useRef(width)
  const value = Math.min(maxWidth, clampWorkbenchPreference(width))

  const flushPending = (): number => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    const next = Math.min(maxWidth, clampWorkbenchPreference(pendingWidthRef.current))
    onResize(next)
    return next
  }

  const finishDrag = (pointerId: number): number | null => {
    const next = finalizedWorkbenchDragWidth(
      dragStartRef.current,
      pointerId,
      pendingWidthRef.current,
      maxWidth,
    )
    if (next === null) return null
    // Clear ownership before releasePointerCapture can synchronously dispatch
    // lostpointercapture; the trailing event must not commit a second time.
    dragStartRef.current = null
    pendingWidthRef.current = next
    flushPending()
    onCommit(next)
    return next
  }

  return (
    <div
      className="workbench-resize-handle"
      role="separator"
      aria-label="调整会话工作台宽度"
      aria-controls="qa-conversation-workbench"
      aria-orientation="vertical"
      aria-valuemin={WORKBENCH_MIN_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={value}
      aria-valuetext={`会话工作台宽度 ${value} 像素`}
      tabIndex={0}
      title="拖动调整宽度；方向键微调；双击复位"
      onDoubleClick={() => {
        const next = Math.min(maxWidth, WORKBENCH_DEFAULT_WIDTH)
        onResize(next)
        onCommit(next)
      }}
      onKeyDown={(event) => {
        const next = workbenchWidthForKey(value, event.key, maxWidth)
        if (next === null) return
        event.preventDefault()
        onResize(next)
        onCommit(next)
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        dragStartRef.current = { pointerId: event.pointerId, clientX: event.clientX, width: value }
        pendingWidthRef.current = value
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const start = dragStartRef.current
        if (start === null || start.pointerId !== event.pointerId) return
        pendingWidthRef.current = Math.min(
          maxWidth,
          clampWorkbenchPreference(start.width + start.clientX - event.clientX),
        )
        if (frameRef.current !== null) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          onResize(pendingWidthRef.current)
        })
      }}
      onPointerUp={(event) => {
        if (finishDrag(event.pointerId) === null) return
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={(event) => {
        if (finishDrag(event.pointerId) === null) return
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onLostPointerCapture={(event) => { finishDrag(event.pointerId) }}
    >
      <GripVertical aria-hidden="true" />
      <span className="sr-only">使用左右方向键调整，Home 最小，End 最大，双击恢复默认宽度。</span>
    </div>
  )
}
