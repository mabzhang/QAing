import { describe, expect, it, vi } from 'vitest'
import {
  CandidateTaskCoordinator,
  isAnswerableQuestion,
  isMaterialQuestionChange,
  normalizeCheckpointQuestion,
  type RevisionedQuery,
} from './task-coordinator'

function query(text: string, revision: number, isFinal = false): RevisionedQuery {
  return { sessionId: 'session-1', revision, text, isFinal }
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolvePromise: ((value: T) => void) | undefined
  let rejectPromise: ((error: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  }
}

describe('semantic checkpoint classification', () => {
  it('accepts complete short question slots and normal requests', () => {
    expect(isAnswerableQuestion('多少钱')).toBe(true)
    expect(isAnswerableQuestion('预算呢')).toBe(true)
    expect(isAnswerableQuestion('支持吗')).toBe(true)
    expect(isAnswerableQuestion('请介绍一下公司去年的收入')).toBe(true)
  })

  it('rejects dangling connectors and self-correction tails', () => {
    expect(isAnswerableQuestion('请问贵公司的')).toBe(false)
    expect(isAnswerableQuestion('不对我是说')).toBe(false)
    expect(isAnswerableQuestion('如果这个项目因为')).toBe(false)
    expect(isAnswerableQuestion('我们正在分析这个项目')).toBe(false)
    expect(isAnswerableQuestion('请问贵公司的预算是')).toBe(false)
    expect(isAnswerableQuestion('请问这个项目如果可以')).toBe(false)
    expect(isAnswerableQuestion('我们正在讨论如何提高销量')).toBe(false)
    expect(isAnswerableQuestion('我们正在讨论这个项目如何提高销量')).toBe(false)
    expect(isAnswerableQuestion('我们正在讨论项目呢')).toBe(false)
    expect(isAnswerableQuestion('今天我们正在讨论如何提高销量')).toBe(false)
    expect(isAnswerableQuestion('目前团队正在研究为什么项目延期')).toBe(false)
    expect(isAnswerableQuestion('接下来大家会讨论项目怎么推进')).toBe(false)
    expect(isAnswerableQuestion('这部分主要说明项目如何推进')).toBe(false)
    expect(isAnswerableQuestion('我不知道为什么项目延期')).toBe(false)
    expect(isAnswerableQuestion('我不知道这个项目为什么延期')).toBe(false)
    expect(isAnswerableQuestion('如何提高销量？')).toBe(true)
    expect(isAnswerableQuestion('请分析项目为什么延期')).toBe(true)
    expect(isAnswerableQuestion('请分析我们讨论的项目如何提高销量')).toBe(true)
  })

  it('normalizes punctuation and filler while retaining substantive negation', () => {
    expect(normalizeCheckpointQuestion('嗯，请问预算是多少？')).toBe('预算是多少')
    expect(normalizeCheckpointQuestion('请问预算是多少呢')).toBe('预算是多少')
    expect(normalizeCheckpointQuestion('不是营收，是净利润')).toBe('不是营收,是净利润')
  })

  it('treats critical slots as material but ignores filler and punctuation', () => {
    expect(isMaterialQuestionChange('请问2023年营收是多少？', '不是营收，请问2024年净利润是多少？')).toBe(true)
    expect(isMaterialQuestionChange('请问A公司预算多少', '请问B公司预算多少')).toBe(true)
    expect(isMaterialQuestionChange('预算是多少？', '嗯，请问预算是多少？！')).toBe(false)
    expect(isMaterialQuestionChange('预算是多少？', '请问预算是多少呢')).toBe(false)
    expect(isMaterialQuestionChange('请问项目预算是多少？', '这个项目预算有多少？')).toBe(false)
    expect(isMaterialQuestionChange('请问项目预算是多少？', '想了解项目预算的数额？')).toBe(false)
    expect(isMaterialQuestionChange('如何控制项目风险？', '项目风险怎么控制？')).toBe(false)
    expect(isMaterialQuestionChange('项目负责人是谁？', '谁负责这个项目？')).toBe(false)
    expect(isMaterialQuestionChange('甲方如何管理乙方？', '乙方如何管理甲方？')).toBe(true)
    expect(isMaterialQuestionChange('华为如何对比小米？', '小米如何对比华为？')).toBe(true)
    expect(isMaterialQuestionChange('甲方如何影响乙方？', '乙方如何影响甲方？')).toBe(true)
    expect(isMaterialQuestionChange('A如何依赖B？', 'B如何依赖A？')).toBe(true)
    expect(isMaterialQuestionChange('品牌如何吸引消费者？', '消费者如何吸引品牌？')).toBe(true)
    expect(isMaterialQuestionChange('甲方对乙方有什么影响？', '乙方对甲方有什么影响？')).toBe(true)
    expect(isMaterialQuestionChange('甲方向乙方提供什么服务？', '乙方向甲方提供什么服务？')).toBe(true)
    expect(isMaterialQuestionChange('甲方是否对乙方负责？', '乙方是否对甲方负责？')).toBe(true)
    expect(isMaterialQuestionChange('A依赖B吗？', 'B依赖A吗？')).toBe(true)
    expect(isMaterialQuestionChange('总部支持门店吗？', '门店支持总部吗？')).toBe(true)
    expect(isMaterialQuestionChange('甲方给乙方提供什么？', '乙方给甲方提供什么？')).toBe(true)
    expect(isMaterialQuestionChange('甲方为乙方承担什么责任？', '乙方为甲方承担什么责任？')).toBe(true)
    expect(isMaterialQuestionChange('甲方从乙方采购什么？', '乙方从甲方采购什么？')).toBe(true)
    expect(isMaterialQuestionChange('甲方跟乙方签什么合同？', '乙方跟甲方签什么合同？')).toBe(true)
    expect(isMaterialQuestionChange('什么由甲方提供给乙方？', '什么由乙方提供给甲方？')).toBe(true)
    expect(isMaterialQuestionChange('甲方负责乙方哪些事项？', '乙方负责甲方哪些事项？')).toBe(true)
    expect(isMaterialQuestionChange('甲方影响乙方哪些业务？', '乙方影响甲方哪些业务？')).toBe(true)
    expect(isMaterialQuestionChange('总部支持门店哪些工作？', '门店支持总部哪些工作？')).toBe(true)
    expect(isMaterialQuestionChange('A与B有什么区别？', 'B与A有什么区别？')).toBe(false)
    expect(isMaterialQuestionChange('项目预算是多少？', '项目含税预算是多少？')).toBe(true)
    expect(isMaterialQuestionChange('北京项目的预算是多少？', '上海项目的预算是多少？')).toBe(true)
    expect(isMaterialQuestionChange('项目会延期吗？', '项目不延期吗？')).toBe(true)
    expect(isMaterialQuestionChange('华为项目预算是多少？', '小米项目预算是多少？')).toBe(true)
    expect(isMaterialQuestionChange('腾讯公司去年收入是多少？', '阿里公司去年收入是多少？')).toBe(true)
    expect(isMaterialQuestionChange('华为去年收入', '小米去年收入')).toBe(true)
    expect(isMaterialQuestionChange('苹果预算', '谷歌预算')).toBe(true)
    expect(isMaterialQuestionChange('甲方预算', '乙方预算')).toBe(true)
    expect(isMaterialQuestionChange('产品A价格', '产品B价格')).toBe(true)
    expect(isMaterialQuestionChange('请分析华为项目预算是多少？', '请评估华为项目预算是多少？')).toBe(false)
    expect(isMaterialQuestionChange('请介绍一下公司去年的收入是多少？', '请说明公司去年收入是多少？')).toBe(false)
    expect(isMaterialQuestionChange('麻烦你介绍一下华为项目预算', '请说明华为项目预算')).toBe(false)
    expect(isMaterialQuestionChange('请分析一下腾讯公司风险', '请评估腾讯公司风险')).toBe(false)
    expect(isMaterialQuestionChange('分析报告结论', '评估报告结论')).toBe(true)
    expect(isMaterialQuestionChange('说明书版本', '书版本')).toBe(true)
    expect(isMaterialQuestionChange('分析部门预算', '评估部门预算')).toBe(true)
  })
})

describe('CandidateTaskCoordinator', () => {
  it('coalesces rapid semantic revisions into the latest query after the quiet period', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn(async (value: RevisionedQuery) => value.text)
      const accepted = vi.fn()
      const onResult = vi.fn()
      const coordinator = new CandidateTaskCoordinator({ execute, onAccepted: accepted, onResult })

      expect(coordinator.submit(query('请介绍一下公司收入', 1))).toBe(true)
      expect(coordinator.submit(query('请介绍一下公司收入和利润', 2))).toBe(true)
      expect(coordinator.submit(query('请介绍一下公司收入和净利润情况', 3))).toBe(true)
      await vi.advanceTimersByTimeAsync(449)
      expect(execute).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute.mock.calls[0]?.[0].revision).toBe(3)
      expect(accepted).toHaveBeenCalledTimes(3)
      await Promise.resolve()
      expect(onResult.mock.calls[0]?.[2]).toBe('请介绍一下公司收入和净利润情况')
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts an ASR final checkpoint without the quiet delay', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn(async () => 'ok')
      const coordinator = new CandidateTaskCoordinator({ execute, onResult: vi.fn() })
      coordinator.submit(query('请问今年净利润是多少？', 1, true))
      await vi.advanceTimersByTimeAsync(0)
      expect(execute).toHaveBeenCalledTimes(1)
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the active complete checkpoint finish and keeps only the latest pending revision', async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<string>()
      const second = deferred<string>()
      const execute = vi.fn((value: RevisionedQuery) => value.revision === 1 ? first.promise : second.promise)
      const onResult = vi.fn()
      const coordinator = new CandidateTaskCoordinator(
        { execute, onResult },
        { minStartIntervalMs: 0 },
      )

      coordinator.submit(query('请问2023年营收是多少？', 1, true))
      await vi.advanceTimersByTimeAsync(0)
      coordinator.submit(query('不是营收，请问2024年利润是多少？', 2, true))
      coordinator.submit(query('不是营收，请问2024年净利润是多少？', 3, true))
      await vi.advanceTimersByTimeAsync(0)
      expect(execute).toHaveBeenCalledTimes(1)

      first.resolve('v1')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(onResult.mock.calls[0]?.[2]).toBe('v1')
      expect(execute).toHaveBeenCalledTimes(2)
      expect(execute.mock.calls[1]?.[0].revision).toBe(3)

      second.resolve('v3')
      await Promise.resolve()
      expect(onResult).toHaveBeenCalledTimes(2)
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes one active request against the latest equivalent ASR revision', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<string>()
      const execute = vi.fn(() => gate.promise)
      const onResult = vi.fn()
      const coordinator = new CandidateTaskCoordinator(
        { execute, onResult },
        { minStartIntervalMs: 0 },
      )

      coordinator.submit(query('请问项目预算是多少？', 1, true))
      await vi.advanceTimersByTimeAsync(0)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(coordinator.submit(query('请问项目预算是多少？', 2, true))).toBe(false)

      gate.resolve('answer')
      await Promise.resolve()

      expect(onResult).toHaveBeenCalledTimes(1)
      expect(onResult.mock.calls[0]?.[1]).toMatchObject({ revision: 2 })
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not accept punctuation or filler-only revisions', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn(async () => 'ok')
      const coordinator = new CandidateTaskCoordinator({ execute, onResult: vi.fn() }, { minStartIntervalMs: 0 })
      expect(coordinator.submit(query('请问预算是多少？', 1, true))).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      expect(coordinator.submit(query('嗯，请问预算是多少？！', 2, true))).toBe(false)
      expect(coordinator.submit(query('请问预算是多少呢', 3, true))).toBe(false)
      await vi.runAllTimersAsync()
      expect(execute).toHaveBeenCalledTimes(1)
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('enforces the bounded start interval after an active task settles', async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<string>()
      const execute = vi.fn((value: RevisionedQuery) => value.revision === 1 ? first.promise : Promise.resolve('v2'))
      const coordinator = new CandidateTaskCoordinator({ execute, onResult: vi.fn() })
      coordinator.submit(query('请问2023年营收是多少？', 1, true))
      await vi.advanceTimersByTimeAsync(0)
      coordinator.submit(query('请问2024年净利润是多少？', 2, true))
      first.resolve('v1')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1_999)
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(execute).toHaveBeenCalledTimes(2)
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries one transient failure for the same semantic checkpoint after the cooldown', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce('recovered')
      const onResult = vi.fn()
      const onError = vi.fn()
      const coordinator = new CandidateTaskCoordinator({ execute, onResult, onError })

      coordinator.submit(query('请问项目预算是多少？', 1, true))
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      expect(onError).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(execute).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(execute).toHaveBeenCalledTimes(2)
      expect(onResult.mock.calls[0]?.[2]).toBe('recovered')
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds continuous failures to one retry and does not spin', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn(async () => { throw new Error('persistent') })
      const onError = vi.fn()
      const coordinator = new CandidateTaskCoordinator({ execute, onResult: vi.fn(), onError })
      coordinator.submit(query('请问项目进度如何？', 1, true))
      await vi.runAllTimersAsync()
      expect(execute).toHaveBeenCalledTimes(2)
      expect(onError).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels active work without surfacing abort as an error', async () => {
    vi.useFakeTimers()
    try {
      const onError = vi.fn()
      const onResult = vi.fn()
      const execute = vi.fn(async (_value: RevisionedQuery, signal: AbortSignal) => {
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
        return 'never'
      })
      const coordinator = new CandidateTaskCoordinator({ execute, onResult, onError })
      coordinator.submit(query('这个项目的预算是多少？', 1, true))
      await vi.advanceTimersByTimeAsync(0)
      coordinator.cancel()
      await Promise.resolve()
      expect(onResult).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
