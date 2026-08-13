import { describe, expect, it } from 'vitest'
import {
  MarkdownQaParseError,
  parseStructuredQaDocument,
  type MarkdownQaParseErrorCode,
} from './importers'

const SYNTHETIC_REPORT = [
  '\uFEFF# 合成测试模板',
  '> 仅用于自动化测试',
  '---',
  '## 合成分类总览',
  '| 分类 | 说明 | 数量 |',
  '|------|------|:--:|',
  '| 合成甲 | 虚构说明 | 2 |',
  '| 合成乙 | 虚构说明 | 1 |',
  '---',
  '# 合成甲（2条）',
  '> 合成分区元数据',
  '---',
  '#### 1. 合成问题甲？',
  '回答：合成答案甲。',
  '---',
  '#### 2. 合成问题乙？',
  '回答：',
  '第二行合成答案。',
  '```markdown',
  '---',
  '#### 999. 这是代码块内的合成文字',
  '```',
  '---',
  '# 合成乙（1条）',
  '> 合成分区元数据',
  '---',
  '#### 3. 合成问题丙？',
  '回答：合成答案丙。',
  '',
  '| 合成列 | 值 |',
  '|---|---|',
  '| A | B |',
  '---',
  '> 合成页脚一',
  '> 合成页脚二',
].join('\r\n')

function expectReportError(
  source: string,
  expected: { readonly code: MarkdownQaParseErrorCode; readonly line: number },
): void {
  try {
    parseStructuredQaDocument(source, 'markdown')
    throw new Error('Expected review-report parsing to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(MarkdownQaParseError)
    expect(error).toMatchObject(expected)
  }
}

describe('strict reviewed-report Markdown QA import', () => {
  it('classifies and parses the complete synthetic template without treating fenced markers as records', () => {
    const result = parseStructuredQaDocument(SYNTHETIC_REPORT, 'markdown')

    expect(result.template).toBe('markdown_review_report')
    expect(result.items).toHaveLength(3)
    expect(result.items.every(({ question, answer }) => question.length > 0 && answer.length > 0)).toBe(true)
    expect(result.items[1]?.answer).toContain('#### 999.')
    expect(result.items[2]?.answer).toContain('| A | B |')
  })

  it('rejects overview/category count drift before returning any records', () => {
    const source = SYNTHETIC_REPORT.replace('| 合成甲 | 虚构说明 | 2 |', '| 合成甲 | 虚构说明 | 3 |')
    expectReportError(source, { code: 'REPORT_CATEGORY_MISMATCH', line: 10 })
  })

  it('keeps malformed template-C table prefixes in the strict report grammar', () => {
    const malformedHeader = SYNTHETIC_REPORT.replace('| 分类 | 说明 | 数量 |', '| 分类 | 数量 |')
    expectReportError(malformedHeader, { code: 'REPORT_INVALID_OVERVIEW', line: 5 })

    const malformedDelimiter = SYNTHETIC_REPORT.replace('|------|------|:--:|', '|错误|错误|错误|')
    expectReportError(malformedDelimiter, { code: 'REPORT_INVALID_OVERVIEW', line: 6 })
  })

  it('rejects undeclared extra records and non-contiguous global numbering with stable lines', () => {
    const extra = SYNTHETIC_REPORT
      .replace('| 合成甲 | 虚构说明 | 2 |', '| 合成甲 | 虚构说明 | 1 |')
      .replace('# 合成甲（2条）', '# 合成甲（1条）')
    expectReportError(extra, { code: 'REPORT_COUNT_MISMATCH', line: 16 })

    const gap = SYNTHETIC_REPORT.replace('#### 2. 合成问题乙？', '#### 3. 合成问题乙？')
    expectReportError(gap, { code: 'REPORT_QUESTION_SEQUENCE', line: 16 })
  })

  it('requires one answer marker, record separator and final blockquote footer', () => {
    const missingAnswer = SYNTHETIC_REPORT.replace('回答：合成答案甲。', '这不是答案标记')
    expectReportError(missingAnswer, { code: 'REPORT_EXPECTED_ANSWER', line: 14 })

    const missingSeparator = SYNTHETIC_REPORT.replace('回答：合成答案甲。\r\n---\r\n#### 2.', '回答：合成答案甲。\r\n#### 2.')
    expectReportError(missingSeparator, { code: 'REPORT_EXPECTED_SEPARATOR', line: 15 })

    const missingFooter = SYNTHETIC_REPORT.replace('\r\n> 合成页脚一\r\n> 合成页脚二', '')
    expectReportError(missingFooter, { code: 'REPORT_EXPECTED_FOOTER', line: 33 })
  })

  it('does not misclassify report-looking markers inside a template-B fenced answer', () => {
    const numbered = [
      '# 合成模板B',
      '> 合成元数据',
      '---',
      '## 合成分类',
      '**1. 合成问题？**',
      '回答：合成答案。',
      '```markdown',
      '#### 999. 代码块内的合成标记',
      '```',
    ].join('\n')

    const result = parseStructuredQaDocument(numbered, 'markdown')
    expect(result.template).toBe('markdown_numbered')
    expect(result.items).toHaveLength(1)
  })
})
