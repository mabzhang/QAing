import { createHash, randomUUID } from 'node:crypto'
import {
  appReducer,
  initialAppState,
  normalizeQuestionIdentity,
  questionText,
  type AppEvent,
} from '../../core/state-machine'
import {
  CandidateTaskCoordinator,
  isMaterialQuestionChange,
  protectedQuestionFacetIdentity,
  stableCheckpointQuestionIdentity,
  type RevisionedQuery,
} from '../../core/task-coordinator'
import type { AppCommand } from '../../core/contracts'
import type {
  AppState,
  AnswerVersionStage,
  AudioSourceKind,
  ConversationTurn,
  ErrorOperation,
  RetrievalRoute,
  SourceReference,
  TranscriptUpdate,
} from '../../core/types'
import type { SecureLogger } from '../security/secure-logger'

export interface AudioRuntime {
  /**
   * Completes the local permission preflight before any cloud ASR session is
   * opened. A denied permission must therefore have zero network side effects.
   */
  prepare(source: AudioSourceKind): Promise<void>
  start(input: {
    readonly sessionId: string
    readonly source: AudioSourceKind
    readonly onPcmFrame: (frame: Uint8Array) => Promise<void>
    readonly onFailure: (code: string, retryable: boolean) => void
  }): Promise<void>
  stop(): Promise<void>
  abort(): void
}

export interface AsrRuntime {
  start(input: {
    readonly sessionId: string
    readonly mode: AppState['mode']
    readonly onTranscript: (update: TranscriptUpdate) => void
    readonly onFailure: (code: string, retryable: boolean) => void
  }): Promise<void>
  sendPcmFrame(frame: Uint8Array): Promise<void>
  stopAndFinalize(): Promise<void>
  abort(): void
}

export interface RagRuntime {
  streamAnswer(input: {
    readonly projectId: string
    readonly sessionId: string
    readonly generationId: number
    readonly query: string
    readonly kind: 'candidate' | 'final'
    readonly signal: AbortSignal
    readonly onToken: (token: string) => void
  }): Promise<{
    readonly references: readonly SourceReference[]
    readonly retrievalRoute: RetrievalRoute
    readonly refused: boolean
  }>
  structureTranscript(input: {
    readonly sessionId: string
    readonly transcript: string
    readonly signal: AbortSignal
  }): Promise<string>
}

export interface ApplicationRepository {
  beginSession(input: {
    readonly sessionId: string
    readonly mode: AppState['mode']
    readonly audioSource: AudioSourceKind
  }): Promise<{ readonly projectId: string | null }>
  endSession(sessionId: string, status: 'complete' | 'cancelled' | 'failed' | 'interrupted'): Promise<void>
  saveTurn(input: { readonly sessionId: string; readonly turn: ConversationTurn }): Promise<void>
  ensureQaRound(input: {
    readonly projectId: string
    readonly sessionId: string
    readonly roundId: string
    readonly question: string
    readonly startedAt: number
  }): Promise<{ readonly dataRevision: number }>
  saveQaAnswerVersion(input: {
    readonly projectId: string
    readonly operationId: string
    readonly roundId: string
    readonly sessionId: string
    readonly stage: AnswerVersionStage
    readonly questionRevision: number
    readonly questionSnapshot: string
    readonly questionIdentity: string
    readonly answer: string
    readonly retrievalRoute: RetrievalRoute
    readonly sources: readonly SourceReference[]
    readonly elapsedMs: number
    readonly createdAt: number
  }): Promise<{
    readonly versionId: string
    readonly inserted: boolean
    readonly dataRevision: number
  }>
  commitQaRound(input: {
    readonly projectId: string
    readonly roundId: string
    readonly selectedAnswerVersionId: string
    readonly sessionId: string
    readonly turn: ConversationTurn
  }): Promise<{ readonly dataRevision: number }>
  closeQaRound(input: {
    readonly projectId: string
    readonly roundId: string
    readonly status: 'skipped' | 'cancelled' | 'interrupted' | 'failed'
  }): Promise<{ readonly dataRevision: number }>
  persistFrontSnapshot(input: {
    readonly sessionId: string
    readonly transcript: string
  }): Promise<void>
  persistFrontTranscript(input: {
    readonly sessionId: string
    readonly transcript: string
  }): Promise<{ readonly documentId: string }>
  indexStructuredFront(input: {
    readonly projectId: string
    readonly documentId: string
    readonly markdown: string
  }): Promise<void>
}

export interface ApplicationControllerPorts {
  readonly audio: AudioRuntime
  readonly asr: AsrRuntime
  readonly rag: RagRuntime
  readonly repository: ApplicationRepository
  readonly logger: SecureLogger
}

type StateListener = (state: AppState) => void
export type ControllerCommand = AppCommand | { readonly type: 'skip_question' }
type CandidateResult = {
  readonly answer: string
  readonly references: readonly SourceReference[]
  readonly retrievalRoute: RetrievalRoute
  readonly versionId: string
}
type SaveAnswerVersionInput = {
  readonly operationIdInput: Parameters<typeof answerVersionOperationId>[0]
  readonly roundId: string
  readonly projectId: string
  readonly sessionId: string
  readonly stage: AnswerVersionStage
  readonly questionRevision: number
  readonly questionSnapshot: string
  readonly questionIdentity: string
  readonly answer: string
  readonly retrievalRoute: RetrievalRoute
  readonly sources: readonly SourceReference[]
  readonly startedAt: number
}
const CAPTURE_HEALTHY_RESET_MS = 30_000

class CaptureStartCancelledError extends Error {
  constructor() {
    super('CAPTURE_START_CANCELLED')
    this.name = 'CaptureStartCancelledError'
  }
}

function publicFailureMessage(operation: ErrorOperation): string {
  switch (operation) {
    case 'start': return '无法开始监听。请先选择项目，并检查凭据、权限、网络和当前音源。'
    case 'final': return '确定答案生成失败，问题和检索上下文已保留，可重试。'
    case 'front': return '资料处理失败，原始转写已保留，可继续处理。'
    case 'commit': return '本轮保存失败，问题、答案和来源已保留，可重试。'
  }
}

export class ApplicationController {
  readonly #ports: ApplicationControllerPorts
  readonly #listeners = new Set<StateListener>()
  readonly #candidateTasks: CandidateTaskCoordinator<CandidateResult>
  #state: AppState = initialAppState
  #sessionProjectId: string | null = null
  #generationSequence = 0
  #finalController: AbortController | null = null
  #frontController: AbortController | null = null
  #pendingTurn: ConversationTurn | null = null
  #pendingAnswerVersionId: string | null = null
  #lockedAnswerVersionId: string | null = null
  #roundStartedAt: number | null = null
  #roundOperationEpoch = 0
  #roundEnsureActive: Promise<void> | null = null
  #roundEnsurePending: {
    readonly epoch: number
    readonly ticket: number
    readonly roundId: string
    readonly query: RevisionedQuery
  } | null = null
  #roundEnsureRequestedTicket = 0
  #roundEnsureCompletedTicket = 0
  #roundEnsureFailure: unknown = null
  readonly #versionTelemetry = new Map<string, { readonly elapsedMs: number; readonly createdAt: number }>()
  readonly #candidateVersionByContent = new Map<string, {
    readonly roundId: string
    readonly versionId: string
    readonly dataRevision: number
  }>()
  #pendingFrontSnapshot: { readonly sessionId: string; readonly transcript: string } | null = null
  #frontPersistTask: Promise<void> | null = null
  #captureEpoch = 0
  #sessionOperationEpoch = 0
  #captureRecoveryCount = 0
  #captureRecoveryTask: Promise<void> | null = null
  #captureHealthyTimer: ReturnType<typeof setTimeout> | null = null
  #errorActionSequence = 0
  #activeErrorAction: number | null = null
  readonly #endedSessionIds = new Set<string>()
  #disposed = false

  constructor(ports: ApplicationControllerPorts) {
    this.#ports = ports
    this.#candidateTasks = new CandidateTaskCoordinator({
      execute: async (query, signal, generationId) => {
        const roundId = await this.#awaitCheckpointRound(query, signal)
        const projectId = this.#requireQaProject(query.sessionId)
        throwIfAborted(signal)
        // `elapsedMs` is the answer's position inside the current spoken
        // round, not merely model latency. This lets the workbench distinguish
        // an early complete question from a later materially revised one.
        const startedAt = this.#roundStartedAt ?? Date.now()
        let answer = ''
        const result = await this.#ports.rag.streamAnswer({
          projectId,
          sessionId: query.sessionId,
          generationId,
          query: query.text,
          kind: 'candidate',
          signal,
          onToken: (text) => { answer += text },
        })
        throwIfAborted(signal)
        if (result.refused) throw nonRetryableCandidateError('RAG_INSUFFICIENT_EVIDENCE')
        if (!answer.trim()) throw new Error('EMPTY_CANDIDATE_ANSWER')
        const saved = await this.#saveCandidateAnswerVersion({
          operationIdInput: {
            projectId,
            roundId,
            stage: 'candidate',
            questionRevision: query.revision,
            questionIdentity: normalizeQuestionIdentity(query.text),
            retrievalRoute: result.retrievalRoute,
            answer,
            sources: result.references,
          },
          roundId,
          projectId,
          sessionId: query.sessionId,
          stage: 'candidate',
          questionRevision: query.revision,
          questionSnapshot: query.text,
          questionIdentity: normalizeQuestionIdentity(query.text),
          answer,
          retrievalRoute: result.retrievalRoute,
          sources: result.references,
          startedAt,
        })
        throwIfAborted(signal)
        return {
          answer,
          references: result.references,
          retrievalRoute: result.retrievalRoute,
          versionId: saved.versionId,
        }
      },
      onStarted: (generationId, query) => this.#reduce({
        type: 'CANDIDATE_STARTED',
        sessionId: query.sessionId,
        generationId,
        revision: query.revision,
        questionIdentity: normalizeQuestionIdentity(query.text),
      }),
      onEquivalent: (query) => {
        const state = this.#state
        const questionIdentity = normalizeQuestionIdentity(query.text)
        if (
          state.mode !== 'qa'
          || state.qaPhase !== 'listening'
          || state.sessionId !== query.sessionId
          || state.revision !== query.revision
          || state.candidateRevision === null
          || isMaterialQuestionChange(state.candidateQuestion, query.text)
          || protectedQuestionFacetIdentity(state.candidateQuestion)
            !== protectedQuestionFacetIdentity(query.text)
          || !state.candidateAnswer.trim()
          || state.candidateRetrievalRoute === null
        ) return
        this.#reduce({
          type: 'CANDIDATE_PUBLISHED',
          sessionId: query.sessionId,
          generationId: state.generationId,
          revision: query.revision,
          questionIdentity,
          answer: state.candidateAnswer,
          sources: state.candidateSources,
          retrievalRoute: state.candidateRetrievalRoute,
        })
      },
      onResult: (generationId, query, result) => {
        this.#reduce({
          type: 'CANDIDATE_PUBLISHED',
          sessionId: query.sessionId,
          generationId,
          revision: query.revision,
          questionIdentity: normalizeQuestionIdentity(query.text),
          answer: result.answer,
          sources: result.references,
          retrievalRoute: result.retrievalRoute,
        })
        const state = this.#state
        if (
          state.sessionId === query.sessionId &&
          state.candidateRevision === query.revision &&
          state.candidateQuestion === normalizeQuestionIdentity(query.text)
        ) {
          this.#lockedAnswerVersionId = null
        } else {
          // The complete old checkpoint stays in the workspace, but it must
          // never leave the live candidate spinner stuck or overwrite a newer
          // transcript projection.
          this.#reduce({ type: 'CANDIDATE_FAILED', sessionId: query.sessionId, generationId })
        }
      },
      onError: (generationId, _query, error) => {
        this.#reduce({ type: 'CANDIDATE_FAILED', sessionId: _query.sessionId, generationId })
        this.#ports.logger.log('warn', 'candidate.failed', { error })
      },
      isRetryableError: isRetryableCandidateError,
    }, {
      nextGenerationId: () => this.#nextGeneration(),
    })
  }

  getState(): AppState {
    return this.#state
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  async dispatch(command: ControllerCommand): Promise<void> {
    if (this.#disposed) throw new Error('应用已关闭')
    switch (command.type) {
      case 'switch_mode':
        this.#reduce({ type: 'SWITCH_MODE', mode: command.mode })
        return
      case 'select_audio_source':
        this.#reduce({ type: 'SELECT_AUDIO_SOURCE', source: command.source })
        return
      case 'start_session':
        await this.#startNewSession()
        return
      case 'stop_session':
        await this.#stopSession()
        return
      case 'stop_front':
        await this.#stopFrontAndProcess()
        return
      case 'end_question':
        await this.#endQuestion()
        return
      case 'end_answer':
        await this.#endAnswer()
        return
      case 'acknowledge_front_complete':
        this.#reduce({ type: 'FRONT_COMPLETE_ACKNOWLEDGED' })
        return
      case 'retry':
        await this.#retry()
        return
      case 'dismiss_error':
        await this.#dismissError()
        return
      case 'skip_question':
        await this.#skipQuestion()
        return
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#candidateTasks.dispose()
    this.#finalController?.abort()
    this.#frontController?.abort()
    this.#ports.audio.abort()
    this.#ports.asr.abort()
    this.#clearCaptureHealthyTimer()
    this.#sessionOperationEpoch += 1
    this.#captureEpoch += 1
    await this.#flushFrontSnapshots()
    const sessionId = this.#state.sessionId
    await this.#closeRoundBestEffort('interrupted', 'qa.round_interrupt_failed')
    if (sessionId !== null) {
      await this.#endSessionBestEffort(sessionId, 'interrupted', 'session.end_failed')
    }
    this.#sessionProjectId = null
  }

  async #startNewSession(): Promise<void> {
    const before = this.#state
    if (before.mode === 'qa' ? before.qaPhase !== 'idle' : before.frontPhase !== 'idle') return
    const sessionId = randomUUID()
    const sessionOperationEpoch = ++this.#sessionOperationEpoch
    this.#captureRecoveryCount = 0
    this.#clearCaptureHealthyTimer()
    this.#sessionProjectId = null
    this.#reduce({ type: 'START_SESSION', sessionId })
    if (this.#state.sessionId !== sessionId) return
    let durableSessionCreated = false
    try {
      const session = await this.#ports.repository.beginSession({
        sessionId,
        mode: this.#state.mode,
        audioSource: this.#state.audioSource,
      })
      durableSessionCreated = true
      if (!this.#isSessionOperationCurrent(sessionId, sessionOperationEpoch)) {
        await this.#endSessionBestEffort(sessionId, 'cancelled', 'session.stale_start_end_failed')
        return
      }
      if (session.projectId === null) throw new Error('CAPTURE_PROJECT_REQUIRED')
      this.#sessionProjectId = session.projectId
      this.#assertSessionOperationCurrent(sessionId, sessionOperationEpoch)
      await this.#startCapture(sessionId, sessionOperationEpoch)
      this.#assertSessionOperationCurrent(sessionId, sessionOperationEpoch)
    } catch (error) {
      if (!this.#isSessionOperationCurrent(sessionId, sessionOperationEpoch)) {
        if (durableSessionCreated) {
          await this.#endSessionBestEffort(sessionId, 'cancelled', 'session.stale_start_end_failed')
        }
        return
      }
      this.#ports.audio.abort()
      this.#ports.asr.abort()
      await this.#endSessionBestEffort(sessionId, 'failed', 'session.end_failed')
      this.#sessionProjectId = null
      this.#fail('start', error)
    }
  }

  async #startCapture(sessionId: string, sessionOperationEpoch = this.#sessionOperationEpoch): Promise<void> {
    const captureEpoch = ++this.#captureEpoch
    this.#assertCaptureStartCurrent(sessionId, sessionOperationEpoch, captureEpoch)
    await this.#ports.audio.prepare(this.#state.audioSource)
    this.#assertCaptureStartCurrent(sessionId, sessionOperationEpoch, captureEpoch)
    try {
      await this.#ports.asr.start({
        sessionId,
        mode: this.#state.mode,
        onTranscript: (update) => {
          if (captureEpoch !== this.#captureEpoch) return
          this.#handleTranscript(update)
        },
        onFailure: (code, retryable) => {
          this.#ports.logger.log('warn', 'asr.failed', { code, retryable })
          if (captureEpoch !== this.#captureEpoch || this.#state.sessionId !== sessionId) return
          if (!this.#acceptsCaptureRecovery()) return
          if (retryable) this.#requestCaptureRecovery(sessionId, code)
          else this.#handleCaptureFailure(code)
        },
      })
      this.#assertCaptureStartCurrent(sessionId, sessionOperationEpoch, captureEpoch)
      await this.#ports.audio.start({
        sessionId,
        source: this.#state.audioSource,
        onPcmFrame: async (frame) => this.#ports.asr.sendPcmFrame(frame),
        onFailure: (code, retryable) => {
          this.#ports.logger.log('warn', 'audio.failed', { code, retryable })
          if (captureEpoch !== this.#captureEpoch || this.#state.sessionId !== sessionId) return
          if (!this.#acceptsCaptureRecovery()) return
          if (retryable) this.#requestCaptureRecovery(sessionId, code)
          else this.#handleCaptureFailure(code)
        },
      })
      this.#assertCaptureStartCurrent(sessionId, sessionOperationEpoch, captureEpoch)
      this.#armCaptureHealthyReset(sessionId, captureEpoch)
    } catch (error) {
      this.#ports.audio.abort()
      this.#ports.asr.abort()
      if (!this.#isSessionOperationCurrent(sessionId, sessionOperationEpoch)) throw new CaptureStartCancelledError()
      if (captureEpoch !== this.#captureEpoch) {
        if (this.#captureRecoveryTask !== null && this.#acceptsCaptureRecovery()) return
        throw new CaptureStartCancelledError()
      }
      const failure = captureStartFailure(error)
      if (failure.retryable && this.#acceptsCaptureRecovery()) {
        this.#requestCaptureRecovery(sessionId, failure.code)
        return
      }
      throw error
    }
  }

  #handleTranscript(update: TranscriptUpdate): void {
    const before = this.#state
    this.#reduce({ type: 'TRANSCRIPT', update })
    if (before === this.#state) return
    if (this.#state.mode === 'front' && (
      this.#state.frontPhase === 'recording' || this.#state.frontPhase === 'structuring'
    )) {
      this.#queueFrontSnapshot(update.sessionId, questionText(this.#state))
      return
    }
    if (this.#state.mode !== 'qa' || this.#state.qaPhase !== 'listening') return
    const query = questionText(this.#state)
    if (this.#state.activeRoundId === null && isMeaningfulTranscript(query)) {
      this.#acceptRoundPreview({
        sessionId: update.sessionId,
        revision: this.#state.revision,
        text: query,
        isFinal: update.kind === 'final',
      })
    }
    this.#candidateTasks.submit({
      sessionId: update.sessionId,
      revision: this.#state.revision,
      text: query,
      isFinal: update.kind === 'final',
    })
  }

  #acceptRoundPreview(query: RevisionedQuery): void {
    const roundId = this.#prepareRound(query.sessionId)
    if (roundId === null) return
    this.#scheduleRoundEnsure(roundId, query)
  }

  #prepareRound(sessionId: string): string | null {
    if (this.#state.sessionId !== sessionId || this.#state.mode !== 'qa') return null
    if (this.#state.activeRoundId !== null) return this.#state.activeRoundId
    const roundId = randomUUID()
    this.#roundOperationEpoch += 1
    this.#roundStartedAt = Date.now()
    this.#reduce({ type: 'ROUND_OPENED', sessionId, roundId })
    return this.#state.activeRoundId === roundId ? roundId : null
  }

  #scheduleRoundEnsure(roundId: string, query: RevisionedQuery): number {
    const ticket = ++this.#roundEnsureRequestedTicket
    this.#roundEnsurePending = { epoch: this.#roundOperationEpoch, ticket, roundId, query }
    this.#pumpRoundEnsure()
    return ticket
  }

  #pumpRoundEnsure(): void {
    if (this.#roundEnsureActive !== null || this.#roundEnsurePending === null) return
    const item = this.#roundEnsurePending
    this.#roundEnsurePending = null
    const task = this.#ports.repository.ensureQaRound({
      projectId: this.#requireQaProject(item.query.sessionId),
      sessionId: item.query.sessionId,
      roundId: item.roundId,
      question: item.query.text,
      startedAt: this.#roundStartedAt ?? Date.now(),
    }).then(() => {
      if (item.epoch !== this.#roundOperationEpoch) return
      this.#roundEnsureCompletedTicket = Math.max(this.#roundEnsureCompletedTicket, item.ticket)
      this.#roundEnsureFailure = null
    }, (error: unknown) => {
      if (item.epoch !== this.#roundOperationEpoch) return
      this.#roundEnsureFailure = error
      this.#ports.logger.log('warn', 'qa.round_ensure_failed', { error })
    }).finally(() => {
      if (this.#roundEnsureActive === task) this.#roundEnsureActive = null
      this.#pumpRoundEnsure()
    })
    this.#roundEnsureActive = task
  }

  async #awaitCheckpointRound(query: RevisionedQuery, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    const roundId = this.#prepareRound(query.sessionId)
    if (roundId === null) throw new Error('MISSING_QA_ROUND')
    const requiredTicket = this.#scheduleRoundEnsure(roundId, query)
    while (this.#roundEnsureCompletedTicket < requiredTicket) {
      const active = this.#roundEnsureActive
      if (active === null) {
        if (this.#roundEnsureFailure !== null) throw asError(this.#roundEnsureFailure)
        throw new Error('QA_ROUND_ENSURE_STALLED')
      }
      await active
      throwIfAborted(signal)
    }
    return roundId
  }

  async #endQuestion(): Promise<void> {
    if (this.#state.mode !== 'qa' || this.#state.qaPhase !== 'listening' || !questionText(this.#state).trim()) return
    const boundarySessionId = this.#state.sessionId
    if (boundarySessionId === null) return
    const roundId = this.#prepareRound(boundarySessionId)
    if (roundId === null) return
    const generationId = this.#nextGeneration()
    this.#candidateTasks.cancel()
    const before = this.#state
    this.#reduce({ type: 'QUESTION_ENDING', generationId })
    if (this.#state === before) return
    const boundaryCaptureEpoch = this.#captureEpoch

    try {
      await this.#stopCaptureAtBoundary()
      if (
        boundaryCaptureEpoch !== this.#captureEpoch
        || this.getState().qaPhase !== 'finalizing'
      ) return
      if (!this.#sealQuestion(generationId)) throw new Error('QUESTION_SEAL_FAILED')
      await this.#awaitCheckpointRound({
        sessionId: boundarySessionId,
        revision: this.#state.revision,
        text: questionText(this.#state),
        isFinal: true,
      }, new AbortController().signal)
      await this.#generateFinalAnswer(generationId)
    } catch (error) {
      const failureState: AppState = this.getState()
      if (this.#disposed || failureState.generationId !== generationId || failureState.qaPhase !== 'finalizing') return
      // A failed final packet still terminates this capture round. Freeze the
      // best transcript available after the finalize attempt so retry/skip
      // operate on an immutable boundary instead of a drifting live query.
      if (failureState.lockedQuestionRevision === null && !this.#sealQuestion(generationId)) {
        this.#fail('final', error)
        return
      }
      if (await this.#publishExactCandidateFallback(generationId)) return
      this.#fail('final', error)
    }
  }

  #sealQuestion(generationId: number): boolean {
    const sessionId = this.#state.sessionId
    if (sessionId === null) return false
    const revision = this.#state.revision
    const questionIdentity = normalizeQuestionIdentity(questionText(this.#state))
    this.#reduce({ type: 'QUESTION_SEALED', sessionId, generationId, revision, questionIdentity })
    return this.#state.lockedQuestionRevision === revision
      && this.#state.lockedQuestionIdentity === questionIdentity
  }

  async #generateFinalAnswer(generationId: number): Promise<void> {
    const revision = this.#state.lockedQuestionRevision
    const questionIdentity = this.#state.lockedQuestionIdentity
    const sessionId = this.#state.sessionId
    const roundId = this.#state.activeRoundId
    if (revision === null || !questionIdentity || sessionId === null || roundId === null) {
      throw new Error('QUESTION_NOT_SEALED')
    }
    const projectId = this.#requireQaProject(sessionId)
    this.#finalController?.abort()
    const controller = new AbortController()
    this.#finalController = controller
    let answer = ''
    const startedAt = this.#roundStartedAt ?? Date.now()
    try {
      const result = await this.#ports.rag.streamAnswer({
        projectId,
        sessionId,
        generationId,
        query: questionText(this.#state),
        kind: 'final',
        signal: controller.signal,
        onToken: (text) => { answer += text },
      })
      if (this.#finalController !== controller || controller.signal.aborted) return
      if (result.refused) throw new Error('RAG_INSUFFICIENT_EVIDENCE')
      if (!answer.trim()) throw new Error('EMPTY_FINAL_ANSWER')
      const saved = await this.#saveAnswerVersion({
        operationIdInput: {
          roundId,
          projectId,
          stage: 'final',
          questionRevision: revision,
          questionIdentity,
          retrievalRoute: result.retrievalRoute,
          answer,
          sources: result.references,
        },
        roundId,
        projectId,
        sessionId,
        stage: 'final',
        questionRevision: revision,
        questionSnapshot: questionText(this.#state),
        questionIdentity,
        answer,
        retrievalRoute: result.retrievalRoute,
        sources: result.references,
        startedAt,
      })
      if (this.#finalController !== controller || controller.signal.aborted) return
      this.#lockedAnswerVersionId = saved.versionId
      this.#reduce({
        type: 'FINAL_ANSWER_PUBLISHED',
        sessionId,
        generationId,
        revision,
        questionIdentity,
        answer,
        sources: result.references,
        answerOrigin: 'final',
        retrievalRoute: result.retrievalRoute,
      })
    } finally {
      if (this.#finalController === controller) this.#finalController = null
    }
  }

  async #publishExactCandidateFallback(generationId: number): Promise<boolean> {
    const state = this.#state
    if (
      state.lockedQuestionRevision === null ||
      state.candidateRevision !== state.lockedQuestionRevision ||
      state.candidateQuestion !== state.lockedQuestionIdentity ||
      !state.candidateAnswer.trim() ||
      state.activeRoundId === null ||
      state.sessionId === null ||
      state.candidateRetrievalRoute === null
    ) return false
    let saved: Awaited<ReturnType<ApplicationRepository['saveQaAnswerVersion']>>
    try {
      saved = await this.#saveAnswerVersion({
        operationIdInput: {
          projectId: this.#requireQaProject(state.sessionId),
          roundId: state.activeRoundId,
          stage: 'candidate_fallback',
          questionRevision: state.lockedQuestionRevision,
          questionIdentity: state.lockedQuestionIdentity,
          retrievalRoute: state.candidateRetrievalRoute,
          answer: state.candidateAnswer,
          sources: state.candidateSources,
        },
        projectId: this.#requireQaProject(state.sessionId),
        roundId: state.activeRoundId,
        sessionId: state.sessionId,
        stage: 'candidate_fallback',
        questionRevision: state.lockedQuestionRevision,
        questionSnapshot: questionText(state),
        questionIdentity: state.lockedQuestionIdentity,
        answer: state.candidateAnswer,
        retrievalRoute: state.candidateRetrievalRoute,
        sources: state.candidateSources,
        startedAt: this.#roundStartedAt ?? Date.now(),
      })
    } catch (error) {
      this.#ports.logger.log('warn', 'qa.candidate_fallback_save_failed', { error })
      return false
    }
    this.#lockedAnswerVersionId = saved.versionId
    this.#reduce({
      type: 'FINAL_ANSWER_PUBLISHED',
      sessionId: state.sessionId,
      generationId,
      revision: state.lockedQuestionRevision,
      questionIdentity: state.lockedQuestionIdentity,
      answer: state.candidateAnswer,
      sources: state.candidateSources,
      answerOrigin: 'candidate_fallback',
      retrievalRoute: state.candidateRetrievalRoute,
    })
    return this.#state.qaPhase === 'answer_locked'
  }

  async #endAnswer(): Promise<void> {
    if (this.#state.qaPhase !== 'answer_locked') return
    if (this.#state.answerOrigin === null) return
    if (this.#lockedAnswerVersionId === null) {
      this.#fail('commit', new Error('MISSING_SELECTED_ANSWER_VERSION'))
      return
    }
    const turn: ConversationTurn = {
      id: randomUUID(),
      question: questionText(this.#state),
      answer: this.#state.lockedAnswer,
      sourceIds: this.#state.sources.map((source) => source.id),
      answerOrigin: this.#state.answerOrigin,
      createdAt: Date.now(),
    }
    this.#pendingTurn = turn
    this.#pendingAnswerVersionId = this.#lockedAnswerVersionId
    const before = this.#state
    this.#reduce({ type: 'ANSWER_ENDED' })
    if (this.#state === before) return
    let sessionId: string
    try {
      sessionId = await this.#commitPendingTurn()
    } catch (error) {
      this.#fail('commit', error)
      return
    }
    try {
      this.#captureRecoveryCount = 0
      const sessionOperationEpoch = this.#sessionOperationEpoch
      await this.#startCapture(sessionId, sessionOperationEpoch)
    } catch (error) {
      if (error instanceof CaptureStartCancelledError) return
      this.#ports.audio.abort()
      this.#ports.asr.abort()
      this.#fail('start', error)
    }
  }

  async #stopFrontAndProcess(): Promise<void> {
    if (this.#state.mode !== 'front' || this.#state.frontPhase !== 'recording' || !questionText(this.#state).trim()) return
    const before = this.#state
    this.#reduce({ type: 'FRONT_STOPPED' })
    if (this.#state === before) return
    const boundaryCaptureEpoch = this.#captureEpoch
    try {
      await this.#stopCaptureAtBoundary()
      if (
        boundaryCaptureEpoch !== this.#captureEpoch
        || this.getState().frontPhase !== 'structuring'
      ) return
      await this.#processFrontTranscript()
    } catch (error) {
      this.#fail('front', error)
    }
  }

  async #processFrontTranscript(): Promise<void> {
    const transcript = questionText(this.#state)
    const sessionId = this.#state.sessionId
    if (sessionId === null || !transcript.trim()) throw new Error('EMPTY_FRONT_TRANSCRIPT')
    await this.#flushFrontSnapshots()
    const persisted = await this.#ports.repository.persistFrontTranscript({ sessionId, transcript })
    this.#frontController?.abort()
    const controller = new AbortController()
    this.#frontController = controller
    const markdown = await this.#ports.rag.structureTranscript({ sessionId, transcript, signal: controller.signal })
    if (this.#frontController !== controller || controller.signal.aborted) return
    this.#frontController = null
    if (!markdown.trim()) throw new Error('EMPTY_STRUCTURED_DOCUMENT')
    this.#reduce({ type: 'FRONT_STRUCTURED' })
    await this.#ports.repository.indexStructuredFront({
      projectId: this.#requireSessionProject(sessionId),
      documentId: persisted.documentId,
      markdown,
    })
    this.#reduce({ type: 'FRONT_INDEXED' })
    await this.#ports.repository.endSession(sessionId, 'complete')
    this.#endedSessionIds.add(sessionId)
    if (this.#state.sessionId === sessionId) this.#sessionProjectId = null
  }

  async #stopCaptureAtBoundary(): Promise<void> {
    this.#clearCaptureHealthyTimer()
    try {
      await this.#ports.audio.stop()
    } catch (error) {
      this.#ports.logger.log('warn', 'audio.stop_failed', { error })
    }
    await this.#ports.asr.stopAndFinalize()
  }

  async #stopSession(): Promise<void> {
    const canStopCapture = (this.#state.mode === 'qa' && this.#state.qaPhase === 'listening')
      || (this.#state.mode === 'front' && this.#state.frontPhase === 'recording')
    if (!canStopCapture) return
    const sessionId = this.#state.sessionId
    this.#sessionOperationEpoch += 1
    this.#captureEpoch += 1
    this.#clearCaptureHealthyTimer()
    this.#candidateTasks.cancel()
    this.#finalController?.abort()
    this.#frontController?.abort()
    try {
      await this.#ports.audio.stop()
    } catch (error) {
      this.#ports.logger.log('warn', 'audio.stop_failed', { error })
    }
    this.#ports.asr.abort()
    await this.#flushFrontSnapshots()
    await this.#closeRoundBestEffort('cancelled', 'qa.round_cancel_failed')
    if (sessionId !== null) {
      await this.#endSessionBestEffort(sessionId, 'cancelled', 'session.end_failed')
    }
    this.#sessionProjectId = null
    this.#reduce({ type: 'STOP_SESSION' })
    this.#resetRoundRuntime()
  }

  async #dismissError(): Promise<void> {
    if (this.#state.qaPhase !== 'error' && this.#state.frontPhase !== 'error') return
    const action = this.#claimErrorAction()
    if (action === null) return
    try {
      const sessionId = this.#state.sessionId
      this.#sessionOperationEpoch += 1
      this.#captureEpoch += 1
      this.#captureRecoveryTask = null
      this.#captureRecoveryCount = 0
      this.#clearCaptureHealthyTimer()
      this.#candidateTasks.cancel()
      this.#finalController?.abort()
      this.#finalController = null
      this.#frontController?.abort()
      this.#frontController = null
      this.#ports.audio.abort()
      this.#ports.asr.abort()
      this.#pendingTurn = null
      try {
        await this.#flushFrontSnapshots()
      } catch (error) {
        this.#ports.logger.log('warn', 'front.snapshot_flush_failed', { error })
      }
      if (sessionId !== null) {
        await this.#closeRoundBestEffort('failed', 'qa.round_dismiss_failed')
        await this.#endSessionBestEffort(sessionId, 'failed', 'session.dismiss_end_failed')
      }
      this.#sessionProjectId = null
      this.#reduce({ type: 'RESET_ERROR' })
      this.#resetRoundRuntime()
    } finally {
      this.#releaseErrorAction(action)
    }
  }

  async #skipQuestion(): Promise<void> {
    if (
      this.#state.mode !== 'qa' ||
      this.#state.qaPhase !== 'error' ||
      this.#state.errorOperation !== 'final' ||
      this.#state.sessionId === null
    ) return
    const action = this.#claimErrorAction()
    if (action === null) return
    try {
      const sessionId = this.#state.sessionId
      this.#candidateTasks.cancel()
      this.#finalController?.abort()
      this.#finalController = null
      this.#ports.audio.abort()
      this.#ports.asr.abort()
      this.#captureRecoveryCount = 0
      await this.#closeRoundBestEffort('skipped', 'qa.round_skip_failed')
      this.#reduce({ type: 'SKIP_QUESTION' })
      this.#resetRoundRuntime()
      const resumedState: AppState = this.getState()
      if (resumedState.qaPhase !== 'listening' || resumedState.sessionId !== sessionId) return
      try {
        await this.#startCapture(sessionId, this.#sessionOperationEpoch)
      } catch (error) {
        if (error instanceof CaptureStartCancelledError) return
        this.#fail('start', error)
      }
    } finally {
      this.#releaseErrorAction(action)
    }
  }

  async #retry(): Promise<void> {
    if (this.#state.qaPhase !== 'error' && this.#state.frontPhase !== 'error') return
    const action = this.#claimErrorAction()
    if (action === null) return
    try {
      switch (this.#state.errorOperation) {
        case 'start':
          await this.#closeFailedCaptureBeforeRetry()
          this.#reduce({ type: 'RESET_ERROR' })
          await this.#startNewSession()
          return
        case 'final': {
          const generationId = this.#nextGeneration()
          this.#reduce({ type: 'RETRY_FINAL', generationId })
          try {
            await this.#generateFinalAnswer(generationId)
          } catch (error) {
            if (this.#disposed || this.#state.generationId !== generationId || this.#state.qaPhase !== 'finalizing') return
            if (await this.#publishExactCandidateFallback(generationId)) return
            this.#fail('final', error)
          }
          return
        }
        case 'front':
          this.#reduce({ type: 'RETRY_FRONT' })
          try {
            await this.#processFrontTranscript()
          } catch (error) {
            this.#fail('front', error)
          }
          return
        case 'commit': {
          this.#reduce({ type: 'RETRY_COMMIT' })
          let sessionId: string
          try {
            sessionId = await this.#commitPendingTurn()
          } catch (error) {
            this.#fail('commit', error)
            return
          }
          try {
            const sessionOperationEpoch = this.#sessionOperationEpoch
            await this.#startCapture(sessionId, sessionOperationEpoch)
          } catch (error) {
            if (error instanceof CaptureStartCancelledError) return
            this.#fail('start', error)
          }
          return
        }
        case null:
          return
      }
    } finally {
      this.#releaseErrorAction(action)
    }
  }

  #claimErrorAction(): number | null {
    if (this.#activeErrorAction !== null) return null
    const action = ++this.#errorActionSequence
    this.#activeErrorAction = action
    return action
  }

  #releaseErrorAction(action: number): void {
    if (this.#activeErrorAction === action) this.#activeErrorAction = null
  }

  #fail(operation: ErrorOperation, error: unknown): void {
    this.#ports.logger.log('error', 'operation.failed', { operation, error })
    this.#reduce({ type: 'FAIL', operation, message: publicFailureMessage(operation) })
  }

  async #closeFailedCaptureBeforeRetry(): Promise<void> {
    const sessionId = this.#state.sessionId
    this.#sessionOperationEpoch += 1
    this.#captureEpoch += 1
    this.#captureRecoveryTask = null
    this.#clearCaptureHealthyTimer()
    this.#candidateTasks.cancel()
    this.#ports.audio.abort()
    this.#ports.asr.abort()
    await this.#flushFrontSnapshots()
    await this.#closeRoundBestEffort('failed', 'qa.round_retry_close_failed')
    if (sessionId !== null) {
      await this.#endSessionBestEffort(sessionId, 'failed', 'session.retry_end_failed')
    }
    this.#sessionProjectId = null
    this.#resetRoundRuntime()
  }

  async #endSessionBestEffort(
    sessionId: string,
    status: Parameters<ApplicationRepository['endSession']>[1],
    logEvent: string,
  ): Promise<void> {
    if (this.#endedSessionIds.has(sessionId)) return
    try {
      await this.#ports.repository.endSession(sessionId, status)
      this.#endedSessionIds.add(sessionId)
    } catch (error) {
      this.#ports.logger.log('warn', logEvent, { error })
    }
  }

  async #closeRoundBestEffort(
    status: Parameters<ApplicationRepository['closeQaRound']>[0]['status'],
    logEvent: string,
  ): Promise<void> {
    const roundId = this.#state.activeRoundId
    if (roundId === null) return
    try {
      await this.#drainRoundEnsures(this.#roundOperationEpoch)
      await this.#ports.repository.closeQaRound({
        projectId: this.#requireQaProject(this.#state.sessionId),
        roundId,
        status,
      })
    } catch (error) {
      this.#ports.logger.log('warn', logEvent, { error })
    }
  }

  async #drainRoundEnsures(epoch: number): Promise<void> {
    while (this.#roundEnsureActive !== null || this.#roundEnsurePending !== null) {
      this.#pumpRoundEnsure()
      const active = this.#roundEnsureActive
      if (active !== null) await active
      if (epoch !== this.#roundOperationEpoch) return
    }
    if (this.#roundEnsureFailure !== null && this.#roundEnsureCompletedTicket === 0) {
      throw asError(this.#roundEnsureFailure)
    }
  }

  async #saveCandidateAnswerVersion(
    input: SaveAnswerVersionInput,
  ): ReturnType<ApplicationRepository['saveQaAnswerVersion']> {
    const contentKey = candidateVersionContentKey(input)
    const existing = this.#candidateVersionByContent.get(contentKey)
    if (existing?.roundId === input.roundId) {
      return {
        versionId: existing.versionId,
        inserted: false,
        dataRevision: existing.dataRevision,
      }
    }
    const saved = await this.#saveAnswerVersion(input)
    this.#candidateVersionByContent.set(contentKey, {
      roundId: input.roundId,
      versionId: saved.versionId,
      dataRevision: saved.dataRevision,
    })
    return saved
  }

  async #saveAnswerVersion(input: SaveAnswerVersionInput): ReturnType<ApplicationRepository['saveQaAnswerVersion']> {
    const operationId = answerVersionOperationId(input.operationIdInput)
    let telemetry = this.#versionTelemetry.get(operationId)
    if (telemetry === undefined) {
      const createdAt = Date.now()
      telemetry = { elapsedMs: Math.max(0, createdAt - input.startedAt), createdAt }
      this.#versionTelemetry.set(operationId, telemetry)
    }
    return this.#ports.repository.saveQaAnswerVersion({
      projectId: input.projectId,
      operationId,
      roundId: input.roundId,
      sessionId: input.sessionId,
      stage: input.stage,
      questionRevision: input.questionRevision,
      questionSnapshot: input.questionSnapshot,
      questionIdentity: input.questionIdentity,
      answer: input.answer,
      retrievalRoute: input.retrievalRoute,
      sources: input.sources,
      elapsedMs: telemetry.elapsedMs,
      createdAt: telemetry.createdAt,
    })
  }

  #resetRoundRuntime(): void {
    this.#roundOperationEpoch += 1
    this.#roundStartedAt = null
    this.#roundEnsurePending = null
    this.#roundEnsureRequestedTicket = 0
    this.#roundEnsureCompletedTicket = 0
    this.#roundEnsureFailure = null
    this.#lockedAnswerVersionId = null
    this.#pendingAnswerVersionId = null
    this.#versionTelemetry.clear()
    this.#candidateVersionByContent.clear()
  }

  #handleCaptureFailure(code: string): void {
    if (this.#state.qaPhase === 'error' || this.#state.frontPhase === 'error') return
    this.#candidateTasks.cancel()
    this.#clearCaptureHealthyTimer()
    this.#ports.audio.abort()
    this.#ports.asr.abort()
    if (this.#state.mode === 'front') {
      this.#fail('front', new Error(code))
    } else if (this.#state.qaPhase === 'finalizing') {
      this.#fail('final', new Error(code))
    } else {
      void this.#closeRoundBestEffort('failed', 'qa.round_capture_failed')
      this.#fail('start', new Error(code))
    }
  }

  #acceptsCaptureRecovery(): boolean {
    return (this.#state.mode === 'qa' && this.#state.qaPhase === 'listening')
      || (this.#state.mode === 'front' && this.#state.frontPhase === 'recording')
  }

  #requestCaptureRecovery(sessionId: string, code: string): void {
    if (this.#captureRecoveryTask !== null) return
    if (this.#captureRecoveryCount >= 2) {
      this.#handleCaptureFailure(code)
      return
    }
    this.#captureRecoveryCount += 1
    const attempt = this.#captureRecoveryCount
    const sessionOperationEpoch = this.#sessionOperationEpoch
    this.#ports.logger.log('warn', 'capture.recovering', { attempt, code })
    this.#candidateTasks.cancel()
    this.#reduce({
      type: 'CANDIDATE_FAILED',
      sessionId,
      generationId: this.#state.generationId,
    })
    this.#clearCaptureHealthyTimer()
    this.#ports.audio.abort()
    this.#ports.asr.abort()
    this.#captureEpoch += 1
    const recoveryDelay = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250 * 2 ** (attempt - 1))
      timer.unref?.()
    })
    const recoveryTask = recoveryDelay.then(async () => {
      if (
        !this.#isSessionOperationCurrent(sessionId, sessionOperationEpoch)
        || !this.#acceptsCaptureRecovery()
      ) return
      // The delay is the single-flight boundary. Release this task's slot
      // before opening the replacement capture so an immediate failure from
      // the new ASR/audio generation can schedule the next bounded attempt.
      if (this.#captureRecoveryTask === recoveryTask) this.#captureRecoveryTask = null
      await this.#startCapture(sessionId, sessionOperationEpoch)
    }).catch((error: unknown) => {
      if (error instanceof CaptureStartCancelledError) return
      if (!this.#disposed && this.#state.sessionId === sessionId) this.#handleCaptureFailure(
        error instanceof Error ? error.message : 'RECOVERY_FAILED',
      )
    }).finally(() => {
      // Do not erase a newer recovery requested while this replacement was
      // starting.
      if (this.#captureRecoveryTask === recoveryTask) this.#captureRecoveryTask = null
    })
    this.#captureRecoveryTask = recoveryTask
  }

  #armCaptureHealthyReset(sessionId: string, captureEpoch: number): void {
    this.#clearCaptureHealthyTimer()
    this.#captureHealthyTimer = setTimeout(() => {
      this.#captureHealthyTimer = null
      if (
        !this.#disposed &&
        captureEpoch === this.#captureEpoch &&
        this.#state.sessionId === sessionId &&
        this.#acceptsCaptureRecovery()
      ) {
        this.#captureRecoveryCount = 0
      }
    }, CAPTURE_HEALTHY_RESET_MS)
    this.#captureHealthyTimer.unref?.()
  }

  #clearCaptureHealthyTimer(): void {
    if (this.#captureHealthyTimer !== null) clearTimeout(this.#captureHealthyTimer)
    this.#captureHealthyTimer = null
  }

  #isSessionOperationCurrent(sessionId: string, sessionOperationEpoch: number): boolean {
    return !this.#disposed
      && sessionOperationEpoch === this.#sessionOperationEpoch
      && this.#state.sessionId === sessionId
  }

  #assertSessionOperationCurrent(sessionId: string, sessionOperationEpoch: number): void {
    if (!this.#isSessionOperationCurrent(sessionId, sessionOperationEpoch)) {
      throw new CaptureStartCancelledError()
    }
  }

  #requireQaProject(sessionId: string | null): string {
    if (this.#state.mode !== 'qa') throw new Error('QA_PROJECT_REQUIRED')
    return this.#requireSessionProject(sessionId)
  }

  #requireSessionProject(sessionId: string | null): string {
    if (sessionId === null || this.#state.sessionId !== sessionId || this.#sessionProjectId === null) {
      throw new Error('CAPTURE_PROJECT_REQUIRED')
    }
    return this.#sessionProjectId
  }

  #assertCaptureStartCurrent(
    sessionId: string,
    sessionOperationEpoch: number,
    captureEpoch: number,
  ): void {
    this.#assertSessionOperationCurrent(sessionId, sessionOperationEpoch)
    if (captureEpoch !== this.#captureEpoch) throw new CaptureStartCancelledError()
  }

  async #commitPendingTurn(): Promise<string> {
    const turn = this.#pendingTurn
    if (turn === null) throw new Error('MISSING_PENDING_TURN')
    const answerVersionId = this.#pendingAnswerVersionId
    if (answerVersionId === null) throw new Error('MISSING_SELECTED_ANSWER_VERSION')
    const activeSessionId = this.#state.sessionId
    if (activeSessionId === null) throw new Error('MISSING_SESSION')
    const roundId = this.#state.activeRoundId
    if (roundId === null) throw new Error('MISSING_QA_ROUND')
    await this.#ports.repository.commitQaRound({
      projectId: this.#requireQaProject(activeSessionId),
      roundId,
      selectedAnswerVersionId: answerVersionId,
      sessionId: activeSessionId,
      turn,
    })
    this.#reduce({ type: 'ROUND_COMMITTED', turn })
    this.#pendingTurn = null
    this.#pendingAnswerVersionId = null
    this.#resetRoundRuntime()
    const sessionId = this.#state.sessionId
    if (sessionId === null) throw new Error('MISSING_SESSION')
    return sessionId
  }

  #queueFrontSnapshot(sessionId: string, transcript: string): void {
    if (!transcript.trim()) return
    this.#pendingFrontSnapshot = { sessionId, transcript }
    if (this.#frontPersistTask !== null) return
    this.#frontPersistTask = (async () => {
      while (this.#pendingFrontSnapshot !== null) {
        const next = this.#pendingFrontSnapshot
        this.#pendingFrontSnapshot = null
        try {
          await this.#ports.repository.persistFrontSnapshot(next)
        } catch (error) {
          this.#ports.logger.log('warn', 'front.snapshot_failed', { error })
        }
      }
    })().finally(() => {
      this.#frontPersistTask = null
      if (this.#pendingFrontSnapshot !== null) this.#queueFrontSnapshot(
        this.#pendingFrontSnapshot.sessionId,
        this.#pendingFrontSnapshot.transcript,
      )
    })
  }

  async #flushFrontSnapshots(): Promise<void> {
    while (this.#frontPersistTask !== null || this.#pendingFrontSnapshot !== null) {
      if (this.#frontPersistTask === null && this.#pendingFrontSnapshot !== null) {
        this.#queueFrontSnapshot(this.#pendingFrontSnapshot.sessionId, this.#pendingFrontSnapshot.transcript)
      }
      await this.#frontPersistTask
    }
  }

  #reduce(event: AppEvent): void {
    const next = appReducer(this.#state, event)
    if (next === this.#state) return
    this.#state = next
    for (const listener of this.#listeners) listener(next)
  }

  #nextGeneration(): number {
    this.#generationSequence = Math.max(this.#generationSequence, this.#state.generationId) + 1
    return this.#generationSequence
  }
}

function captureStartFailure(error: unknown): { readonly code: string; readonly retryable: boolean } {
  if (typeof error !== 'object' || error === null) return { code: 'CAPTURE_START_FAILED', retryable: false }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : 'CAPTURE_START_FAILED'
  const retryable = 'retryable' in error && typeof error.retryable === 'boolean' ? error.retryable : false
  return { code, retryable }
}

function isMeaningfulTranscript(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '')
  if ([...normalized].length < 3) return false
  return !/^(?:嗯+|啊+|那个|就是|我想问|请问)$/u.test(normalized)
}

function candidateVersionContentKey(input: Pick<
  SaveAnswerVersionInput,
  'roundId' | 'questionSnapshot' | 'answer' | 'retrievalRoute' | 'sources'
>): string {
  const normalizedAnswer = input.answer.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  return createHash('sha256').update(JSON.stringify([
    input.roundId,
    input.retrievalRoute,
    [...input.sources].map((source) => source.id).sort(),
    createHash('sha256').update(normalizedAnswer).digest('hex'),
    stableCheckpointQuestionIdentity(input.questionSnapshot),
    protectedQuestionFacetIdentity(input.questionSnapshot),
  ])).digest('hex')
}

function answerVersionOperationId(input: {
  readonly projectId: string
  readonly roundId: string
  readonly stage: AnswerVersionStage
  readonly questionRevision: number
  readonly questionIdentity: string
  readonly retrievalRoute: RetrievalRoute
  readonly answer: string
  readonly sources: readonly SourceReference[]
}): string {
  const questionHash = createHash('sha256').update(input.questionIdentity).digest('hex')
  const answerHash = createHash('sha256').update(input.answer.normalize('NFKC').trim()).digest('hex')
  return createHash('sha256').update(JSON.stringify([
    input.projectId,
    input.roundId,
    input.stage,
    input.questionRevision,
    questionHash,
    input.retrievalRoute,
    answerHash,
    [...input.sources].map((source) => source.id).sort(),
  ])).digest('hex')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Candidate task was aborted', 'AbortError')
}

function nonRetryableCandidateError(code: string): Error {
  return Object.assign(new Error(code), { retryable: false })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('QA_ROUND_ENSURE_FAILED', { cause: error })
}

function isRetryableCandidateError(error: unknown): boolean {
  return !(typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === false)
}
