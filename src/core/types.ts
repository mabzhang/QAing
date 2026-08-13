export type AppMode = 'front' | 'qa'
export type AudioSourceKind = 'microphone' | 'system'

export type QaPhase =
  | 'idle'
  | 'listening'
  | 'finalizing'
  | 'answer_locked'
  | 'committing'
  | 'error'

export type FrontPhase =
  | 'idle'
  | 'recording'
  | 'structuring'
  | 'indexing'
  | 'complete'
  | 'error'

export interface SourceReference {
  readonly id: string
  readonly documentId: string
  readonly title: string
  readonly kind: 'preset_qa' | 'source_document'
  readonly excerpt: string
  readonly score: number
}

export interface ConversationTurn {
  readonly id: string
  readonly question: string
  readonly answer: string
  readonly sourceIds: readonly string[]
  readonly answerOrigin: AnswerOrigin
  readonly createdAt: number
}

export type AnswerOrigin = 'final' | 'candidate_fallback' | 'legacy_committed'
export type RetrievalRoute = 'preset_qa_exact' | 'preset_qa_semantic' | 'source_document' | 'legacy_unknown'
export type AnswerVersionStage = 'candidate' | 'final' | 'candidate_fallback' | 'legacy_committed'
export type QaRoundStatus =
  | 'active'
  | 'answer_locked'
  | 'completed'
  | 'skipped'
  | 'cancelled'
  | 'interrupted'
  | 'failed'

export interface QaAnswerVersion {
  readonly id: string
  readonly roundId: string
  readonly ordinal: number
  readonly stage: AnswerVersionStage
  readonly questionRevision: number
  readonly questionSnapshot: string
  readonly questionIdentity: string
  readonly answer: string
  readonly retrievalRoute: RetrievalRoute
  readonly sources: readonly SourceReference[]
  readonly elapsedMs: number
  readonly createdAt: number
  readonly isSelected: boolean
  readonly isSuperseded: boolean
  readonly answerUnchanged: boolean
}

export interface QaWorkspaceRound {
  readonly id: string
  readonly sessionId: string
  readonly ordinal: number
  readonly status: QaRoundStatus
  readonly questionPreview: string
  readonly startedAt: number
  readonly completedAt: number | null
  readonly selectedAnswerVersionId: string | null
  readonly versions: readonly QaAnswerVersion[]
}

export interface QaWorkspacePage {
  /** Null is reserved for the explicitly isolated legacy workspace. */
  readonly projectId: string | null
  /** Exact count for this project and dataRevision, used by destructive confirmations. */
  readonly totalRounds: number
  readonly items: readonly QaWorkspaceRound[]
  readonly nextCursor: string | null
  readonly dataRevision: number
}

export interface QaWorkspaceChanged {
  readonly projectId: string
  readonly dataRevision: number
  /** null denotes a project-wide mutation such as clearing its workspace. */
  readonly roundId: string | null
  readonly answerVersionId: string | null
}

export type ErrorOperation = 'start' | 'final' | 'front' | 'commit'

export interface AppState {
  readonly mode: AppMode
  readonly audioSource: AudioSourceKind
  readonly qaPhase: QaPhase
  readonly frontPhase: FrontPhase
  readonly sessionId: string | null
  readonly activeRoundId: string | null
  readonly revision: number
  readonly lastTranscriptSequence: number
  readonly generationId: number
  readonly finalSegments: readonly string[]
  readonly partialSegment: string
  readonly candidateAnswer: string
  readonly candidateRevision: number | null
  readonly candidateQuestion: string
  readonly candidateSources: readonly SourceReference[]
  readonly candidateRetrievalRoute: RetrievalRoute | null
  readonly candidateUpdating: boolean
  readonly lockedAnswer: string
  readonly lockedQuestionRevision: number | null
  readonly lockedQuestionIdentity: string
  readonly answerOrigin: AnswerOrigin | null
  readonly lockedRetrievalRoute: RetrievalRoute | null
  readonly sources: readonly SourceReference[]
  readonly history: readonly ConversationTurn[]
  readonly error: string | null
  readonly errorOperation: ErrorOperation | null
}

export interface TranscriptUpdate {
  readonly sessionId: string
  readonly kind: 'partial' | 'final'
  readonly text: string
  readonly sequence: number
}

export interface RetrievalResult {
  readonly query: string
  readonly references: readonly SourceReference[]
  readonly mode: 'hybrid' | 'keyword_fallback'
}
