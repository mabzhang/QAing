import type {
  AnswerOrigin,
  AppMode,
  AppState,
  AudioSourceKind,
  ConversationTurn,
  ErrorOperation,
  RetrievalRoute,
  SourceReference,
  TranscriptUpdate,
} from './types'

export type AppEvent =
  | { readonly type: 'SELECT_AUDIO_SOURCE'; readonly source: AudioSourceKind }
  | { readonly type: 'SWITCH_MODE'; readonly mode: AppMode }
  | { readonly type: 'START_SESSION'; readonly sessionId: string }
  | { readonly type: 'ROUND_OPENED'; readonly sessionId: string; readonly roundId: string }
  | { readonly type: 'TRANSCRIPT'; readonly update: TranscriptUpdate }
  | {
      readonly type: 'CANDIDATE_STARTED'
      readonly sessionId: string
      readonly generationId: number
      readonly revision: number
      readonly questionIdentity: string
    }
  | {
      readonly type: 'CANDIDATE_PUBLISHED'
      readonly sessionId: string
      readonly generationId: number
      readonly revision: number
      readonly questionIdentity: string
      readonly answer: string
      readonly sources: readonly SourceReference[]
      readonly retrievalRoute: RetrievalRoute
    }
  | { readonly type: 'CANDIDATE_FAILED'; readonly sessionId: string; readonly generationId: number }
  | { readonly type: 'QUESTION_ENDING'; readonly generationId: number }
  | {
      readonly type: 'QUESTION_SEALED'
      readonly sessionId: string
      readonly generationId: number
      readonly revision: number
      readonly questionIdentity: string
    }
  | {
      readonly type: 'FINAL_ANSWER_PUBLISHED'
      readonly sessionId: string
      readonly generationId: number
      readonly revision: number
      readonly questionIdentity: string
      readonly answer: string
      readonly sources: readonly SourceReference[]
      readonly answerOrigin: AnswerOrigin
      readonly retrievalRoute: RetrievalRoute
    }
  | { readonly type: 'ANSWER_ENDED' }
  | { readonly type: 'ROUND_COMMITTED'; readonly turn: ConversationTurn }
  | { readonly type: 'FRONT_STOPPED' }
  | { readonly type: 'FRONT_STRUCTURED' }
  | { readonly type: 'FRONT_INDEXED' }
  | { readonly type: 'FRONT_COMPLETE_ACKNOWLEDGED' }
  | { readonly type: 'STOP_SESSION' }
  | { readonly type: 'RETRY_FINAL'; readonly generationId: number }
  | { readonly type: 'RETRY_FRONT' }
  | { readonly type: 'RETRY_COMMIT' }
  | { readonly type: 'SKIP_QUESTION' }
  | { readonly type: 'FAIL'; readonly operation: ErrorOperation; readonly message: string }
  | { readonly type: 'RESET_ERROR' }

export const initialAppState: AppState = {
  mode: 'qa',
  audioSource: 'system',
  qaPhase: 'idle',
  frontPhase: 'idle',
  sessionId: null,
  activeRoundId: null,
  revision: 0,
  lastTranscriptSequence: 0,
  generationId: 0,
  finalSegments: [],
  partialSegment: '',
  candidateAnswer: '',
  candidateRevision: null,
  candidateQuestion: '',
  candidateSources: [],
  candidateRetrievalRoute: null,
  candidateUpdating: false,
  lockedAnswer: '',
  lockedQuestionRevision: null,
  lockedQuestionIdentity: '',
  answerOrigin: null,
  lockedRetrievalRoute: null,
  sources: [],
  history: [],
  error: null,
  errorOperation: null,
}

export function questionText(state: AppState): string {
  return [...state.finalSegments, state.partialSegment].filter(Boolean).join('')
}

export function normalizeQuestionIdentity(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

function clearRound(state: AppState): AppState {
  return {
    ...state,
    activeRoundId: null,
    revision: 0,
    lastTranscriptSequence: 0,
    finalSegments: [],
    partialSegment: '',
    candidateAnswer: '',
    candidateRevision: null,
    candidateQuestion: '',
    candidateSources: [],
    candidateRetrievalRoute: null,
    candidateUpdating: false,
    lockedAnswer: '',
    lockedQuestionRevision: null,
    lockedQuestionIdentity: '',
    answerOrigin: null,
    lockedRetrievalRoute: null,
    sources: [],
    error: null,
    errorOperation: null,
  }
}

export function appReducer(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case 'SELECT_AUDIO_SOURCE':
      if (state.qaPhase !== 'idle' || state.frontPhase !== 'idle') return state
      return { ...state, audioSource: event.source }
    case 'SWITCH_MODE':
      if (state.qaPhase !== 'idle' || state.frontPhase !== 'idle') return state
      return { ...clearRound(state), mode: event.mode }
    case 'START_SESSION':
      if (state.mode === 'qa' && state.qaPhase === 'idle') {
        return { ...clearRound(state), sessionId: event.sessionId, qaPhase: 'listening' }
      }
      if (state.mode === 'front' && state.frontPhase === 'idle') {
        return { ...clearRound(state), sessionId: event.sessionId, frontPhase: 'recording' }
      }
      return state
    case 'ROUND_OPENED':
      if (
        state.mode !== 'qa' ||
        state.qaPhase !== 'listening' ||
        event.sessionId !== state.sessionId ||
        state.activeRoundId !== null ||
        !event.roundId
      ) return state
      return { ...state, activeRoundId: event.roundId }
    case 'TRANSCRIPT': {
      if (event.update.sessionId !== state.sessionId) return state
      if (event.update.sequence <= state.lastTranscriptSequence) return state
      const acceptsQa = state.mode === 'qa' && (
        state.qaPhase === 'listening' ||
        (
          state.qaPhase === 'finalizing' &&
          state.lockedQuestionRevision === null &&
          event.update.kind === 'final'
        )
      )
      const acceptsFront = state.mode === 'front' && (
        state.frontPhase === 'recording' ||
        (state.frontPhase === 'structuring' && event.update.kind === 'final')
      )
      if (!acceptsQa && !acceptsFront) return state
      if (event.update.kind === 'partial') {
        return {
          ...state,
          partialSegment: event.update.text,
          revision: state.revision + 1,
          lastTranscriptSequence: event.update.sequence,
        }
      }
      if (!event.update.text) return { ...state, lastTranscriptSequence: event.update.sequence }
      return {
        ...state,
        finalSegments: [...state.finalSegments, event.update.text],
        partialSegment: '',
        revision: state.revision + 1,
        lastTranscriptSequence: event.update.sequence,
      }
    }
    case 'CANDIDATE_STARTED':
      if (
        state.mode !== 'qa' ||
        state.qaPhase !== 'listening' ||
        event.sessionId !== state.sessionId ||
        event.generationId <= state.generationId ||
        event.revision !== state.revision ||
        event.questionIdentity !== normalizeQuestionIdentity(questionText(state))
      ) return state
      return { ...state, generationId: event.generationId, candidateUpdating: true }
    case 'CANDIDATE_PUBLISHED':
      if (
        state.mode !== 'qa' ||
        state.qaPhase !== 'listening' ||
        event.sessionId !== state.sessionId ||
        event.generationId !== state.generationId ||
        event.revision !== state.revision ||
        event.questionIdentity !== normalizeQuestionIdentity(questionText(state)) ||
        !event.answer.trim()
      ) return state
      return {
        ...state,
        candidateAnswer: event.answer,
        candidateRevision: event.revision,
        candidateQuestion: event.questionIdentity,
        candidateSources: event.sources,
        candidateRetrievalRoute: event.retrievalRoute,
        candidateUpdating: false,
      }
    case 'CANDIDATE_FAILED':
      if (
        state.mode !== 'qa' ||
        state.qaPhase !== 'listening' ||
        event.sessionId !== state.sessionId ||
        event.generationId !== state.generationId
      ) return state
      return { ...state, candidateUpdating: false }
    case 'QUESTION_ENDING':
      if (state.mode !== 'qa' || state.qaPhase !== 'listening' || !questionText(state).trim()) return state
      return {
        ...state,
        qaPhase: 'finalizing',
        generationId: event.generationId,
        candidateUpdating: false,
        lockedAnswer: '',
        lockedQuestionRevision: null,
        lockedQuestionIdentity: '',
        answerOrigin: null,
        lockedRetrievalRoute: null,
        sources: [],
        error: null,
        errorOperation: null,
        partialSegment: state.partialSegment,
      }
    case 'QUESTION_SEALED':
      if (
        state.qaPhase !== 'finalizing' ||
        event.sessionId !== state.sessionId ||
        event.generationId !== state.generationId ||
        event.revision !== state.revision ||
        event.questionIdentity !== normalizeQuestionIdentity(questionText(state)) ||
        !event.questionIdentity
      ) return state
      return {
        ...state,
        lockedQuestionRevision: event.revision,
        lockedQuestionIdentity: event.questionIdentity,
      }
    case 'FINAL_ANSWER_PUBLISHED':
      if (
        state.qaPhase !== 'finalizing' ||
        event.sessionId !== state.sessionId ||
        event.generationId !== state.generationId ||
        event.revision !== state.lockedQuestionRevision ||
        event.questionIdentity !== state.lockedQuestionIdentity ||
        !event.answer.trim()
      ) return state
      return {
        ...state,
        qaPhase: 'answer_locked',
        lockedAnswer: event.answer,
        sources: event.sources,
        answerOrigin: event.answerOrigin,
        lockedRetrievalRoute: event.retrievalRoute,
        error: null,
        errorOperation: null,
      }
    case 'ANSWER_ENDED':
      if (state.qaPhase !== 'answer_locked') return state
      return { ...state, qaPhase: 'committing' }
    case 'ROUND_COMMITTED':
      if (state.qaPhase !== 'committing') return state
      return {
        ...clearRound(state),
        qaPhase: 'listening',
        sessionId: state.sessionId,
        generationId: state.generationId,
        history: [...state.history, event.turn].slice(-5),
      }
    case 'FRONT_STOPPED':
      if (state.mode !== 'front' || state.frontPhase !== 'recording' || !questionText(state).trim()) return state
      return { ...state, frontPhase: 'structuring' }
    case 'FRONT_STRUCTURED':
      if (state.frontPhase !== 'structuring') return state
      return { ...state, frontPhase: 'indexing' }
    case 'FRONT_INDEXED':
      if (state.frontPhase !== 'indexing') return state
      return { ...state, frontPhase: 'complete' }
    case 'FRONT_COMPLETE_ACKNOWLEDGED':
      if (state.frontPhase !== 'complete') return state
      return { ...clearRound(state), frontPhase: 'idle', sessionId: null }
    case 'STOP_SESSION':
      if (
        state.qaPhase === 'finalizing' ||
        state.qaPhase === 'committing' ||
        state.frontPhase === 'structuring' ||
        state.frontPhase === 'indexing'
      ) return state
      return { ...clearRound(state), qaPhase: 'idle', frontPhase: 'idle', sessionId: null }
    case 'RETRY_FINAL':
      if (
        state.mode !== 'qa' ||
        state.qaPhase !== 'error' ||
        state.errorOperation !== 'final' ||
        state.lockedQuestionRevision === null ||
        !state.lockedQuestionIdentity
      ) return state
      return {
        ...state,
        qaPhase: 'finalizing',
        generationId: event.generationId,
        lockedAnswer: '',
        answerOrigin: null,
        sources: [],
        error: null,
        errorOperation: null,
      }
    case 'RETRY_FRONT':
      if (
        state.mode !== 'front' ||
        state.frontPhase !== 'error' ||
        state.errorOperation !== 'front' ||
        !questionText(state).trim()
      ) return state
      return { ...state, frontPhase: 'structuring', error: null, errorOperation: null }
    case 'RETRY_COMMIT':
      if (
        state.mode !== 'qa' ||
        state.qaPhase !== 'error' ||
        state.errorOperation !== 'commit' ||
        !state.lockedAnswer.trim()
      ) return state
      return { ...state, qaPhase: 'committing', error: null, errorOperation: null }
    case 'SKIP_QUESTION':
      if (state.mode !== 'qa' || state.qaPhase !== 'error' || state.errorOperation !== 'final') return state
      return {
        ...clearRound(state),
        qaPhase: 'listening',
        sessionId: state.sessionId,
        generationId: state.generationId,
        history: state.history,
      }
    case 'FAIL':
      return {
        ...state,
        qaPhase: state.mode === 'qa' ? 'error' : state.qaPhase,
        frontPhase: state.mode === 'front' ? 'error' : state.frontPhase,
        candidateUpdating: false,
        error: event.message,
        errorOperation: event.operation,
      }
    case 'RESET_ERROR':
      return {
        ...clearRound(state),
        sessionId: null,
        qaPhase: 'idle',
        frontPhase: 'idle',
      }
  }
}
