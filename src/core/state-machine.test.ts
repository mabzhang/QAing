import { describe, expect, it } from 'vitest'
import { appReducer, initialAppState, normalizeQuestionIdentity, questionText } from './state-machine'

function lockFinal(state: ReturnType<typeof appReducer>, generationId: number, answer = '确定答案') {
  const revision = state.revision
  const questionIdentity = normalizeQuestionIdentity(questionText(state))
  const sessionId = state.sessionId ?? ''
  state = appReducer(state, { type: 'QUESTION_ENDING', generationId })
  state = appReducer(state, { type: 'QUESTION_SEALED', sessionId, generationId, revision, questionIdentity })
  return appReducer(state, {
    type: 'FINAL_ANSWER_PUBLISHED',
    sessionId,
    generationId,
    revision,
    questionIdentity,
    answer,
    sources: [],
    answerOrigin: 'final',
    retrievalRoute: 'source_document',
  })
}

describe('appReducer', () => {
  it('opens exactly one active workspace round and clears it only at a round boundary', () => {
    let state = appReducer(initialAppState, { type: 'START_SESSION', sessionId: 's1' })
    state = appReducer(state, { type: 'ROUND_OPENED', sessionId: 's1', roundId: 'round-1' })
    expect(state.activeRoundId).toBe('round-1')
    expect(appReducer(state, { type: 'ROUND_OPENED', sessionId: 's1', roundId: 'round-2' })).toBe(state)

    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 's1', kind: 'final', text: '问题是什么？', sequence: 1 } })
    state = lockFinal(state, 1)
    state = appReducer(state, { type: 'ANSWER_ENDED' })
    state = appReducer(state, {
      type: 'ROUND_COMMITTED',
      turn: { id: 'turn-1', question: '问题是什么？', answer: '答案', sourceIds: [], answerOrigin: 'final', createdAt: 1 },
    })
    expect(state.activeRoundId).toBeNull()
    expect(state.sessionId).toBe('s1')
  })

  it('runs a QA round and keeps only five committed turns', () => {
    let state = appReducer(initialAppState, { type: 'START_SESSION', sessionId: 's1' })
    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 's1', kind: 'partial', text: '请问收入', sequence: 1 } })
    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 's1', kind: 'final', text: '请问收入是多少？', sequence: 2 } })
    expect(questionText(state)).toBe('请问收入是多少？')
    state = lockFinal(state, 1, '收入为一亿元。')
    expect(state.qaPhase).toBe('answer_locked')
    expect(state.lockedAnswer).toBe('收入为一亿元。')
    for (let index = 0; index < 6; index += 1) {
      if (index > 0) {
        state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 's1', kind: 'final', text: `问题${index}`, sequence: index + 2 } })
        state = lockFinal(state, index + 1)
      }
      state = appReducer(state, { type: 'ANSWER_ENDED' })
      state = appReducer(state, {
        type: 'ROUND_COMMITTED',
        turn: { id: String(index), question: 'q', answer: 'a', sourceIds: [], answerOrigin: 'final', createdAt: index },
      })
    }
    expect(state.history).toHaveLength(5)
    expect(state.history[0]?.id).toBe('1')
  })

  it('rejects stale transcripts and stale generation chunks', () => {
    let state = appReducer(initialAppState, { type: 'START_SESSION', sessionId: 'current' })
    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 'old', kind: 'final', text: '污染', sequence: 1 } })
    expect(questionText(state)).toBe('')
    state = appReducer(state, { type: 'CANDIDATE_STARTED', sessionId: 'current', generationId: 4, revision: 0, questionIdentity: '' })
    state = appReducer(state, {
      type: 'CANDIDATE_PUBLISHED',
      sessionId: 'current',
      generationId: 3,
      revision: 0,
      questionIdentity: '',
      answer: '旧答案',
      sources: [],
      retrievalRoute: 'source_document',
    })
    expect(state.candidateAnswer).toBe('')
  })

  it('does not switch mode during an active session', () => {
    const listening = appReducer(initialAppState, { type: 'START_SESSION', sessionId: 's1' })
    expect(appReducer(listening, { type: 'SWITCH_MODE', mode: 'front' })).toBe(listening)
  })

  it('runs the explicit front-mode stop and indexing flow', () => {
    let state = appReducer(initialAppState, { type: 'SWITCH_MODE', mode: 'front' })
    state = appReducer(state, { type: 'START_SESSION', sessionId: 'front-1' })
    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 'front-1', kind: 'final', text: '演讲内容', sequence: 1 } })
    state = appReducer(state, { type: 'FRONT_STOPPED' })
    expect(state.frontPhase).toBe('structuring')
    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 'front-1', kind: 'final', text: '最后一句', sequence: 2 } })
    expect(questionText(state)).toBe('演讲内容最后一句')
    state = appReducer(state, { type: 'FRONT_STRUCTURED' })
    state = appReducer(state, { type: 'FRONT_INDEXED' })
    expect(state.frontPhase).toBe('complete')
    state = appReducer(state, { type: 'FRONT_COMPLETE_ACKNOWLEDGED' })
    expect(state.frontPhase).toBe('idle')
    expect(appReducer(state, { type: 'SWITCH_MODE', mode: 'qa' }).mode).toBe('qa')
  })

  it('rejects duplicate and out-of-order transcript frames', () => {
    let state = appReducer(initialAppState, { type: 'START_SESSION', sessionId: 's1' })
    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 's1', kind: 'partial', text: '新文本', sequence: 2 } })
    const accepted = state
    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 's1', kind: 'partial', text: '旧文本', sequence: 1 } })
    expect(state).toBe(accepted)
  })

  it('retains locked question content when final generation fails and retries', () => {
    let state = appReducer(initialAppState, { type: 'START_SESSION', sessionId: 's1' })
    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 's1', kind: 'final', text: '需要保留的问题', sequence: 1 } })
    const revision = state.revision
    const identity = normalizeQuestionIdentity(questionText(state))
    state = appReducer(state, { type: 'QUESTION_ENDING', generationId: 1 })
    state = appReducer(state, { type: 'QUESTION_SEALED', sessionId: 's1', generationId: 1, revision, questionIdentity: identity })
    state = appReducer(state, { type: 'FAIL', operation: 'final', message: '网络超时' })
    expect(questionText(state)).toBe('需要保留的问题')
    state = appReducer(state, { type: 'RETRY_FINAL', generationId: 2 })
    expect(state.qaPhase).toBe('finalizing')
    expect(state.error).toBeNull()
    expect(questionText(state)).toBe('需要保留的问题')
  })

  it('publishes a candidate atomically and rejects old revision results without clearing the stable answer', () => {
    let state = appReducer(initialAppState, { type: 'START_SESSION', sessionId: 's1' })
    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 's1', kind: 'partial', text: '2023年营收是多少', sequence: 1 } })
    state = appReducer(state, { type: 'CANDIDATE_STARTED', sessionId: 's1', generationId: 1, revision: 1, questionIdentity: '2023年营收是多少' })
    state = appReducer(state, {
      type: 'CANDIDATE_PUBLISHED',
      sessionId: 's1',
      generationId: 1,
      revision: 1,
      questionIdentity: '2023年营收是多少',
      answer: '旧问题的稳定候选',
      sources: [],
      retrievalRoute: 'source_document',
    })
    expect(state.candidateAnswer).toBe('旧问题的稳定候选')

    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 's1', kind: 'partial', text: '不是营收，是2024年净利润', sequence: 2 } })
    state = appReducer(state, {
      type: 'CANDIDATE_STARTED',
      sessionId: 's1',
      generationId: 2,
      revision: 2,
      questionIdentity: normalizeQuestionIdentity('不是营收，是2024年净利润'),
    })
    expect(state.candidateAnswer).toBe('旧问题的稳定候选')
    expect(state.candidateUpdating).toBe(true)
    const stale = appReducer(state, {
      type: 'CANDIDATE_PUBLISHED',
      sessionId: 's1',
      generationId: 2,
      revision: 1,
      questionIdentity: '2023年营收是多少',
      answer: '不应发布',
      sources: [],
      retrievalRoute: 'source_document',
    })
    expect(stale).toBe(state)
    expect(stale.candidateAnswer).toBe('旧问题的稳定候选')
    const stopped = appReducer(state, { type: 'CANDIDATE_FAILED', sessionId: 's1', generationId: 2 })
    expect(stopped.candidateUpdating).toBe(false)
    expect(stopped.candidateAnswer).toBe('旧问题的稳定候选')
  })

  it('only accepts a final publication matching the sealed revision and normalized identity', () => {
    let state = appReducer(initialAppState, { type: 'START_SESSION', sessionId: 's1' })
    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 's1', kind: 'final', text: '  净利润\t是多少  ', sequence: 1 } })
    const revision = state.revision
    state = appReducer(state, { type: 'QUESTION_ENDING', generationId: 4 })
    state = appReducer(state, {
      type: 'QUESTION_SEALED',
      sessionId: 's1',
      generationId: 4,
      revision,
      questionIdentity: '净利润 是多少',
    })
    const beforePublish = state
    state = appReducer(state, {
      type: 'FINAL_ANSWER_PUBLISHED',
      sessionId: 's1',
      generationId: 4,
      revision: revision - 1,
      questionIdentity: '净利润 是多少',
      answer: '错误答案',
      sources: [],
      answerOrigin: 'final',
      retrievalRoute: 'source_document',
    })
    expect(state).toBe(beforePublish)
    state = appReducer(state, {
      type: 'FINAL_ANSWER_PUBLISHED',
      sessionId: 's1',
      generationId: 4,
      revision,
      questionIdentity: '净利润 是多少',
      answer: '正确答案',
      sources: [],
      answerOrigin: 'candidate_fallback',
      retrievalRoute: 'source_document',
    })
    expect(state.qaPhase).toBe('answer_locked')
    expect(state.answerOrigin).toBe('candidate_fallback')
  })

  it('skips a failed final round without committing history and preserves the session', () => {
    let state = appReducer(initialAppState, { type: 'START_SESSION', sessionId: 's1' })
    state = appReducer(state, { type: 'TRANSCRIPT', update: { sessionId: 's1', kind: 'final', text: '跳过的问题', sequence: 1 } })
    const revision = state.revision
    const questionIdentity = normalizeQuestionIdentity(questionText(state))
    state = appReducer(state, { type: 'QUESTION_ENDING', generationId: 1 })
    state = appReducer(state, { type: 'QUESTION_SEALED', sessionId: 's1', generationId: 1, revision, questionIdentity })
    state = appReducer(state, { type: 'FAIL', operation: 'final', message: '失败' })
    state = appReducer(state, { type: 'SKIP_QUESTION' })
    expect(state.qaPhase).toBe('listening')
    expect(state.sessionId).toBe('s1')
    expect(state.history).toEqual([])
    expect(questionText(state)).toBe('')
  })
})
