import { describe, expect, it } from 'vitest'
import { DataStore } from './database'
import {
  importStructuredQa,
  importStructuredQaBatch,
  MarkdownQaParseError,
  parseStructuredQa,
} from './importers'

function expectMarkdownError(
  source: string,
  expected: { readonly code: MarkdownQaParseError['code']; readonly line: number },
): void {
  try {
    parseStructuredQa(source, 'markdown')
    throw new Error('Expected Markdown QA parsing to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(MarkdownQaParseError)
    expect(error).toMatchObject(expected)
    expect((error as Error).message).toContain(`line ${expected.line}`)
  }
}

describe('strict Markdown QA import', () => {
  it('parses BOM, CRLF, bilingual records, multiline answers, and fenced fake headings without guessing', () => {
    const markdown = [
      '\uFEFF## 问题：如何申请退款？',
      '',
      '### 答案',
      '第一段。',
      '',
      '- 准备订单号',
      '- 联系客服',
      '',
      '```markdown',
      '## 问题：这是代码块内文字，不是新记录',
      '### 答案',
      '```',
      '',
      '## Question:How long is the warranty?',
      '### Answer',
      'One year.',
      '',
    ].join('\r\n')

    expect(parseStructuredQa(markdown, 'markdown')).toEqual([
      {
        question: '如何申请退款？',
        answer: [
          '第一段。',
          '',
          '- 准备订单号',
          '- 联系客服',
          '',
          '```markdown',
          '## 问题：这是代码块内文字，不是新记录',
          '### 答案',
          '```',
        ].join('\n'),
      },
      { question: 'How long is the warranty?', answer: 'One year.' },
    ])
  })

  it('fails closed with stable line numbers for prose, incomplete records, and ambiguous headings', () => {
    expectMarkdownError('\uFEFF  \n\t', { code: 'EXPECTED_QUESTION', line: 1 })
    expectMarkdownError('# 普通资料\n\n## 问题：退款？\n### 答案\n七天', {
      code: 'EXPECTED_PREAMBLE_SEPARATOR',
      line: 3,
    })
    expectMarkdownError('## 问题：\n### 答案\n答案', { code: 'EMPTY_QUESTION', line: 1 })
    expectMarkdownError('## Question:Valid?\nanswer prose', { code: 'EXPECTED_ANSWER', line: 2 })
    expectMarkdownError('## Question:Valid?\n### Answer\n\n', { code: 'EMPTY_ANSWER', line: 2 })
    expectMarkdownError('## Question:Valid?\n### Answer\nFirst\n### Answer\nSecond', {
      code: 'DUPLICATE_ANSWER',
      line: 4,
    })
    expectMarkdownError('## Question:Valid?\n### Answer\nFirst\n  ### Answer\nSecond', {
      code: 'DUPLICATE_ANSWER',
      line: 4,
    })
    expectMarkdownError('## Question:Valid?\n### Answer\nFirst\n## Notes\nSecond', {
      code: 'UNEXPECTED_HEADING',
      line: 4,
    })
    expectMarkdownError('## Question:Valid?\n### Answer\nFirst\n  ## Question:Indented is not part of the grammar\nSecond', {
      code: 'UNEXPECTED_HEADING',
      line: 4,
    })
    expectMarkdownError('## Question:Valid?\n### Answer\n```ts\nconst value = 1', {
      code: 'UNCLOSED_FENCE',
      line: 3,
    })
  })

  it('deduplicates identical fragments and reports the second conflicting question line', () => {
    const identical = [
      '## 问题：保修多久？',
      '### 答案',
      '一年。',
      '',
      '## Question:保修多久?',
      '### Answer',
      '一年。',
    ].join('\n')
    expect(parseStructuredQa(identical, 'markdown')).toEqual([{ question: '保修多久？', answer: '一年。' }])

    expectMarkdownError(identical.replace(/一年。$/u, '两年。'), {
      code: 'CONFLICTING_QUESTION',
      line: 5,
    })
  })

  it('parses the explicit categorized bold-numbered review grammar without reading prose heuristically', () => {
    const markdown = [
      '\uFEFF# 模拟评审 QA 汇总',
      '',
      '> 版本：内部评审',
      '> 用途：预设问答',
      '---',
      '',
      '## 产品与服务',
      '',
      '**1. 如何申请退款？**',
      '回答：先准备订单号。',
      '',
      '- 联系客服',
      '- 说明原因',
      '',
      '```markdown',
      '---',
      '## 代码块中的标题',
      '```',
      '---',
      '',
      '**2. 保修期限是多久？**',
      '回答：一年。',
      '---',
      '',
      '## 交付',
      '**1. 如何获取文档？**',
      '回答：在客户端下载。',
    ].join('\r\n')

    expect(parseStructuredQa(markdown, 'markdown')).toEqual([
      {
        question: '如何申请退款？',
        answer: [
          '先准备订单号。',
          '',
          '- 联系客服',
          '- 说明原因',
          '',
          '```markdown',
          '---',
          '## 代码块中的标题',
          '```',
        ].join('\n'),
      },
      { question: '保修期限是多久？', answer: '一年。' },
      { question: '如何获取文档？', answer: '在客户端下载。' },
    ])
  })

  it('fails closed on incomplete or mixed bold-numbered documents with exact lines', () => {
    expectMarkdownError('**1. 缺少分类？**\n回答：否', { code: 'EXPECTED_CATEGORY', line: 1 })
    expectMarkdownError('# 标题\n导语\n---\n## 分类\n**1. 问题？**\n回答：答案', {
      code: 'INVALID_PREAMBLE',
      line: 2,
    })
    expectMarkdownError('# 标题\n# 重复标题\n---\n## 分类\n**1. 问题？**\n回答：答案', {
      code: 'DUPLICATE_TITLE',
      line: 2,
    })
    expectMarkdownError('# 标题\n> 元数据\n## 分类\n**1. 问题？**\n回答：答案', {
      code: 'EXPECTED_PREAMBLE_SEPARATOR',
      line: 3,
    })
    expectMarkdownError('# \n---\n## 分类\n**1. 问题？**\n回答：答案', {
      code: 'INVALID_PREAMBLE',
      line: 1,
    })
    expectMarkdownError('# 标题\n>   \n---\n## 分类\n**1. 问题？**\n回答：答案', {
      code: 'INVALID_PREAMBLE',
      line: 2,
    })
    expectMarkdownError('# 标题\n> 元数据\n---\n---\n## 分类\n**1. 问题？**\n回答：答案', {
      code: 'EXPECTED_CATEGORY',
      line: 4,
    })
    expectMarkdownError('## \n**1. 问题？**\n回答：答案', { code: 'EMPTY_CATEGORY', line: 1 })
    expectMarkdownError('## 分类\n普通加粗文本', { code: 'EXPECTED_NUMBERED_QUESTION', line: 2 })
    expectMarkdownError('## 分类\n**1. 问题？**\n回答：', { code: 'EMPTY_ANSWER', line: 3 })
    expectMarkdownError('## 分类\n**1. 问题？**\n回答：答案\n**2. 新问题？**\n回答：新答案', {
      code: 'EXPECTED_SEPARATOR',
      line: 4,
    })
    expectMarkdownError('## 分类\n**1. 问题？**\n回答：答案\n  ## 下一分类\n**1. 新问题？**\n回答：新答案', {
      code: 'EXPECTED_SEPARATOR',
      line: 4,
    })
    expectMarkdownError('## 分类\n**1. 问题？**\n回答：答案\n  **2. 新问题？**\n回答：新答案', {
      code: 'EXPECTED_SEPARATOR',
      line: 4,
    })
    expectMarkdownError('## 分类\n**1. 问题？**\n回答：答案\n回答：重复答案', {
      code: 'DUPLICATE_ANSWER',
      line: 4,
    })
    expectMarkdownError('## 分类\n**1. 问题？**\n回答：答案\n### 答案\n混用答案', {
      code: 'UNEXPECTED_HEADING',
      line: 4,
    })
    expectMarkdownError('## 分类\n**1. 问题？**\n回答：答案\n---\n## Question:Mixed?', {
      code: 'UNEXPECTED_HEADING',
      line: 5,
    })
    expectMarkdownError('## 空分类\n## 下一分类\n**1. 问题？**\n回答：答案', {
      code: 'EXPECTED_NUMBERED_QUESTION',
      line: 1,
    })
    expectMarkdownError([
      '## 分类',
      '**1. 保修多久？**',
      '回答：一年。',
      '---',
      '**2. 保修多久?**',
      '回答：两年。',
    ].join('\n'), { code: 'CONFLICTING_QUESTION', line: 5 })
  })

  it('keeps mixed-format batch imports all-or-none when a later Markdown source is malformed', () => {
    const store = new DataStore(':memory:')
    try {
      importStructuredQa(store, '[{"question":"已有问题？","answer":"已有答案"}]', 'json', 1)
      const before = store.listPresetQa().map(({ question, answer, contentHash }) => ({ question, answer, contentHash }))

      expect(() => importStructuredQaBatch(store, [
        {
          format: 'markdown',
          rawContent: '## 问题：新问题？\n### 答案\n新答案',
        },
        {
          format: 'markdown',
          rawContent: '## Question:Broken?\nThis line appears before the answer heading.',
        },
      ], 2)).toThrow(MarkdownQaParseError)

      expect(store.listPresetQa().map(({ question, answer, contentHash }) => ({ question, answer, contentHash }))).toEqual(before)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('commits every parsed Markdown fragment and its index job in one successful batch', () => {
    const store = new DataStore(':memory:')
    try {
      const result = importStructuredQaBatch(store, [
        {
          format: 'markdown',
          rawContent: '## 问题：保修期限？\n### 答案\n一年。',
        },
        {
          format: 'markdown',
          rawContent: '## Question:Can it be returned?\n### Answer\nWithin seven days.',
        },
      ], 10)

      expect(result).toHaveLength(2)
      expect(store.listPresetQa().map(({ question, answer }) => ({ question, answer }))).toEqual(expect.arrayContaining([
        { question: 'Can it be returned?', answer: 'Within seven days.' },
        { question: '保修期限？', answer: '一年。' },
      ]))
      expect(store.listIndexJobs()).toEqual([
        expect.objectContaining({ ownerType: 'preset_qa', status: 'pending' }),
        expect.objectContaining({ ownerType: 'preset_qa', status: 'pending' }),
      ])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('rejects cross-file answer conflicts before opening the batch transaction', () => {
    const store = new DataStore(':memory:')
    try {
      expect(() => importStructuredQaBatch(store, [
        {
          format: 'json',
          rawContent: '[{"question":"如何退款？","answer":"联系客服"}]',
        },
        {
          format: 'markdown',
          rawContent: '## Question:如何退款?\n### Answer\n直接拒绝',
        },
      ])).toThrow(/conflicting/)
      expect(store.listPresetQa()).toEqual([])
      expect(store.listIndexJobs()).toEqual([])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('does not silently overwrite an existing reviewed answer during a batch import', () => {
    const store = new DataStore(':memory:')
    try {
      importStructuredQa(store, '[{"question":"已审核问题？","answer":"原已审核答案。"}]', 'json', 1)
      expect(() => importStructuredQaBatch(store, [{
        format: 'markdown',
        rawContent: '## 问题：已审核问题？\n### 答案\n新但未审核的答案。',
      }], 2)).toThrow(/conflicts with an existing answer/i)
      expect(store.listPresetQa().map(({ answer }) => answer)).toEqual(['原已审核答案。'])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })
})
