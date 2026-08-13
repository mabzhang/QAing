import { CheckCircle2, Copy, MessageSquareText, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ConversationTurn } from '../../core/types'
import type { UiActionName } from './contracts'
import { DrawerShell } from './DrawerShell'

interface HistoryDrawerProps {
  readonly history: readonly ConversationTurn[]
  readonly initialTurnId: string | null
  readonly pendingAction: UiActionName | null
  readonly actionError: string | null
  readonly onClose: () => void
  readonly onCopyAnswer: (answer: string) => void
}

function fullTimeLabel(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '时间未知'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function HistoryDrawer({
  history,
  initialTurnId,
  pendingAction,
  actionError,
  onClose,
  onCopyAnswer,
}: HistoryDrawerProps): React.JSX.Element {
  const orderedHistory = useMemo(() => [...history].reverse(), [history])
  const initialSelection = initialTurnId !== null && history.some((turn) => turn.id === initialTurnId)
    ? initialTurnId
    : orderedHistory[0]?.id ?? null
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(initialSelection)
  const selectedTurn = history.find((turn) => turn.id === selectedTurnId) ?? orderedHistory[0] ?? null
  const busy = pendingAction !== null

  return (
    <DrawerShell
      title="最近上下文"
      description="查看已完成问答的完整问题、答案与来源摘要。"
      icon={MessageSquareText}
      busy={busy}
      actionError={actionError}
      onClose={onClose}
    >
      {selectedTurn === null ? (
        <div className="history-drawer-empty">
          <MessageSquareText aria-hidden="true" />
          <strong>还没有已完成问答</strong>
          <span>只有点击「回答结束」并成功保存的轮次才会出现在这里。</span>
        </div>
      ) : (
        <div className="history-drawer-layout">
          <nav className="history-drawer-list" aria-label="最近问答轮次">
            {orderedHistory.map((turn, index) => {
              const selected = turn.id === selectedTurn.id
              return (
                <button
                  type="button"
                  key={turn.id}
                  className={selected ? 'is-selected' : undefined}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => { setSelectedTurnId(turn.id) }}
                >
                  <span>{history.length - index}</span>
                  <div>
                    <strong>{turn.question}</strong>
                    <small>{fullTimeLabel(turn.createdAt)} · {turn.sourceIds.length} 条来源</small>
                  </div>
                </button>
              )
            })}
          </nav>

          <article className="history-detail" aria-live="polite">
            <header>
              <div>
                <span className={`history-origin history-origin--${selectedTurn.answerOrigin}`}>
                  {selectedTurn.answerOrigin === 'candidate_fallback' ? '候选降级答案' : '最终核验答案'}
                </span>
                <span>{fullTimeLabel(selectedTurn.createdAt)}</span>
              </div>
              <button
                type="button"
                onClick={() => { onCopyAnswer(selectedTurn.answer) }}
                disabled={busy || selectedTurn.answer.trim().length === 0}
              >
                <Copy aria-hidden="true" />
                复制答案
              </button>
            </header>
            <section aria-labelledby="history-question-title">
              <h3 id="history-question-title">完整问题</h3>
              <p>{selectedTurn.question}</p>
            </section>
            <section aria-labelledby="history-answer-title">
              <h3 id="history-answer-title">完整答案</h3>
              <p>{selectedTurn.answer || '本轮未生成可用答案。'}</p>
            </section>
            <footer>
              <span><ShieldCheck aria-hidden="true" />{selectedTurn.sourceIds.length} 条已保存来源</span>
              <span><CheckCircle2 aria-hidden="true" />已写入最近上下文</span>
            </footer>
          </article>
        </div>
      )}
    </DrawerShell>
  )
}
