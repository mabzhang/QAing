import {
  DeepSeekClientError,
  DeepSeekStreamingClient,
  type DeepSeekMessage,
} from '../rag/deepseek-client'
import { SimulationProviderError } from './errors'
import type {
  QaCoverageSlot,
  QaSimulationBrief,
  QaSlotEvidence,
  SimulationProviderPort,
  SimulationProjectFence,
} from './types'

const DEFAULT_MAX_TOKENS = 8_192
const MAX_PROMPT_CHARACTERS = 120_000
const MAX_EXCERPT_CHARACTERS = 8_000

interface DeepSeekSimulationProviderOptions {
  readonly getApiKey: () => string | null | Promise<string | null>
  readonly client?: DeepSeekStreamingClient
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly maxResponseCharacters?: number
  readonly maxTokens?: number
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum)
}

function briefPayload(brief: QaSimulationBrief): object {
  return {
    intervieweeIdentity: brief.intervieweeIdentity,
    audience: brief.audience,
    focusTopics: brief.focusTopics,
    scenario: brief.scenario,
    answerStyle: brief.answerStyle,
    excludedTopics: brief.excludedTopics,
  }
}

function evidencePayload(evidence: readonly QaSlotEvidence[]): readonly object[] {
  return evidence.map((bundle) => ({
    slotId: bundle.slotId,
    evidence: bundle.evidence.map((entry) => ({
      sourceId: entry.reference.sourceId,
      sourceRevisionId: entry.reference.sourceRevisionId,
      documentId: entry.reference.documentId,
      chunkId: entry.reference.chunkId,
      contentHash: entry.reference.contentHash,
      title: entry.title,
      excerpt: bounded(entry.excerpt, MAX_EXCERPT_CHARACTERS),
    })),
  }))
}

function userPayload(
  fence: SimulationProjectFence,
  brief: QaSimulationBrief,
  slots: readonly QaCoverageSlot[],
  evidence: readonly QaSlotEvidence[],
): string {
  return JSON.stringify({
    projectFence: fence,
    brief: briefPayload(brief),
    coverageSlots: slots,
    evidence: evidencePayload(evidence),
  })
}

function messages(input: Parameters<SimulationProviderPort['generateBatch']>[0]): readonly DeepSeekMessage[] {
  const payload = userPayload(input.fence, input.brief, input.slots, input.evidence)
  if (payload.length > MAX_PROMPT_CHARACTERS) throw new SimulationProviderError('PROMPT_TOO_LARGE', false)
  return [
    {
      role: 'system',
      content: [
        '你是QAing受控模拟问答生成器。只基于输入evidence回答，不使用外部知识。',
        '必须输出一个严格JSON对象，不得输出Markdown围栏、解释或额外字段。',
        'Schema: {"items":[{"slotId":"...","question":"...","answer":"...","sourceReferences":[{"sourceId":"...|null","sourceRevisionId":"...|null","documentId":"...","chunkId":"...","contentHash":"64位小写sha256"}]}]}。',
        '每个有充分证据的coverageSlots最多返回一条；资料不足则省略该slot，禁止编造。',
        'brief.excludedTopics中的主题不得出现在问题或答案；无法避开时省略对应slot。',
        'sourceReferences只能逐字复制对应slot提供的引用。答案中的主体、数字、年份、否定和指标必须被引用正文支持。',
      ].join('\n'),
    },
    { role: 'user', content: payload },
  ]
}

function providerError(error: unknown): SimulationProviderError {
  if (error instanceof SimulationProviderError) return error
  if (error instanceof DeepSeekClientError) return new SimulationProviderError(error.code, error.retryable)
  return new SimulationProviderError('PROVIDER_FAILED', false)
}

export class DeepSeekSimulationProvider implements SimulationProviderPort {
  readonly #getApiKey: DeepSeekSimulationProviderOptions['getApiKey']
  readonly #client: DeepSeekStreamingClient
  readonly #maxTokens: number

  constructor(options: DeepSeekSimulationProviderOptions) {
    this.#getApiKey = options.getApiKey
    this.#client = options.client ?? new DeepSeekStreamingClient({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxResponseCharacters === undefined ? {} : { maxResponseCharacters: options.maxResponseCharacters }),
    })
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    if (!Number.isSafeInteger(this.#maxTokens) || this.#maxTokens < 1 || this.#maxTokens > DEFAULT_MAX_TOKENS) {
      throw new SimulationProviderError('INVALID_CONFIGURATION', false)
    }
  }

  async generateBatch(input: Parameters<SimulationProviderPort['generateBatch']>[0]): Promise<{
    readonly rawJson: string
  }> {
    const apiKey = await this.#getApiKey()
    if (!apiKey?.trim()) throw new SimulationProviderError('PROVIDER_NOT_CONFIGURED', false)
    try {
      const result = await this.#client.generate({
        requestKey: `qaing-simulation:${input.operationId}`,
        generationId: input.generation,
        apiKey,
        messages: messages(input),
        signal: input.signal,
        maxTokens: this.#maxTokens,
      })
      // DeepSeekStreamingClient accumulates the stream privately and enforces
      // the configured character limit before this complete JSON is returned.
      return { rawJson: result.content }
    } catch (error) {
      throw providerError(error)
    }
  }
}
