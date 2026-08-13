import { describe, expect, it, vi } from 'vitest'
import type { AppCommand } from '../../core/contracts'
import type { AudioSourceKind, ConversationTurn, SourceReference, TranscriptUpdate } from '../../core/types'
import { SecureLogger } from '../security/secure-logger'
import {
  ApplicationController,
  type ApplicationRepository,
  type AsrRuntime,
  type AudioRuntime,
  type RagRuntime,
} from './controller'

class FakeAudio implements AudioRuntime {
  prepares = 0
  starts = 0
  stops = 0
  source: AudioSourceKind | null = null
  failPrepare = false
  startGate: Promise<void> | null = null
  stopGate: Promise<void> | null = null
  aborts = 0
  onFailure: ((code: string, retryable: boolean) => void) | null = null
  async prepare(source: AudioSourceKind): Promise<void> {
    this.prepares += 1
    this.source = source
    if (this.failPrepare) throw new Error('MICROPHONE_PERMISSION_REQUIRED')
  }
  async start(input: Parameters<AudioRuntime['start']>[0]): Promise<void> {
    this.starts += 1
    this.source = input.source
    this.onFailure = input.onFailure
    await this.startGate
  }
  async stop(): Promise<void> { this.stops += 1; await this.stopGate }
  abort(): void { this.aborts += 1 }
  fail(code = 'BACKPRESSURE', retryable = true): void { this.onFailure?.(code, retryable) }
}

class FakeAsr implements AsrRuntime {
  starts = 0
  stops = 0
  aborts = 0
  sessionId = ''
  onTranscript: ((update: TranscriptUpdate) => void) | null = null
  onFailure: ((code: string, retryable: boolean) => void) | null = null
  finalUpdate: TranscriptUpdate | null = null
  stopError: Error | null = null
  startFailures: Error[] = []
  async start(input: Parameters<AsrRuntime['start']>[0]): Promise<void> {
    this.starts += 1
    this.sessionId = input.sessionId
    this.onTranscript = input.onTranscript
    this.onFailure = input.onFailure
    const startFailure = this.startFailures.shift()
    if (startFailure !== undefined) throw startFailure
  }
  async sendPcmFrame(): Promise<void> {}
  async stopAndFinalize(): Promise<void> {
    this.stops += 1
    if (this.stopError !== null) throw this.stopError
    if (this.finalUpdate !== null) this.onTranscript?.(this.finalUpdate)
  }
  abort(): void { this.aborts += 1 }
  emit(kind: TranscriptUpdate['kind'], text: string, sequence: number): void {
    this.onTranscript?.({ sessionId: this.sessionId, kind, text, sequence })
  }
  fail(code = 'SERVER_WAITING_AUDIO_TIMEOUT'): void {
    this.onFailure?.(code, true)
  }
}

class FakeRag implements RagRuntime {
  failFinalOnce = false
  failStructureOnce = false
  candidateAnswer = '候选答案'
  candidateReferences: readonly SourceReference[] = []
  structureCalls = 0
  refuse = false
  answerCalls: Array<{ projectId?: string; query: string; kind: 'candidate' | 'final' }> = []
  async streamAnswer(input: Parameters<RagRuntime['streamAnswer']>[0]): ReturnType<RagRuntime['streamAnswer']> {
    this.answerCalls.push({ projectId: input.projectId, query: input.query, kind: input.kind })
    if (this.refuse) return { references: [], retrievalRoute: 'source_document', refused: true }
    if (input.kind === 'final' && this.failFinalOnce) {
      this.failFinalOnce = false
      throw new Error('provider unavailable')
    }
    input.onToken(input.kind === 'final' ? '这是有证据的确定答案。' : this.candidateAnswer)
    return {
      references: input.kind === 'candidate' ? this.candidateReferences : [],
      retrievalRoute: input.kind === 'candidate' && this.candidateReferences[0]?.kind === 'preset_qa'
        ? 'preset_qa_exact'
        : 'source_document',
      refused: false,
    }
  }
  async structureTranscript(input: Parameters<RagRuntime['structureTranscript']>[0]): Promise<string> {
    this.structureCalls += 1
    if (this.failStructureOnce) {
      this.failStructureOnce = false
      throw new Error('structure unavailable')
    }
    return `# 结构化记录\n\n${input.transcript}`
  }
}

class FakeRepository implements ApplicationRepository {
  projectId: string | null = 'project-test'
  turns: ConversationTurn[] = []
  sessions: Array<{ sessionId: string; mode: 'front' | 'qa'; audioSource: AudioSourceKind }> = []
  ended: Array<{ sessionId: string; status: 'complete' | 'cancelled' | 'failed' | 'interrupted' }> = []
  rawTranscripts: string[] = []
  snapshots: string[] = []
  indexed: string[] = []
  indexedProjects: string[] = []
  failEnd = false
  failSaveOnce = false
  endGate: Promise<void> | null = null
  operations: string[] = []
  rounds: Array<{ roundId: string; question: string; status: string }> = []
  answerVersions: Array<Parameters<ApplicationRepository['saveQaAnswerVersion']>[0] & { versionId: string }> = []
  workspaceRevision = 0
  ensureCalls = 0
  ensureSessions: string[] = []
  async beginSession(input: Parameters<ApplicationRepository['beginSession']>[0]): ReturnType<ApplicationRepository['beginSession']> {
    this.operations.push(`begin:${input.sessionId}`)
    this.sessions.push(input)
    return { projectId: this.projectId }
  }
  async endSession(...[sessionId, status]: Parameters<ApplicationRepository['endSession']>): Promise<void> {
    this.operations.push(`end:${sessionId}:${status}`)
    this.ended.push({ sessionId, status })
    await this.endGate
    if (this.failEnd) throw new Error('database unavailable')
  }
  async saveTurn(input: Parameters<ApplicationRepository['saveTurn']>[0]): Promise<void> {
    if (this.failSaveOnce) {
      this.failSaveOnce = false
      throw new Error('turn save unavailable')
    }
    this.turns.push(input.turn)
  }
  async ensureQaRound(input: Parameters<ApplicationRepository['ensureQaRound']>[0]): Promise<{ readonly dataRevision: number }> {
    this.ensureCalls += 1
    this.ensureSessions.push(input.sessionId)
    const existing = this.rounds.find((round) => round.roundId === input.roundId)
    if (existing) existing.question = input.question
    else this.rounds.push({ roundId: input.roundId, question: input.question, status: 'active' })
    return { dataRevision: ++this.workspaceRevision }
  }
  async saveQaAnswerVersion(
    input: Parameters<ApplicationRepository['saveQaAnswerVersion']>[0],
  ): ReturnType<ApplicationRepository['saveQaAnswerVersion']> {
    const duplicate = this.answerVersions.find((version) => version.operationId === input.operationId)
    if (duplicate) return { versionId: duplicate.versionId, inserted: false, dataRevision: this.workspaceRevision }
    const versionId = `version-${this.answerVersions.length + 1}`
    this.answerVersions.push({ ...input, versionId })
    return { versionId, inserted: true, dataRevision: ++this.workspaceRevision }
  }
  async commitQaRound(input: Parameters<ApplicationRepository['commitQaRound']>[0]): Promise<{ readonly dataRevision: number }> {
    if (this.failSaveOnce) {
      this.failSaveOnce = false
      throw new Error('turn save unavailable')
    }
    this.turns.push(input.turn)
    const round = this.rounds.find((candidate) => candidate.roundId === input.roundId)
    if (round) round.status = 'completed'
    return { dataRevision: ++this.workspaceRevision }
  }
  async closeQaRound(
    input: Parameters<ApplicationRepository['closeQaRound']>[0],
  ): Promise<{ readonly dataRevision: number }> {
    const round = this.rounds.find((candidate) => candidate.roundId === input.roundId)
    if (round) round.status = input.status
    return { dataRevision: ++this.workspaceRevision }
  }
  async persistFrontSnapshot(input: Parameters<ApplicationRepository['persistFrontSnapshot']>[0]): Promise<void> {
    this.snapshots.push(input.transcript)
  }
  async persistFrontTranscript(input: Parameters<ApplicationRepository['persistFrontTranscript']>[0]): Promise<{ readonly documentId: string }> {
    this.rawTranscripts.push(input.transcript)
    return { documentId: 'front-document' }
  }
  async indexStructuredFront(input: Parameters<ApplicationRepository['indexStructuredFront']>[0]): Promise<void> {
    this.indexedProjects.push(input.projectId)
    this.indexed.push(input.markdown)
  }
}

function createController(): {
  controller: ApplicationController
  audio: FakeAudio
  asr: FakeAsr
  rag: FakeRag
  repository: FakeRepository
} {
  const audio = new FakeAudio()
  const asr = new FakeAsr()
  const rag = new FakeRag()
  const repository = new FakeRepository()
  const controller = new ApplicationController({
    audio,
    asr,
    rag,
    repository,
    logger: new SecureLogger(() => undefined),
  })
  return { controller, audio, asr, rag, repository }
}

function deferred(): {
  readonly promise: Promise<void>
  resolve(): void
  reject(error: Error): void
} {
  let resolvePromise: (() => void) | undefined
  let rejectPromise: ((error: Error) => void) | undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error),
  }
}

async function dispatch(controller: ApplicationController, command: AppCommand): Promise<void> {
  await controller.dispatch(command)
}

describe('ApplicationController', () => {
  it('fails a QA start without an active project before permission, ASR, or helper side effects', async () => {
    const { controller, repository, audio, asr } = createController()
    repository.projectId = null

    await dispatch(controller, { type: 'start_session' })

    expect(audio.prepares).toBe(0)
    expect(audio.starts).toBe(0)
    expect(asr.starts).toBe(0)
    expect(repository.ended).toEqual([expect.objectContaining({ status: 'failed' })])
    expect(controller.getState()).toMatchObject({ qaPhase: 'error', errorOperation: 'start' })
    await controller.dispose()
  })

  it('fails a front start without an active project before permission, ASR, or helper side effects', async () => {
    const { controller, repository, audio, asr } = createController()
    repository.projectId = null
    await dispatch(controller, { type: 'switch_mode', mode: 'front' })

    await dispatch(controller, { type: 'start_session' })

    expect(audio.prepares).toBe(0)
    expect(audio.starts).toBe(0)
    expect(asr.starts).toBe(0)
    expect(repository.ended).toEqual([expect.objectContaining({ status: 'failed' })])
    expect(controller.getState()).toMatchObject({ frontPhase: 'error', errorOperation: 'start' })
    await controller.dispose()
  })

  it('finishes the local permission preflight before opening cloud ASR', async () => {
    const { controller, audio, asr } = createController()
    audio.failPrepare = true

    await dispatch(controller, { type: 'start_session' })

    expect(audio.prepares).toBe(1)
    expect(asr.starts).toBe(0)
    expect(audio.starts).toBe(0)
    expect(controller.getState().qaPhase).toBe('error')
    await controller.dispose()
  })

  it('opens a round for the first meaningful transcript without generating an incomplete question', async () => {
    const { controller, asr, rag, repository } = createController()
    await dispatch(controller, { type: 'start_session' })

    asr.emit('partial', '我们公司的', 1)
    await Promise.resolve()

    expect(controller.getState().activeRoundId).not.toBeNull()
    expect(repository.rounds[0]?.question).toBe('我们公司的')
    expect(rag.answerCalls).toEqual([])
    await controller.dispose()
  })

  it('awaits round persistence before executing the first candidate', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, rag, repository } = createController()
      const gate = deferred()
      const ensure = repository.ensureQaRound.bind(repository)
      repository.ensureQaRound = async (input): Promise<{ readonly dataRevision: number }> => {
        await gate.promise
        return ensure(input)
      }
      await dispatch(controller, { type: 'start_session' })
      asr.emit('final', '请问项目预算是多少？', 1)
      await vi.advanceTimersByTimeAsync(0)
      expect(rag.answerCalls).toEqual([])

      gate.resolve()
      await vi.runAllTimersAsync()
      expect(rag.answerCalls[0]).toMatchObject({ kind: 'candidate', query: '请问项目预算是多少？' })
      expect(rag.answerCalls[0]?.projectId).toBe('project-test')
      expect(repository.answerVersions).toHaveLength(1)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('records each complete answer at its elapsed position within the spoken round', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const { controller, asr, repository } = createController()
      await dispatch(controller, { type: 'start_session' })
      asr.emit('partial', '关于项目预算', 1)
      await Promise.resolve()

      vi.setSystemTime(6_000)
      asr.emit('final', '请问项目预算是多少？', 2)
      await vi.runAllTimersAsync()

      expect(repository.answerVersions[0]?.elapsedMs).toBe(5_000)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces a thousand accepted preview updates into bounded repository work', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, repository } = createController()
      const firstEnsure = deferred()
      const ensure = repository.ensureQaRound.bind(repository)
      repository.ensureQaRound = async (input): Promise<{ readonly dataRevision: number }> => {
        if (repository.ensureCalls === 0) await firstEnsure.promise
        return ensure(input)
      }
      await dispatch(controller, { type: 'start_session' })
      for (let revision = 1; revision <= 1_000; revision += 1) {
        asr.emit('partial', `请问${revision}年项目预算是多少？`, revision)
      }

      firstEnsure.resolve()
      await vi.waitFor(() => expect(repository.rounds[0]?.question).toBe('请问1000年项目预算是多少？'))
      expect(repository.ensureCalls).toBeLessThanOrEqual(2)
      expect(repository.rounds).toHaveLength(1)
      expect(repository.rounds[0]?.question).toBe('请问1000年项目预算是多少？')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not persist and publish every material ASR partial before a semantic checkpoint starts', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, repository } = createController()
      await dispatch(controller, { type: 'start_session' })

      for (let revision = 1; revision <= 30; revision += 1) {
        asr.emit('partial', `请问第${revision}期项目预算是多少？`, revision)
        await vi.advanceTimersByTimeAsync(200)
      }

      expect(repository.ensureCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(450)
      await Promise.resolve()
      expect(repository.ensureCalls).toBeLessThanOrEqual(2)
      expect(repository.rounds[0]?.question).toBe('请问第30期项目预算是多少？')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start or persist another candidate for a synonymous word-order rewrite', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, rag, repository } = createController()
      await dispatch(controller, { type: 'start_session' })

      asr.emit('partial', '请问如何控制项目风险？', 1)
      await vi.advanceTimersByTimeAsync(451)
      expect(repository.answerVersions).toHaveLength(1)

      asr.emit('partial', '请问项目风险怎么控制？', 2)
      await vi.runAllTimersAsync()

      expect(rag.answerCalls.filter((call) => call.kind === 'candidate')).toHaveLength(1)
      expect(repository.answerVersions).toHaveLength(1)
      expect(controller.getState().candidateRevision).toBe(2)
      expect(controller.getState().candidateQuestion).toBe('请问项目风险怎么控制?')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists a material question revision even when its answer payload is unchanged', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, rag, repository } = createController()
      const source: SourceReference = {
        id: 'risk-source',
        documentId: 'document-1',
        title: '风险资料',
        kind: 'source_document',
        excerpt: '风险答案证据',
        score: 0.93,
      }
      rag.candidateAnswer = '先识别风险，再设置分级应对机制。'
      rag.candidateReferences = [source]
      await dispatch(controller, { type: 'start_session' })

      asr.emit('partial', '请问如何控制项目风险？', 1)
      await vi.advanceTimersByTimeAsync(451)
      expect(repository.answerVersions).toHaveLength(1)

      asr.emit('partial', '请问如何提前识别处理与持续管理项目风险？', 2)
      await vi.runAllTimersAsync()

      expect(rag.answerCalls.filter((call) => call.kind === 'candidate')).toHaveLength(2)
      expect(repository.answerVersions).toHaveLength(2)
      expect(repository.answerVersions.map((version) => version.answer)).toEqual([
        '先识别风险，再设置分级应对机制。',
        '先识别风险，再设置分级应对机制。',
      ])
      expect(controller.getState().candidateRevision).toBe(2)
      expect(controller.getState().candidateQuestion).toBe('请问如何提前识别处理与持续管理项目风险?')
      expect(controller.getState().candidateAnswer).toBe('先识别风险，再设置分级应对机制。')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists a new candidate when a protected region or negation facet changes', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, repository } = createController()
      await dispatch(controller, { type: 'start_session' })

      asr.emit('partial', '请问北京项目会延期吗？', 1)
      await vi.advanceTimersByTimeAsync(451)
      asr.emit('partial', '请问上海项目不延期吗？', 2)
      await vi.runAllTimersAsync()

      expect(repository.answerVersions).toHaveLength(2)
      expect(repository.answerVersions.map((version) => version.questionRevision)).toEqual([1, 2])
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes a deferred candidate once for an identical higher ASR revision', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, rag, repository } = createController()
      const candidateGate = deferred()
      rag.streamAnswer = async (input): ReturnType<RagRuntime['streamAnswer']> => {
        rag.answerCalls.push({ query: input.query, kind: input.kind })
        if (input.kind === 'candidate') await candidateGate.promise
        input.onToken(input.kind === 'candidate' ? '同一问题的候选答案' : '最终答案')
        return { references: [], retrievalRoute: 'source_document', refused: false }
      }
      await dispatch(controller, { type: 'start_session' })

      asr.emit('partial', '请问项目预算是多少？', 1)
      await vi.advanceTimersByTimeAsync(451)
      expect(rag.answerCalls).toHaveLength(1)
      asr.emit('partial', '请问项目预算是多少？', 2)
      candidateGate.resolve()
      await vi.waitFor(() => expect(controller.getState().candidateRevision).toBe(2))

      expect(repository.answerVersions).toHaveLength(1)
      expect(controller.getState().candidateRevision).toBe(2)
      expect(controller.getState().candidateAnswer).toBe('同一问题的候选答案')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a delayed old candidate in history without publishing it over a protected-facet revision', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, rag, repository } = createController()
      const oldGate = deferred()
      rag.streamAnswer = async (input): ReturnType<RagRuntime['streamAnswer']> => {
        rag.answerCalls.push({ query: input.query, kind: input.kind })
        if (input.kind === 'candidate' && input.query.includes('北京')) await oldGate.promise
        input.onToken(input.query.includes('北京') ? '北京旧答案' : '上海新答案')
        return { references: [], retrievalRoute: 'source_document', refused: false }
      }
      await dispatch(controller, { type: 'start_session' })

      asr.emit('partial', '请问北京项目预算是多少？', 1)
      await vi.advanceTimersByTimeAsync(451)
      asr.emit('partial', '请问上海项目预算是多少？', 2)
      oldGate.resolve()
      await vi.waitFor(() => expect(repository.answerVersions).toHaveLength(1))

      expect(controller.getState().candidateAnswer).toBe('')
      expect(repository.answerVersions[0]?.questionRevision).toBe(1)

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.waitFor(() => expect(controller.getState().candidateRevision).toBe(2))
      expect(controller.getState().candidateAnswer).toBe('上海新答案')
      expect(repository.answerVersions).toHaveLength(2)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never reuses a delayed Chinese-entity candidate for another organization', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, rag, repository } = createController()
      const huaweiGate = deferred()
      rag.streamAnswer = async (input): ReturnType<RagRuntime['streamAnswer']> => {
        rag.answerCalls.push({ query: input.query, kind: input.kind })
        if (input.kind === 'candidate' && input.query.includes('华为')) await huaweiGate.promise
        input.onToken(input.query.includes('华为') ? '华为项目预算答案' : '小米项目预算答案')
        return { references: [], retrievalRoute: 'source_document', refused: false }
      }
      await dispatch(controller, { type: 'start_session' })

      asr.emit('partial', '请问华为项目预算是多少？', 1)
      await vi.advanceTimersByTimeAsync(451)
      asr.emit('partial', '请问小米项目预算是多少？', 2)
      huaweiGate.resolve()
      await vi.waitFor(() => expect(repository.answerVersions).toHaveLength(1))

      expect(controller.getState().candidateAnswer).toBe('')
      expect(repository.answerVersions[0]?.questionSnapshot).toContain('华为')

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.waitFor(() => expect(controller.getState().candidateRevision).toBe(2))
      expect(controller.getState().candidateAnswer).toBe('小米项目预算答案')
      expect(repository.answerVersions).toHaveLength(2)
      expect(repository.answerVersions[1]?.questionSnapshot).toContain('小米')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never publishes a delayed candidate across a reversed directional relation', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, rag, repository } = createController()
      const firstRelationGate = deferred()
      rag.streamAnswer = async (input): ReturnType<RagRuntime['streamAnswer']> => {
        rag.answerCalls.push({ query: input.query, kind: input.kind })
        if (input.kind === 'candidate' && input.query.startsWith('甲方')) await firstRelationGate.promise
        // Deliberately return identical content: the protected directional
        // facet, not incidental wording, must prevent version reuse.
        input.onToken('应按双方约定的权责机制管理。')
        return { references: [], retrievalRoute: 'source_document', refused: false }
      }
      await dispatch(controller, { type: 'start_session' })

      asr.emit('partial', '甲方影响乙方哪些业务？', 1)
      await vi.advanceTimersByTimeAsync(451)
      asr.emit('partial', '乙方影响甲方哪些业务？', 2)
      firstRelationGate.resolve()
      await vi.waitFor(() => expect(repository.answerVersions).toHaveLength(1))

      expect(controller.getState().candidateAnswer).toBe('')
      expect(repository.answerVersions[0]?.questionSnapshot).toContain('甲方影响乙方哪些业务')

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.waitFor(() => expect(controller.getState().candidateRevision).toBe(2))
      expect(controller.getState().candidateQuestion).toBe('乙方影响甲方哪些业务?')
      expect(repository.answerVersions).toHaveLength(2)
      expect(repository.answerVersions[1]?.questionSnapshot).toContain('乙方影响甲方哪些业务')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a deferred old-round ensure satisfy the next session round', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, repository } = createController()
      const oldEnsure = deferred()
      const ensure = repository.ensureQaRound.bind(repository)
      repository.ensureQaRound = async (input): Promise<{ readonly dataRevision: number }> => {
        if (repository.ensureCalls === 0) await oldEnsure.promise
        return ensure(input)
      }
      await dispatch(controller, { type: 'start_session' })
      const oldSessionId = controller.getState().sessionId!
      asr.emit('partial', '请问旧会话预算是多少？', 1)
      const stopping = dispatch(controller, { type: 'stop_session' })
      await Promise.resolve()
      expect(controller.getState().sessionId).toBe(oldSessionId)

      oldEnsure.resolve()
      await stopping
      await dispatch(controller, { type: 'start_session' })
      const newSessionId = controller.getState().sessionId!
      asr.emit('final', '请问新会话净利润是多少？', 2)
      await vi.runAllTimersAsync()

      expect(newSessionId).not.toBe(oldSessionId)
      expect(repository.ensureSessions).toContain(oldSessionId)
      expect(repository.ensureSessions).toContain(newSessionId)
      expect(repository.rounds.filter((round) => round.status === 'active')).toHaveLength(1)
      expect(repository.rounds.find((round) => round.status === 'active')?.question).toBe('请问新会话净利润是多少？')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('locks a final ASR replacement before generating and commits the round', async () => {
    const { controller, audio, asr, rag, repository } = createController()
    await dispatch(controller, { type: 'start_session' })
    asr.emit('partial', '公司的收入', 1)
    asr.finalUpdate = { sessionId: asr.sessionId, kind: 'final', text: '公司的收入是多少？', sequence: 2 }
    await dispatch(controller, { type: 'end_question' })

    expect(controller.getState().qaPhase).toBe('answer_locked')
    expect(rag.answerCalls.at(-1)?.query).toBe('公司的收入是多少？')
    expect(controller.getState().lockedAnswer).toBe('这是有证据的确定答案。')
    await dispatch(controller, { type: 'end_answer' })
    expect(repository.turns).toHaveLength(1)
    expect(repository.turns[0]?.answerOrigin).toBe('final')
    expect(repository.sessions).toHaveLength(1)
    expect(controller.getState().qaPhase).toBe('listening')
    expect(asr.starts).toBe(2)
    expect(audio.starts).toBe(2)
    await controller.dispose()
  })

  it('keeps the question when final generation fails and retries safely', async () => {
    const { controller, asr, rag } = createController()
    rag.failFinalOnce = true
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '需要重试的问题', 1)
    await dispatch(controller, { type: 'end_question' })
    expect(controller.getState().qaPhase).toBe('error')
    expect(controller.getState().finalSegments.join('')).toBe('需要重试的问题')
    await dispatch(controller, { type: 'retry' })
    expect(controller.getState().qaPhase).toBe('answer_locked')
    expect(controller.getState().lockedAnswer).toBe('这是有证据的确定答案。')
    await controller.dispose()
  })

  it('publishes an exact current candidate as the stable fallback when final generation fails', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, rag, repository } = createController()
      const candidateSource: SourceReference = {
        id: 'candidate-source',
        documentId: 'document-1',
        title: '年度资料',
        kind: 'source_document',
        excerpt: '净利润同比增长。',
        score: 0.91,
      }
      rag.candidateAnswer = '当前问题的稳定候选答案'
      rag.candidateReferences = [candidateSource]
      await dispatch(controller, { type: 'start_session' })
      asr.emit('final', '请问今年净利润增长是多少？', 1)
      await vi.advanceTimersByTimeAsync(451)
      expect(controller.getState().candidateAnswer).toBe('当前问题的稳定候选答案')
      expect(controller.getState().candidateRevision).toBe(1)
      rag.failFinalOnce = true

      await dispatch(controller, { type: 'end_question' })

      expect(controller.getState().qaPhase).toBe('answer_locked')
      expect(controller.getState().lockedAnswer).toBe('当前问题的稳定候选答案')
      expect(controller.getState().answerOrigin).toBe('candidate_fallback')
      expect(controller.getState().sources).toEqual([candidateSource])
      await dispatch(controller, { type: 'end_answer' })
      expect(repository.turns[0]?.answerOrigin).toBe('candidate_fallback')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never falls back to a candidate from an older question revision', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, rag, repository } = createController()
      rag.candidateAnswer = '2023年营收答案'
      await dispatch(controller, { type: 'start_session' })
      asr.emit('partial', '请问2023年营收是多少？', 1)
      await vi.advanceTimersByTimeAsync(451)
      expect(controller.getState().candidateRevision).toBe(1)
      asr.emit('partial', '不是营收，请问2024年净利润是多少？', 2)
      rag.failFinalOnce = true

      await dispatch(controller, { type: 'end_question' })

      expect(controller.getState().qaPhase).toBe('error')
      expect(controller.getState().errorOperation).toBe('final')
      expect(controller.getState().lockedAnswer).toBe('')
      expect(controller.getState().answerOrigin).toBeNull()
      expect(controller.getState().candidateAnswer).toBe('2023年营收答案')
      expect(controller.getState().candidateRevision).toBe(1)
      expect(controller.getState().lockedQuestionRevision).toBe(2)
      expect(repository.turns).toEqual([])
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps partial final tokens private when final generation rejects', async () => {
    const { controller, asr, rag } = createController()
    rag.streamAnswer = async (input): ReturnType<RagRuntime['streamAnswer']> => {
      rag.answerCalls.push({ query: input.query, kind: input.kind })
      if (input.kind === 'final') {
        input.onToken('不可公开的半截答案')
        throw new Error('stream interrupted')
      }
      input.onToken('候选')
      return { references: [], retrievalRoute: 'source_document', refused: false }
    }
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '最终流式输出会失败的问题', 1)

    await dispatch(controller, { type: 'end_question' })

    expect(controller.getState().qaPhase).toBe('error')
    expect(controller.getState().lockedAnswer).toBe('')
    expect(controller.getState().answerOrigin).toBeNull()
    await controller.dispose()
  })

  it('does not persist a refused candidate as an answer version', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr, rag, repository } = createController()
      rag.refuse = true
      await dispatch(controller, { type: 'start_session' })
      asr.emit('final', '请问现有资料能否证明这个结论？', 1)
      await vi.runAllTimersAsync()

      expect(rag.answerCalls.filter((call) => call.kind === 'candidate')).toHaveLength(1)
      expect(repository.answerVersions).toEqual([])
      expect(controller.getState().candidateAnswer).toBe('')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not persist a refused final answer', async () => {
    const { controller, asr, rag, repository } = createController()
    rag.refuse = true
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '请问现有资料能否证明这个结论？', 1)

    await dispatch(controller, { type: 'end_question' })

    expect(controller.getState().qaPhase).toBe('error')
    expect(controller.getState().errorOperation).toBe('final')
    expect(repository.answerVersions).toEqual([])
    expect(repository.turns).toEqual([])
    await controller.dispose()
  })

  it('skips a failed question in the same session without writing a turn', async () => {
    const { controller, asr, rag, repository } = createController()
    rag.failFinalOnce = true
    await dispatch(controller, { type: 'start_session' })
    const sessionId = controller.getState().sessionId
    asr.emit('final', '本轮没有可用候选，需要跳过', 1)
    await dispatch(controller, { type: 'end_question' })
    expect(controller.getState().errorOperation).toBe('final')

    await controller.dispatch({ type: 'skip_question' })

    expect(controller.getState().qaPhase).toBe('listening')
    expect(controller.getState().sessionId).toBe(sessionId)
    expect(controller.getState().history).toEqual([])
    expect(controller.getState().finalSegments).toEqual([])
    expect(repository.turns).toEqual([])
    expect(repository.sessions).toHaveLength(1)
    expect(asr.starts).toBe(2)
    await controller.dispose()
  })

  it('atomically rejects skip and duplicate dismiss while error dismissal is ending the session', async () => {
    const { controller, audio, asr, rag, repository } = createController()
    rag.failFinalOnce = true
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '等待数据库收尾时不得重新开始的问题', 1)
    await dispatch(controller, { type: 'end_question' })
    expect(controller.getState().errorOperation).toBe('final')
    const startsBeforeDismiss = { audio: audio.starts, asr: asr.starts }
    const endGate = deferred()
    repository.endGate = endGate.promise

    const dismissing = dispatch(controller, { type: 'dismiss_error' })
    await vi.waitFor(() => expect(repository.ended).toHaveLength(1))
    await controller.dispatch({ type: 'skip_question' })
    await dispatch(controller, { type: 'dismiss_error' })

    expect(controller.getState().qaPhase).toBe('error')
    expect(audio.starts).toBe(startsBeforeDismiss.audio)
    expect(asr.starts).toBe(startsBeforeDismiss.asr)
    expect(repository.ended).toHaveLength(1)
    endGate.resolve()
    await dismissing

    expect(controller.getState().qaPhase).toBe('idle')
    expect(controller.getState().sessionId).toBeNull()
    expect(repository.turns).toEqual([])
    await controller.dispose()
  })

  it('atomically rejects retry while error dismissal is flushing a front snapshot', async () => {
    const { controller, audio, asr, rag, repository } = createController()
    const snapshotGate = deferred()
    const originalPersistSnapshot = repository.persistFrontSnapshot.bind(repository)
    repository.persistFrontSnapshot = async (input): Promise<void> => {
      await snapshotGate.promise
      await originalPersistSnapshot(input)
    }
    await dispatch(controller, { type: 'switch_mode', mode: 'front' })
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '等待快照刷盘时不得重新结构化的记录', 1)
    audio.fail('FATAL_CAPTURE', false)
    expect(controller.getState().errorOperation).toBe('front')

    const dismissing = dispatch(controller, { type: 'dismiss_error' })
    await Promise.resolve()
    await dispatch(controller, { type: 'retry' })

    expect(controller.getState().frontPhase).toBe('error')
    expect(rag.structureCalls).toBe(0)
    expect(repository.rawTranscripts).toEqual([])
    snapshotGate.resolve()
    await dismissing

    expect(controller.getState().frontPhase).toBe('idle')
    expect(repository.snapshots).toEqual(['等待快照刷盘时不得重新结构化的记录'])
    expect(rag.structureCalls).toBe(0)
    await controller.dispose()
  })

  it('persists raw front transcript before structure and indexing', async () => {
    const { controller, asr, repository } = createController()
    await dispatch(controller, { type: 'switch_mode', mode: 'front' })
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '演讲第一段。', 1)
    asr.finalUpdate = { sessionId: asr.sessionId, kind: 'final', text: '演讲最后一段。', sequence: 2 }
    await dispatch(controller, { type: 'stop_front' })
    expect(repository.rawTranscripts).toEqual(['演讲第一段。演讲最后一段。'])
    expect(repository.indexed[0]).toContain('演讲最后一段。')
    expect(repository.indexedProjects).toEqual(['project-test'])
    expect(controller.getState().frontPhase).toBe('complete')
    await dispatch(controller, { type: 'acknowledge_front_complete' })
    expect(controller.getState().frontPhase).toBe('idle')
    await controller.dispose()
  })

  it('makes duplicate boundary commands idempotent', async () => {
    const { controller, asr, rag } = createController()
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '只生成一次的问题', 1)
    await Promise.all([
      dispatch(controller, { type: 'end_question' }),
      dispatch(controller, { type: 'end_question' }),
    ])
    expect(asr.stops).toBe(1)
    expect(rag.answerCalls.filter((call) => call.kind === 'final')).toHaveLength(1)
    await controller.dispose()
  })

  it('ignores an old capture failure while QA audio stop is pending at the finalization boundary', async () => {
    const { controller, audio, asr } = createController()
    const stopGate = deferred()
    audio.stopGate = stopGate.promise
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '边界内不应被旧捕获失败覆盖的问题', 1)

    const finalizing = dispatch(controller, { type: 'end_question' })
    await vi.waitFor(() => expect(audio.stops).toBe(1))
    asr.fail('STALE_CAPTURE_FAILURE')
    expect(controller.getState().qaPhase).toBe('finalizing')
    stopGate.resolve()
    await finalizing

    expect(controller.getState().qaPhase).toBe('answer_locked')
    expect(controller.getState().error).toBeNull()
    await controller.dispose()
  })

  it('ignores an old capture failure while front audio stop is pending at the structure boundary', async () => {
    const { controller, audio, asr, repository } = createController()
    const stopGate = deferred()
    audio.stopGate = stopGate.promise
    await dispatch(controller, { type: 'switch_mode', mode: 'front' })
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '边界内不应被旧捕获失败覆盖的记录', 1)

    const structuring = dispatch(controller, { type: 'stop_front' })
    await vi.waitFor(() => expect(audio.stops).toBe(1))
    asr.fail('STALE_CAPTURE_FAILURE')
    expect(controller.getState().frontPhase).toBe('structuring')
    stopGate.resolve()
    await structuring

    expect(controller.getState().frontPhase).toBe('complete')
    expect(repository.ended.at(-1)?.status).toBe('complete')
    await dispatch(controller, { type: 'acknowledge_front_complete' })
    await controller.dispose()
  })

  it('reports stopAndFinalize rejection through only the boundary failure path', async () => {
    const { controller, asr, repository } = createController()
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '停止转写会失败的问题', 1)
    asr.stopError = Object.assign(new Error('finalize failed'), { code: 'FINALIZE_FAILED', retryable: true })

    await dispatch(controller, { type: 'end_question' })
    expect(controller.getState().qaPhase).toBe('error')
    expect(repository.ended).toEqual([])
    await dispatch(controller, { type: 'dismiss_error' })
    expect(repository.ended).toHaveLength(1)
    expect(repository.ended[0]?.status).toBe('failed')
    await controller.dispose()
  })

  it('ignores stop_session after the question has entered finalizing', async () => {
    const { controller, asr, rag, repository } = createController()
    const finalGate = deferred()
    const originalStreamAnswer = rag.streamAnswer.bind(rag)
    rag.streamAnswer = async (input): ReturnType<RagRuntime['streamAnswer']> => {
      if (input.kind !== 'final') return originalStreamAnswer(input)
      rag.answerCalls.push({ query: input.query, kind: input.kind })
      await finalGate.promise
      input.onToken('最终答案')
      return { references: [], retrievalRoute: 'source_document', refused: false }
    }
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '不能被停止撤销的问题', 1)

    const finalizing = dispatch(controller, { type: 'end_question' })
    await vi.waitFor(() => expect(controller.getState().qaPhase).toBe('finalizing'))
    await dispatch(controller, { type: 'stop_session' })
    expect(controller.getState().qaPhase).toBe('finalizing')
    expect(repository.ended).toEqual([])

    finalGate.resolve()
    await finalizing
    expect(controller.getState().qaPhase).toBe('answer_locked')
    await controller.dispose()
  })

  it('ignores stop_session after front processing has entered structuring', async () => {
    const { controller, asr, rag, repository } = createController()
    const structureGate = deferred()
    rag.structureTranscript = async (input): Promise<string> => {
      await structureGate.promise
      return `# 结构化记录\n\n${input.transcript}`
    }
    await dispatch(controller, { type: 'switch_mode', mode: 'front' })
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '不能被停止撤销的前置记录', 1)

    const structuring = dispatch(controller, { type: 'stop_front' })
    await vi.waitFor(() => expect(controller.getState().frontPhase).toBe('structuring'))
    await dispatch(controller, { type: 'stop_session' })
    expect(controller.getState().frontPhase).toBe('structuring')
    expect(repository.ended).toEqual([])

    structureGate.resolve()
    await structuring
    expect(controller.getState().frontPhase).toBe('complete')
    expect(repository.ended).toHaveLength(1)
    expect(repository.ended[0]?.status).toBe('complete')
    await dispatch(controller, { type: 'acknowledge_front_complete' })
    await controller.dispose()
  })

  it('returns to idle after stop_session even when ending the database session fails', async () => {
    const { controller, repository } = createController()
    await dispatch(controller, { type: 'start_session' })
    repository.failEnd = true

    await expect(dispatch(controller, { type: 'stop_session' })).resolves.toBeUndefined()
    expect(controller.getState().qaPhase).toBe('idle')
    expect(controller.getState().sessionId).toBeNull()
    expect(repository.ended[0]?.status).toBe('cancelled')
    await controller.dispose()
  })

  it('does not let empty ASR replacements reset the bounded recovery budget', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr } = createController()
      await dispatch(controller, { type: 'start_session' })

      asr.emit('partial', '', 1)
      asr.fail()
      await vi.advanceTimersByTimeAsync(251)
      expect(asr.starts).toBe(2)

      asr.emit('partial', '', 2)
      asr.fail()
      await vi.advanceTimersByTimeAsync(501)
      expect(asr.starts).toBe(3)

      asr.emit('partial', '', 3)
      asr.fail()
      expect(controller.getState().qaPhase).toBe('error')
      expect(asr.starts).toBe(3)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers from two retryable ASR start rejections before succeeding', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr } = createController()
      asr.startFailures = [
        Object.assign(new Error('first connect failure'), { code: 'SOCKET_ERROR', retryable: true }),
        Object.assign(new Error('second connect failure'), { code: 'CONNECT_TIMEOUT', retryable: true }),
      ]

      await dispatch(controller, { type: 'start_session' })
      expect(asr.starts).toBe(1)
      await vi.advanceTimersByTimeAsync(251)
      expect(asr.starts).toBe(2)
      await vi.advanceTimersByTimeAsync(501)

      expect(asr.starts).toBe(3)
      expect(controller.getState().qaPhase).toBe('listening')
      expect(controller.getState().error).toBeNull()
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails after the third consecutive retryable ASR start rejection', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr } = createController()
      asr.startFailures = [1, 2, 3].map((attempt) => Object.assign(
        new Error(`connect failure ${attempt}`),
        { code: 'SOCKET_ERROR', retryable: true },
      ))

      await dispatch(controller, { type: 'start_session' })
      await vi.advanceTimersByTimeAsync(251)
      await vi.advanceTimersByTimeAsync(501)

      expect(asr.starts).toBe(3)
      expect(controller.getState().qaPhase).toBe('error')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a stopped session cancelled when a pending capture start rejects late', async () => {
    const { controller, audio, repository } = createController()
    const startGate = deferred()
    audio.startGate = startGate.promise

    const starting = dispatch(controller, { type: 'start_session' })
    await vi.waitFor(() => expect(audio.starts).toBe(1))
    const sessionId = controller.getState().sessionId
    expect(sessionId).not.toBeNull()

    await dispatch(controller, { type: 'stop_session' })
    expect(controller.getState().qaPhase).toBe('idle')
    expect(repository.ended).toEqual([{ sessionId, status: 'cancelled' }])

    startGate.reject(new Error('late native start rejection'))
    await expect(starting).resolves.toBeUndefined()
    expect(controller.getState().qaPhase).toBe('idle')
    expect(controller.getState().error).toBeNull()
    expect(repository.ended).toEqual([{ sessionId, status: 'cancelled' }])
    await controller.dispose()
  })

  it('does not open ASR after a stopped permission preflight resolves late', async () => {
    const { controller, audio, asr, repository } = createController()
    const prepareGate = deferred()
    audio.prepare = async (source): Promise<void> => {
      audio.prepares += 1
      audio.source = source
      await prepareGate.promise
    }

    const starting = dispatch(controller, { type: 'start_session' })
    await vi.waitFor(() => expect(audio.prepares).toBe(1))
    const sessionId = controller.getState().sessionId
    await dispatch(controller, { type: 'stop_session' })
    prepareGate.resolve()
    await expect(starting).resolves.toBeUndefined()

    expect(asr.starts).toBe(0)
    expect(audio.starts).toBe(0)
    expect(controller.getState().qaPhase).toBe('idle')
    expect(repository.ended).toEqual([{ sessionId, status: 'cancelled' }])
    await controller.dispose()
  })

  it('bounds three consecutive retryable PCM write failures through two capture recoveries', async () => {
    vi.useFakeTimers()
    try {
      const { controller, audio, asr } = createController()
      await dispatch(controller, { type: 'start_session' })

      audio.fail('BACKPRESSURE', true)
      await vi.advanceTimersByTimeAsync(251)
      expect(audio.starts).toBe(2)
      expect(asr.starts).toBe(2)

      audio.fail('WRITE_FAILED', true)
      await vi.advanceTimersByTimeAsync(501)
      expect(audio.starts).toBe(3)
      expect(asr.starts).toBe(3)

      audio.fail('BACKPRESSURE', true)
      expect(controller.getState().qaPhase).toBe('error')
      expect(audio.starts).toBe(3)
      expect(asr.starts).toBe(3)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not swallow an immediate retryable failure from a replacement capture', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr } = createController()
      const originalStart = asr.start.bind(asr)
      asr.start = async (input): Promise<void> => {
        await originalStart(input)
        if (asr.starts === 2) input.onFailure('REPLACEMENT_FAILED_IMMEDIATELY', true)
      }
      await dispatch(controller, { type: 'start_session' })

      asr.fail('FIRST_CAPTURE_FAILED')
      await vi.advanceTimersByTimeAsync(251)
      expect(asr.starts).toBe(2)

      await vi.advanceTimersByTimeAsync(501)
      expect(asr.starts).toBe(3)
      expect(controller.getState().qaPhase).toBe('listening')
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts the continued transcript sequence after same-session ASR recovery', async () => {
    vi.useFakeTimers()
    try {
      const { controller, asr } = createController()
      await dispatch(controller, { type: 'start_session' })
      asr.emit('final', '恢复前第一段。', 1)
      asr.emit('partial', '恢复前临时段', 2)
      asr.fail('RETRYABLE_ASR_FAILURE')
      await vi.advanceTimersByTimeAsync(251)

      asr.emit('final', '恢复后第三段。', 3)
      expect(controller.getState().lastTranscriptSequence).toBe(3)
      expect(controller.getState().finalSegments).toEqual(['恢复前第一段。', '恢复后第三段。'])
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons a final-answer error and closes its session', async () => {
    const { controller, audio, asr, rag, repository } = createController()
    rag.failFinalOnce = true
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '生成失败后放弃的问题', 1)
    await dispatch(controller, { type: 'end_question' })
    expect(controller.getState().qaPhase).toBe('error')
    const abortsBefore = { audio: audio.aborts, asr: asr.aborts }

    await dispatch(controller, { type: 'dismiss_error' })
    expect(controller.getState().qaPhase).toBe('idle')
    expect(controller.getState().sessionId).toBeNull()
    expect(repository.ended.at(-1)?.status).toBe('failed')
    expect(audio.aborts).toBeGreaterThan(abortsBefore.audio)
    expect(asr.aborts).toBeGreaterThan(abortsBefore.asr)
    await controller.dispose()
  })

  it('abandons a front-structure error without retaining a split session', async () => {
    const { controller, asr, rag, repository } = createController()
    rag.failStructureOnce = true
    await dispatch(controller, { type: 'switch_mode', mode: 'front' })
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '需要保留的前置原始记录', 1)
    await dispatch(controller, { type: 'stop_front' })
    expect(controller.getState().frontPhase).toBe('error')

    await dispatch(controller, { type: 'dismiss_error' })
    expect(controller.getState().frontPhase).toBe('idle')
    expect(repository.snapshots).toContain('需要保留的前置原始记录')
    expect(repository.ended.at(-1)?.status).toBe('failed')
    await controller.dispose()
  })

  it('abandons a commit error and clears the failed session', async () => {
    const { controller, asr, repository } = createController()
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '保存会失败的问题', 1)
    await dispatch(controller, { type: 'end_question' })
    repository.failSaveOnce = true
    await dispatch(controller, { type: 'end_answer' })
    expect(controller.getState().qaPhase).toBe('error')

    await dispatch(controller, { type: 'dismiss_error' })
    expect(controller.getState().qaPhase).toBe('idle')
    expect(controller.getState().sessionId).toBeNull()
    expect(repository.ended.at(-1)?.status).toBe('failed')
    await controller.dispose()
  })

  it('flushes a pending front snapshot and resets UI after capture and database failures', async () => {
    const { controller, audio, asr, repository } = createController()
    const snapshotGate = deferred()
    const originalPersistSnapshot = repository.persistFrontSnapshot.bind(repository)
    repository.persistFrontSnapshot = async (input): Promise<void> => {
      await snapshotGate.promise
      await originalPersistSnapshot(input)
    }
    await dispatch(controller, { type: 'switch_mode', mode: 'front' })
    await dispatch(controller, { type: 'start_session' })
    asr.emit('final', '捕获失败前必须落库的快照', 1)
    audio.fail('FATAL_CAPTURE', false)
    repository.failEnd = true
    expect(controller.getState().frontPhase).toBe('error')

    let dismissed = false
    const dismissing = dispatch(controller, { type: 'dismiss_error' }).then(() => { dismissed = true })
    await Promise.resolve()
    expect(dismissed).toBe(false)
    snapshotGate.resolve()
    await dismissing

    expect(repository.snapshots).toEqual(['捕获失败前必须落库的快照'])
    expect(repository.ended.at(-1)?.status).toBe('failed')
    expect(controller.getState().frontPhase).toBe('idle')
    expect(controller.getState().error).toBeNull()
    await controller.dispose()
  })

  it('closes a non-retryable failed capture before retry begins a new session', async () => {
    const { controller, audio, repository } = createController()
    await dispatch(controller, { type: 'start_session' })
    const oldSessionId = controller.getState().sessionId!
    audio.fail('FATAL_CAPTURE', false)
    expect(controller.getState().qaPhase).toBe('error')

    await dispatch(controller, { type: 'retry' })
    const newSessionId = controller.getState().sessionId!
    expect(newSessionId).not.toBe(oldSessionId)
    expect(repository.operations.indexOf(`end:${oldSessionId}:failed`)).toBeLessThan(
      repository.operations.indexOf(`begin:${newSessionId}`),
    )
    expect(controller.getState().qaPhase).toBe('listening')
    await controller.dispose()
  })

  it('closes a recovery-exhausted capture before retry and survives end-session failure', async () => {
    vi.useFakeTimers()
    try {
      const { controller, audio, repository } = createController()
      await dispatch(controller, { type: 'start_session' })
      const oldSessionId = controller.getState().sessionId!
      audio.fail('BACKPRESSURE', true)
      await vi.advanceTimersByTimeAsync(251)
      audio.fail('BACKPRESSURE', true)
      await vi.advanceTimersByTimeAsync(501)
      audio.fail('BACKPRESSURE', true)
      expect(controller.getState().qaPhase).toBe('error')
      repository.failEnd = true

      await dispatch(controller, { type: 'retry' })
      expect(repository.operations).toContain(`end:${oldSessionId}:failed`)
      expect(controller.getState().qaPhase).toBe('listening')
      expect(controller.getState().sessionId).not.toBe(oldSessionId)
      expect(repository.sessions).toHaveLength(2)
      await controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
