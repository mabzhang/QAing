import {
  chunkText,
  chunkTextForDeferredEmbedding,
  type ChunkTextOptions,
  type TokenCounter,
} from './chunking'
import type { DataStore, DocumentUpsertResult, PresetQaUpsertResult } from './database'
import { normalizeContent, normalizeQuestion } from './hash'
import type { DocumentImportInput, DocumentKind, PresetQaInput } from './types'

export type SourceDocumentFormat = 'text' | 'markdown'
export type StructuredQaFormat = 'json' | 'csv' | 'tsv' | 'markdown'

export interface StructuredQaSource {
  readonly rawContent: string
  readonly format: StructuredQaFormat
}

export type StructuredQaTemplate =
  | 'json'
  | 'csv'
  | 'tsv'
  | 'markdown_heading'
  | 'markdown_numbered'
  | 'markdown_review_report'

export interface StructuredQaParseResult {
  readonly template: StructuredQaTemplate
  readonly items: readonly PresetQaInput[]
}

export interface CanonicalArtifactValidationInput {
  readonly trustKind: 'document' | 'preset_qa'
  readonly canonicalContent: string
  /**
   * Generated documents retain the canonical single-H1 contract. User-owned
   * manual Markdown is intentionally less prescriptive, while sharing the same
   * executable-markup and path/resource safety boundary.
   */
  readonly validationProfile?: 'generated' | 'manual'
}

export interface CanonicalArtifactValidationResult {
  readonly normalizedContent: string
  readonly items: readonly PresetQaInput[]
  readonly template: StructuredQaTemplate | null
}

const MAX_CANONICAL_MARKDOWN_BYTES = 10 * 1024 * 1024
const FORBIDDEN_CANONICAL_MARKUP = /<(?:script|iframe|object|embed|link|meta|base|style|svg|math|form|input|button|textarea|select|option|video|audio|canvas)\b|\b(?:on[a-z][a-z0-9_-]*|style|srcdoc)\s*=|\b(?:src|href|srcset|poster|action|formaction|xlink:href)\s*=\s*(?:["']\s*)?(?:https?:|file:|\/|javascript:|data:)/iu
const FORBIDDEN_CANONICAL_RESOURCE = /!?\[[^\]]*\]\(\s*(?:https?:|file:|\/|~|javascript:|data:|\.\.(?:\/|\\))/iu
const CANONICAL_ABSOLUTE_PATH = /(?:^|[\s("'`])\/(?:Applications|Library|System|Users|Volumes|private|tmp)(?:\/|\b)/mu

/**
 * Fail-closed validation boundary used before a generated artifact may enter
 * the FS/SQLite publish saga. It never logs or returns source file paths.
 */
export function validateCanonicalArtifact(
  input: CanonicalArtifactValidationInput,
): CanonicalArtifactValidationResult {
  const normalizedContent = normalizeContent(input.canonicalContent)
  if (!normalizedContent) throw new Error('Canonical Markdown must not be empty')
  if (Buffer.byteLength(normalizedContent, 'utf8') > MAX_CANONICAL_MARKDOWN_BYTES) {
    throw new Error('Canonical Markdown exceeds its 10 MiB limit')
  }
  if (FORBIDDEN_CANONICAL_MARKUP.test(normalizedContent)) {
    throw new Error('Canonical Markdown contains forbidden executable markup')
  }
  if (FORBIDDEN_CANONICAL_RESOURCE.test(normalizedContent) || CANONICAL_ABSOLUTE_PATH.test(normalizedContent)) {
    throw new Error('Canonical Markdown contains a forbidden remote or absolute resource')
  }
  if (input.trustKind === 'preset_qa') {
    const parsed = parseStructuredQaDocument(normalizedContent, 'markdown')
    return { normalizedContent, items: parsed.items, template: parsed.template }
  }
  if ((input.validationProfile ?? 'generated') === 'generated') {
    const h1Count = normalizedContent.split('\n').filter((line) => /^#(?!#)\s+\S/u.test(line)).length
    if (h1Count !== 1) throw new Error('Canonical document Markdown must contain exactly one H1')
  }
  return { normalizedContent, items: [], template: null }
}

export type MarkdownQaParseErrorCode =
  | 'EXPECTED_QUESTION'
  | 'EMPTY_QUESTION'
  | 'EXPECTED_ANSWER'
  | 'EMPTY_ANSWER'
  | 'EXPECTED_CATEGORY'
  | 'EMPTY_CATEGORY'
  | 'EXPECTED_NUMBERED_QUESTION'
  | 'EXPECTED_NUMBERED_ANSWER'
  | 'EXPECTED_SEPARATOR'
  | 'EXPECTED_PREAMBLE_SEPARATOR'
  | 'INVALID_PREAMBLE'
  | 'DUPLICATE_TITLE'
  | 'UNEXPECTED_HEADING'
  | 'DUPLICATE_ANSWER'
  | 'UNCLOSED_FENCE'
  | 'CONFLICTING_QUESTION'
  | 'REPORT_EXPECTED_METADATA'
  | 'REPORT_EXPECTED_OVERVIEW'
  | 'REPORT_INVALID_OVERVIEW'
  | 'REPORT_EXPECTED_CATEGORY'
  | 'REPORT_CATEGORY_MISMATCH'
  | 'REPORT_COUNT_MISMATCH'
  | 'REPORT_EXPECTED_QUESTION'
  | 'REPORT_QUESTION_SEQUENCE'
  | 'REPORT_EXPECTED_ANSWER'
  | 'REPORT_EXPECTED_SEPARATOR'
  | 'REPORT_EXPECTED_FOOTER'

export class MarkdownQaParseError extends Error {
  readonly code: MarkdownQaParseErrorCode
  readonly line: number

  constructor(code: MarkdownQaParseErrorCode, line: number, message: string) {
    super(`Markdown QA line ${line}: ${message}`)
    this.name = 'MarkdownQaParseError'
    this.code = code
    this.line = line
  }
}

export interface SourceDocumentImport {
  readonly title: string
  readonly format: SourceDocumentFormat
  readonly content: string
  readonly sourceUri?: string
}

export interface ProjectFrontDocumentPreparation {
  readonly sessionId: string
  readonly title: string
  readonly markdown: string
}

const QUESTION_HEADERS = new Set(['question', 'q', '问题', '提问'])
const ANSWER_HEADERS = new Set(['answer', 'a', '答案', '回答'])
const MARKDOWN_ANSWER_HEADING = /^(?:### 答案|### Answer)[\t ]*$/u
const MARKDOWN_LEVEL_TWO_HEADING = /^ {0,3}##(?:[\t ]|$)/u
const MARKDOWN_INDENTED_ANSWER_HEADING = /^ {1,3}(?:### 答案|### Answer)[\t ]*$/u
const MARKDOWN_CATEGORY_HEADING = /^## ([^#\n].*?)[\t ]*$/u
const MARKDOWN_EMPTY_CATEGORY_HEADING = /^##[\t ]*$/u
const MARKDOWN_DOCUMENT_TITLE = /^# ([^#\n].*?)[\t ]*$/u
const MARKDOWN_EMPTY_DOCUMENT_TITLE = /^#[\t ]*$/u
const MARKDOWN_BLOCKQUOTE = /^>/u
const MARKDOWN_METADATA_BLOCKQUOTE = /^>[\t ]*\S.*$/u
const MARKDOWN_NUMBERED_QUESTION = /^\*\*([1-9]\d*)\. ([^*]+)\*\*[\t ]*$/u
const MARKDOWN_NEAR_NUMBERED_QUESTION = /^ {0,3}\*\*\d+[.。．、]/u
const MARKDOWN_NUMBERED_ANSWER = /^回答：(.*)$/u
const MARKDOWN_RECORD_SEPARATOR = /^---[\t ]*$/u
const MARKDOWN_REPORT_CATEGORY = /^# ([^#\n].*?)（([1-9]\d*)条）[\t ]*$/u
const MARKDOWN_REPORT_QUESTION = /^#### ([1-9]\d*)\. (\S.*?)[\t ]*$/u
const MARKDOWN_REPORT_OVERVIEW = /^## ([^#\n].*?)[\t ]*$/u
const MARKDOWN_REPORT_TABLE_DELIMITER = /^:?-{2,}:?$/u

interface MarkdownQaRecord {
  readonly question: string
  readonly answer: string
  readonly questionLine: number
}

interface MarkdownFence {
  readonly marker: '`' | '~'
  readonly length: number
  readonly line: number
}

interface ReviewReportOverviewRow {
  readonly name: string
  readonly count: number
  readonly line: number
}

function markdownError(code: MarkdownQaParseErrorCode, line: number, message: string): never {
  throw new MarkdownQaParseError(code, line, message)
}

function markdownQuestion(line: string): string | null {
  const withoutTrailingWhitespace = line.replace(/[\t ]+$/u, '')
  if (withoutTrailingWhitespace.startsWith('## 问题：')) {
    return withoutTrailingWhitespace.slice('## 问题：'.length)
  }
  if (withoutTrailingWhitespace.startsWith('## Question:')) {
    return withoutTrailingWhitespace.slice('## Question:'.length)
  }
  return null
}

function openingFence(line: string, lineNumber: number): MarkdownFence | null {
  const match = /^[\t ]{0,3}(`{3,}|~{3,})/u.exec(line)
  const markerText = match?.[1]
  if (!markerText) return null
  return {
    marker: markerText[0] as '`' | '~',
    length: markerText.length,
    line: lineNumber,
  }
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const trimmed = line.trim()
  if (trimmed.length < fence.length) return false
  return [...trimmed].every((character) => character === fence.marker)
}

function skipBlankLines(lines: readonly string[], from: number): number {
  let cursor = from
  while (cursor < lines.length && !(lines[cursor] ?? '').trim()) cursor += 1
  return cursor
}

function reportTableCells(line: string): readonly string[] | null {
  if (!line.startsWith('|') || !line.endsWith('|')) return null
  const cells = line.slice(1, -1).split('|').map((cell) => normalizeContent(cell))
  return cells.length === 3 && cells.every(Boolean) ? cells : null
}

function hasReviewReportPrefix(lines: readonly string[]): boolean {
  let cursor = skipBlankLines(lines, 0)
  const first = lines[cursor] ?? ''
  if (!MARKDOWN_DOCUMENT_TITLE.test(first) || MARKDOWN_REPORT_CATEGORY.test(first)) return false
  cursor = skipBlankLines(lines, cursor + 1)

  let metadataCount = 0
  while (MARKDOWN_METADATA_BLOCKQUOTE.test(lines[cursor] ?? '')) {
    metadataCount += 1
    cursor = skipBlankLines(lines, cursor + 1)
  }
  if (metadataCount === 0 || !MARKDOWN_RECORD_SEPARATOR.test(lines[cursor] ?? '')) return false
  cursor = skipBlankLines(lines, cursor + 1)
  if (!MARKDOWN_REPORT_OVERVIEW.test(lines[cursor] ?? '')) return false
  cursor = skipBlankLines(lines, cursor + 1)
  return (lines[cursor] ?? '').startsWith('|')
}

/**
 * Exact grammar for the reviewed-report export used by the user's approved QA
 * material. It validates the complete document before yielding any record:
 * overview rows, category names/counts, global question sequence and footer.
 */
function parseReviewReportMarkdownQa(raw: string): readonly PresetQaInput[] {
  const source = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  const lines = source.split('\n')
  const records: MarkdownQaRecord[] = []
  let cursor = skipBlankLines(lines, 0)

  const titleLine = cursor + 1
  const title = MARKDOWN_DOCUMENT_TITLE.exec(lines[cursor] ?? '')
  if (!title || MARKDOWN_REPORT_CATEGORY.test(lines[cursor] ?? '')) {
    markdownError('REPORT_EXPECTED_METADATA', titleLine, 'expected one document title before review-report metadata')
  }
  cursor = skipBlankLines(lines, cursor + 1)

  let metadataCount = 0
  while (MARKDOWN_METADATA_BLOCKQUOTE.test(lines[cursor] ?? '')) {
    metadataCount += 1
    cursor = skipBlankLines(lines, cursor + 1)
  }
  if (metadataCount === 0) {
    markdownError('REPORT_EXPECTED_METADATA', cursor + 1, 'expected non-empty blockquote metadata after the document title')
  }
  if (!MARKDOWN_RECORD_SEPARATOR.test(lines[cursor] ?? '')) {
    markdownError('REPORT_EXPECTED_METADATA', cursor + 1, 'document metadata must end with "---"')
  }
  cursor = skipBlankLines(lines, cursor + 1)

  if (!MARKDOWN_REPORT_OVERVIEW.test(lines[cursor] ?? '')) {
    markdownError('REPORT_EXPECTED_OVERVIEW', cursor + 1, 'expected one level-two category overview heading')
  }
  cursor = skipBlankLines(lines, cursor + 1)
  const headerLine = cursor + 1
  if (reportTableCells(lines[cursor] ?? '') === null) {
    markdownError('REPORT_INVALID_OVERVIEW', headerLine, 'overview must start with a three-column pipe-table header')
  }
  cursor += 1
  const delimiterCells = reportTableCells(lines[cursor] ?? '')
  if (delimiterCells === null || !delimiterCells.every((cell) => MARKDOWN_REPORT_TABLE_DELIMITER.test(cell))) {
    markdownError('REPORT_INVALID_OVERVIEW', cursor + 1, 'overview table delimiter must contain three Markdown columns')
  }
  cursor += 1

  const overview: ReviewReportOverviewRow[] = []
  const overviewNames = new Set<string>()
  while (cursor < lines.length && !MARKDOWN_RECORD_SEPARATOR.test(lines[cursor] ?? '')) {
    const lineNumber = cursor + 1
    if (!(lines[cursor] ?? '').trim()) {
      const afterBlank = skipBlankLines(lines, cursor)
      if (MARKDOWN_RECORD_SEPARATOR.test(lines[afterBlank] ?? '')) {
        cursor = afterBlank
        break
      }
      markdownError('REPORT_INVALID_OVERVIEW', lineNumber, 'blank lines are not allowed inside the overview table')
    }
    const cells = reportTableCells(lines[cursor] ?? '')
    const countText = cells?.[2] ?? ''
    if (cells === null || !/^[1-9]\d*$/u.test(countText)) {
      markdownError('REPORT_INVALID_OVERVIEW', lineNumber, 'overview rows require a name, description and positive record count')
    }
    const name = cells[0] as string
    const normalizedName = normalizeQuestion(name)
    if (overviewNames.has(normalizedName)) {
      markdownError('REPORT_INVALID_OVERVIEW', lineNumber, 'overview category names must be unique')
    }
    overviewNames.add(normalizedName)
    overview.push({ name, count: Number(countText), line: lineNumber })
    cursor += 1
  }
  if (overview.length === 0) {
    markdownError('REPORT_INVALID_OVERVIEW', headerLine, 'overview must contain at least one category row')
  }
  if (!MARKDOWN_RECORD_SEPARATOR.test(lines[cursor] ?? '')) {
    markdownError('REPORT_EXPECTED_OVERVIEW', cursor + 1, 'overview table must end with "---"')
  }
  cursor += 1

  let expectedQuestionNumber = 1
  for (const [categoryIndex, expectedCategory] of overview.entries()) {
    cursor = skipBlankLines(lines, cursor)
    const categoryLine = cursor + 1
    const category = MARKDOWN_REPORT_CATEGORY.exec(lines[cursor] ?? '')
    if (!category) {
      markdownError('REPORT_EXPECTED_CATEGORY', categoryLine, 'expected a counted level-one category heading')
    }
    const categoryName = normalizeContent(category[1] ?? '')
    const categoryCount = Number(category[2])
    if (
      normalizeQuestion(categoryName) !== normalizeQuestion(expectedCategory.name)
      || categoryCount !== expectedCategory.count
    ) {
      markdownError(
        'REPORT_CATEGORY_MISMATCH',
        categoryLine,
        `category ${categoryIndex + 1} must match its overview name and count`,
      )
    }
    cursor = skipBlankLines(lines, cursor + 1)

    let categoryMetadataCount = 0
    while (MARKDOWN_METADATA_BLOCKQUOTE.test(lines[cursor] ?? '')) {
      categoryMetadataCount += 1
      cursor = skipBlankLines(lines, cursor + 1)
    }
    if (categoryMetadataCount === 0) {
      markdownError('REPORT_EXPECTED_METADATA', cursor + 1, 'each category requires non-empty blockquote metadata')
    }
    if (!MARKDOWN_RECORD_SEPARATOR.test(lines[cursor] ?? '')) {
      markdownError('REPORT_EXPECTED_METADATA', cursor + 1, 'category metadata must end with "---"')
    }
    cursor += 1

    for (let recordIndex = 0; recordIndex < categoryCount; recordIndex += 1) {
      cursor = skipBlankLines(lines, cursor)
      const questionLine = cursor + 1
      const question = MARKDOWN_REPORT_QUESTION.exec(lines[cursor] ?? '')
      if (!question) {
        const code = MARKDOWN_REPORT_CATEGORY.test(lines[cursor] ?? '') || MARKDOWN_BLOCKQUOTE.test(lines[cursor] ?? '')
          ? 'REPORT_COUNT_MISMATCH'
          : 'REPORT_EXPECTED_QUESTION'
        markdownError(code, questionLine, 'category record count does not match its question blocks')
      }
      const actualQuestionNumber = Number(question[1])
      if (actualQuestionNumber !== expectedQuestionNumber) {
        markdownError(
          'REPORT_QUESTION_SEQUENCE',
          questionLine,
          `expected global question number ${expectedQuestionNumber}`,
        )
      }
      const questionText = normalizeContent(question[2] ?? '')
      if (!questionText) {
        markdownError('REPORT_EXPECTED_QUESTION', questionLine, 'question text must not be empty')
      }
      cursor = skipBlankLines(lines, cursor + 1)
      const answerLine = cursor + 1
      const answerMarker = MARKDOWN_NUMBERED_ANSWER.exec(lines[cursor] ?? '')
      if (!answerMarker) {
        markdownError('REPORT_EXPECTED_ANSWER', answerLine, 'expected exactly one "回答：" marker after the question')
      }
      const answerLines = [answerMarker[1] ?? '']
      cursor += 1
      let fence: MarkdownFence | null = openingFence(answerLines[0] ?? '', answerLine)
      let separatorSeen = false
      while (cursor < lines.length) {
        const line = lines[cursor] ?? ''
        const lineNumber = cursor + 1
        if (fence !== null) {
          answerLines.push(line)
          if (closesFence(line, fence)) fence = null
          cursor += 1
          continue
        }
        if (MARKDOWN_RECORD_SEPARATOR.test(line)) {
          separatorSeen = true
          cursor += 1
          break
        }
        if (MARKDOWN_NUMBERED_ANSWER.test(line)) {
          markdownError('DUPLICATE_ANSWER', lineNumber, 'the "回答：" marker may appear only once per report record')
        }
        if (
          MARKDOWN_REPORT_QUESTION.test(line)
          || MARKDOWN_REPORT_CATEGORY.test(line)
          || MARKDOWN_REPORT_OVERVIEW.test(line)
        ) {
          markdownError('REPORT_EXPECTED_SEPARATOR', lineNumber, 'expected "---" after the report answer')
        }
        answerLines.push(line)
        fence = openingFence(line, lineNumber)
        cursor += 1
      }
      if (fence !== null) {
        markdownError('UNCLOSED_FENCE', fence.line, 'answer contains an unclosed fenced code block')
      }
      if (!separatorSeen) {
        markdownError('REPORT_EXPECTED_SEPARATOR', lines.length, 'every report answer must end with "---"')
      }
      const answer = normalizeContent(answerLines.join('\n'))
      if (!answer) markdownError('EMPTY_ANSWER', answerLine, 'answer must not be empty')
      records.push({ question: questionText, answer, questionLine })
      expectedQuestionNumber += 1
    }

    const next = skipBlankLines(lines, cursor)
    const nextLine = lines[next] ?? ''
    if (categoryIndex < overview.length - 1) {
      if (MARKDOWN_REPORT_QUESTION.test(nextLine)) {
        markdownError('REPORT_COUNT_MISMATCH', next + 1, 'category contains more questions than its declared count')
      }
      if (!MARKDOWN_REPORT_CATEGORY.test(nextLine)) {
        markdownError('REPORT_EXPECTED_CATEGORY', next + 1, 'expected the next overview category')
      }
    } else if (MARKDOWN_REPORT_QUESTION.test(nextLine) || MARKDOWN_REPORT_CATEGORY.test(nextLine)) {
      markdownError('REPORT_COUNT_MISMATCH', next + 1, 'report contains records not declared by the overview')
    }
    cursor = next
  }

  let footerCount = 0
  while (cursor < lines.length) {
    const line = lines[cursor] ?? ''
    if (!line.trim()) {
      cursor += 1
      continue
    }
    if (!MARKDOWN_METADATA_BLOCKQUOTE.test(line)) {
      markdownError('REPORT_EXPECTED_FOOTER', cursor + 1, 'only non-empty blockquote footer lines may follow the final record')
    }
    footerCount += 1
    cursor += 1
  }
  if (footerCount === 0) {
    markdownError('REPORT_EXPECTED_FOOTER', lines.length, 'report must end with at least one blockquote footer line')
  }
  return validateAndDedupeMarkdownQa(records)
}

function validateAndDedupeMarkdownQa(records: readonly MarkdownQaRecord[]): readonly PresetQaInput[] {
  const byQuestion = new Map<string, MarkdownQaRecord>()
  for (const record of records) {
    const normalizedQuestion = normalizeQuestion(record.question)
    const previous = byQuestion.get(normalizedQuestion)
    if (previous && normalizeContent(previous.answer) !== normalizeContent(record.answer)) {
      markdownError(
        'CONFLICTING_QUESTION',
        record.questionLine,
        `question conflicts with the record at line ${previous.questionLine}`,
      )
    }
    if (!previous) byQuestion.set(normalizedQuestion, record)
  }
  return [...byQuestion.values()].map(({ question, answer }) => ({ question, answer }))
}

/**
 * Parses only the documented QA Markdown grammar. It deliberately rejects
 * prose and unknown level-two headings instead of guessing that ordinary
 * Markdown is an authoritative preset-answer source.
 */
function parseHeadingMarkdownQa(raw: string): readonly PresetQaInput[] {
  const source = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  const lines = source.split('\n')
  const records: MarkdownQaRecord[] = []
  let question: string | null = null
  let questionLine = 0
  let answerHeadingLine = 0
  let answerLines: string[] | null = null
  let fence: MarkdownFence | null = null

  const finishRecord = (): void => {
    if (question === null) return
    if (answerLines === null) {
      markdownError('EXPECTED_ANSWER', questionLine, 'expected "### 答案" or "### Answer"')
    }
    if (fence !== null) {
      markdownError('UNCLOSED_FENCE', fence.line, 'answer contains an unclosed fenced code block')
    }
    const answer = normalizeContent(answerLines.join('\n'))
    if (!answer) markdownError('EMPTY_ANSWER', answerHeadingLine, 'answer must not be empty')
    records.push({ question, answer, questionLine })
  }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    if (answerLines !== null && fence !== null) {
      answerLines.push(line)
      if (closesFence(line, fence)) fence = null
      continue
    }

    const nextQuestion = markdownQuestion(line)
    if (nextQuestion !== null) {
      finishRecord()
      const normalized = normalizeContent(nextQuestion)
      if (!normalized) markdownError('EMPTY_QUESTION', lineNumber, 'question must not be empty')
      question = normalized
      questionLine = lineNumber
      answerHeadingLine = 0
      answerLines = null
      continue
    }

    if (question === null) {
      if (!line.trim()) continue
      markdownError('EXPECTED_QUESTION', lineNumber, 'expected "## 问题：…" or "## Question:…"')
    }

    if (answerLines === null) {
      if (MARKDOWN_ANSWER_HEADING.test(line)) {
        answerHeadingLine = lineNumber
        answerLines = []
        continue
      }
      if (!line.trim()) continue
      markdownError('EXPECTED_ANSWER', lineNumber, 'expected "### 答案" or "### Answer" before answer content')
    }

    if (MARKDOWN_ANSWER_HEADING.test(line) || MARKDOWN_INDENTED_ANSWER_HEADING.test(line)) {
      markdownError('DUPLICATE_ANSWER', lineNumber, 'answer heading may appear only once per record')
    }
    if (MARKDOWN_LEVEL_TWO_HEADING.test(line)) {
      markdownError('UNEXPECTED_HEADING', lineNumber, 'only documented question headings may start a record')
    }
    answerLines.push(line)
    fence = openingFence(line, lineNumber)
  }

  finishRecord()
  if (records.length === 0) markdownError('EXPECTED_QUESTION', 1, 'the QA document contains no records')
  return validateAndDedupeMarkdownQa(records)
}

/**
 * Strict compatibility grammar for curated review documents:
 *
 * ## Category
 * **1. Question**
 * 回答：First answer line
 * Additional Markdown answer lines
 * ---
 *
 * A separator is mandatory between records; EOF may terminate the final one.
 * Numbers identify presentation order only and may restart in each category.
 */
function parseNumberedMarkdownQa(raw: string): readonly PresetQaInput[] {
  const source = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  const lines = source.split('\n')
  const records: MarkdownQaRecord[] = []
  let categoryLine = 0
  let categoryHasRecord = false
  let question: string | null = null
  let questionLine = 0
  let answerLine = 0
  let answerLines: string[] | null = null
  let fence: MarkdownFence | null = null

  const finishRecord = (): void => {
    if (question === null) return
    if (answerLines === null) {
      markdownError('EXPECTED_NUMBERED_ANSWER', questionLine, 'expected "回答：…" after the numbered question')
    }
    if (fence !== null) {
      markdownError('UNCLOSED_FENCE', fence.line, 'answer contains an unclosed fenced code block')
    }
    const answer = normalizeContent(answerLines.join('\n'))
    if (!answer) markdownError('EMPTY_ANSWER', answerLine, 'answer must not be empty')
    records.push({ question, answer, questionLine })
    categoryHasRecord = true
    question = null
    questionLine = 0
    answerLine = 0
    answerLines = null
  }

  let bodyStart = 0
  while (bodyStart < lines.length && !(lines[bodyStart] ?? '').trim()) bodyStart += 1
  const first = lines[bodyStart] ?? ''
  if (
    MARKDOWN_DOCUMENT_TITLE.test(first) ||
    MARKDOWN_EMPTY_DOCUMENT_TITLE.test(first) ||
    MARKDOWN_BLOCKQUOTE.test(first)
  ) {
    const preambleStartLine = bodyStart + 1
    let titleSeen = false
    let separatorSeen = false
    if (MARKDOWN_EMPTY_DOCUMENT_TITLE.test(first)) {
      markdownError('INVALID_PREAMBLE', preambleStartLine, 'document title must not be empty')
    }
    if (MARKDOWN_DOCUMENT_TITLE.test(first)) {
      titleSeen = true
      bodyStart += 1
    }
    for (; bodyStart < lines.length; bodyStart += 1) {
      const line = lines[bodyStart] ?? ''
      const lineNumber = bodyStart + 1
      if (!line.trim()) continue
      if (MARKDOWN_RECORD_SEPARATOR.test(line)) {
        separatorSeen = true
        bodyStart += 1
        break
      }
      if (MARKDOWN_DOCUMENT_TITLE.test(line)) {
        markdownError(
          titleSeen ? 'DUPLICATE_TITLE' : 'INVALID_PREAMBLE',
          lineNumber,
          titleSeen ? 'document title may appear only once' : 'document title must precede metadata lines',
        )
      }
      if (
        MARKDOWN_CATEGORY_HEADING.test(line) ||
        MARKDOWN_NUMBERED_QUESTION.test(line) ||
        markdownQuestion(line) !== null
      ) {
        markdownError('EXPECTED_PREAMBLE_SEPARATOR', lineNumber, 'preamble must end with "---" before QA records')
      }
      if (!MARKDOWN_METADATA_BLOCKQUOTE.test(line)) {
        markdownError('INVALID_PREAMBLE', lineNumber, 'only blockquote metadata is allowed before the preamble separator')
      }
    }
    if (!separatorSeen) {
      markdownError('EXPECTED_PREAMBLE_SEPARATOR', preambleStartLine, 'preamble must end with exactly one "---"')
    }
    while (bodyStart < lines.length && !(lines[bodyStart] ?? '').trim()) bodyStart += 1
    const bodyFirst = lines[bodyStart] ?? ''
    if (!MARKDOWN_CATEGORY_HEADING.test(bodyFirst) || markdownQuestion(bodyFirst) !== null) {
      markdownError('EXPECTED_CATEGORY', bodyStart + 1, 'a category heading must immediately follow the preamble')
    }
  }

  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const lineNumber = index + 1
    if (answerLines !== null && fence !== null) {
      answerLines.push(line)
      if (closesFence(line, fence)) fence = null
      continue
    }

    if (question !== null && answerLines !== null) {
      if (MARKDOWN_RECORD_SEPARATOR.test(line)) {
        finishRecord()
        continue
      }
      if (
        MARKDOWN_NUMBERED_QUESTION.test(line) ||
        MARKDOWN_NEAR_NUMBERED_QUESTION.test(line) ||
        MARKDOWN_LEVEL_TWO_HEADING.test(line) ||
        markdownQuestion(line) !== null
      ) {
        markdownError('EXPECTED_SEPARATOR', lineNumber, 'expected "---" between numbered QA records')
      }
      if (MARKDOWN_NUMBERED_ANSWER.test(line)) {
        markdownError('DUPLICATE_ANSWER', lineNumber, 'the "回答：" marker may appear only once per record')
      }
      if (MARKDOWN_ANSWER_HEADING.test(line) || MARKDOWN_INDENTED_ANSWER_HEADING.test(line)) {
        markdownError('UNEXPECTED_HEADING', lineNumber, 'heading-style and numbered Markdown QA grammars may not be mixed')
      }
      answerLines.push(line)
      fence = openingFence(line, lineNumber)
      continue
    }

    if (question !== null) {
      const answerMatch = MARKDOWN_NUMBERED_ANSWER.exec(line)
      if (answerMatch) {
        const firstLine = normalizeContent(answerMatch[1] ?? '')
        if (!firstLine) markdownError('EMPTY_ANSWER', lineNumber, 'the "回答：" line must contain answer text')
        answerLine = lineNumber
        answerLines = [firstLine]
        fence = openingFence(firstLine, lineNumber)
        continue
      }
      if (!line.trim()) continue
      markdownError('EXPECTED_NUMBERED_ANSWER', lineNumber, 'expected "回答：…" after the numbered question')
    }

    if (!line.trim()) continue
    if (MARKDOWN_EMPTY_CATEGORY_HEADING.test(line)) {
      markdownError('EMPTY_CATEGORY', lineNumber, 'category heading must not be empty')
    }
    const category = MARKDOWN_CATEGORY_HEADING.exec(line)
    if (category) {
      if (markdownQuestion(line) !== null) {
        markdownError('UNEXPECTED_HEADING', lineNumber, 'heading-style and numbered Markdown QA grammars may not be mixed')
      }
      if (categoryLine > 0 && !categoryHasRecord) {
        markdownError('EXPECTED_NUMBERED_QUESTION', categoryLine, 'category must contain at least one numbered QA record')
      }
      categoryLine = lineNumber
      categoryHasRecord = false
      continue
    }

    const numberedQuestion = MARKDOWN_NUMBERED_QUESTION.exec(line)
    if (numberedQuestion) {
      if (categoryLine === 0) {
        markdownError('EXPECTED_CATEGORY', lineNumber, 'a "## Category" heading is required before numbered QA records')
      }
      const normalized = normalizeContent(numberedQuestion[2] ?? '')
      if (!normalized) markdownError('EMPTY_QUESTION', lineNumber, 'question must not be empty')
      question = normalized
      questionLine = lineNumber
      continue
    }

    if (categoryLine === 0) {
      markdownError('EXPECTED_CATEGORY', lineNumber, 'expected a "## Category" heading')
    }
    if (MARKDOWN_RECORD_SEPARATOR.test(line)) {
      markdownError('EXPECTED_NUMBERED_QUESTION', lineNumber, 'separator cannot appear before a numbered QA record')
    }
    markdownError('EXPECTED_NUMBERED_QUESTION', lineNumber, 'expected "**1. Question**"')
  }

  finishRecord()
  if (categoryLine > 0 && !categoryHasRecord) {
    markdownError('EXPECTED_NUMBERED_QUESTION', categoryLine, 'category must contain at least one numbered QA record')
  }
  if (records.length === 0) markdownError('EXPECTED_CATEGORY', 1, 'the QA document contains no records')
  return validateAndDedupeMarkdownQa(records)
}

function parseMarkdownQaDocument(raw: string): StructuredQaParseResult {
  const source = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  const lines = source.split('\n')
  const first = lines.find((line) => line.trim().length > 0) ?? ''
  if (markdownQuestion(first) !== null) {
    return { template: 'markdown_heading', items: parseHeadingMarkdownQa(raw) }
  }
  if (hasReviewReportPrefix(lines)) {
    return { template: 'markdown_review_report', items: parseReviewReportMarkdownQa(raw) }
  }
  if (
    MARKDOWN_DOCUMENT_TITLE.test(first) ||
    MARKDOWN_EMPTY_DOCUMENT_TITLE.test(first) ||
    MARKDOWN_BLOCKQUOTE.test(first) ||
    MARKDOWN_CATEGORY_HEADING.test(first) ||
    MARKDOWN_EMPTY_CATEGORY_HEADING.test(first) ||
    MARKDOWN_NUMBERED_QUESTION.test(first)
  ) {
    return { template: 'markdown_numbered', items: parseNumberedMarkdownQa(raw) }
  }
  return { template: 'markdown_heading', items: parseHeadingMarkdownQa(raw) }
}

function asQaItem(value: unknown, location: string): PresetQaInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object containing question and answer`)
  }
  const record = value as Record<string, unknown>
  const question = record.question ?? record.q ?? record['问题'] ?? record['提问']
  const answer = record.answer ?? record.a ?? record['答案'] ?? record['回答']
  if (typeof question !== 'string' || typeof answer !== 'string') {
    throw new Error(`${location} must contain string question and answer fields`)
  }
  return { question, answer }
}

function parseJsonQa(raw: string): readonly PresetQaInput[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('The QA JSON file is not valid JSON')
  }

  if (Array.isArray(parsed)) return parsed.map((item, index) => asQaItem(item, `items[${index}]`))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('QA JSON must be an array, an object with an items array, or a question-to-answer map')
  }

  const record = parsed as Record<string, unknown>
  const nested = record.items ?? record.qa ?? record.data
  if (Array.isArray(nested)) return nested.map((item, index) => asQaItem(item, `items[${index}]`))
  if ('question' in record || 'q' in record || '问题' in record) return [asQaItem(record, 'item')]

  return Object.entries(record).map(([question, answer]) => {
    if (typeof answer !== 'string') throw new Error(`The answer for question "${question}" must be a string`)
    return { question, answer }
  })
}

function parseDelimitedRows(raw: string, delimiter: ',' | '\t'): readonly (readonly string[])[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  const source = raw.replace(/^\uFEFF/u, '')
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }

    if (character === '"' && field.length === 0) {
      quoted = true
    } else if (character === delimiter) {
      row.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      row.push(field)
      if (row.some((value) => value.trim().length > 0)) rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }
  if (quoted) throw new Error('The QA delimited file contains an unterminated quoted field')
  row.push(field)
  if (row.some((value) => value.trim().length > 0)) rows.push(row)
  return rows
}

function parseDelimitedQa(raw: string, delimiter: ',' | '\t'): readonly PresetQaInput[] {
  const rows = parseDelimitedRows(raw, delimiter)
  if (rows.length < 2) throw new Error('The QA delimited file must contain a header and at least one data row')
  const header = rows[0]?.map((value) => value.trim().toLocaleLowerCase('zh-CN')) ?? []
  const questionIndex = header.findIndex((value) => QUESTION_HEADERS.has(value))
  const answerIndex = header.findIndex((value) => ANSWER_HEADERS.has(value))
  if (questionIndex < 0 || answerIndex < 0) {
    throw new Error('The QA header must contain question and answer columns')
  }

  return rows.slice(1).map((row) => ({
    question: row[questionIndex] ?? '',
    answer: row[answerIndex] ?? '',
  })).map((item, index) => {
    if (!normalizeContent(item.question) || !normalizeContent(item.answer)) {
      throw new Error(`QA row ${index + 2} contains an empty question or answer`)
    }
    return item
  })
}

export function validateAndDedupeQa(items: readonly PresetQaInput[]): readonly PresetQaInput[] {
  if (items.length === 0) throw new Error('The QA import contains no records')
  const byQuestion = new Map<string, PresetQaInput>()
  for (const [index, item] of items.entries()) {
    const question = normalizeContent(item.question)
    const answer = normalizeContent(item.answer)
    const normalizedQuestion = normalizeQuestion(question)
    if (!normalizedQuestion || !answer) throw new Error(`QA item ${index + 1} contains an empty question or answer`)
    const previous = byQuestion.get(normalizedQuestion)
    if (previous && normalizeContent(previous.answer) !== answer) {
      throw new Error(`QA import contains conflicting answers for question "${question}"`)
    }
    byQuestion.set(normalizedQuestion, { question, answer })
  }
  return [...byQuestion.values()]
}

export function parseStructuredQaDocument(
  rawContent: string,
  format: StructuredQaFormat,
): StructuredQaParseResult {
  const content = rawContent.replace(/^\uFEFF/u, '').trim()
  if (!content) {
    if (format === 'markdown') markdownError('EXPECTED_QUESTION', 1, 'the QA document contains no records')
    throw new Error('The QA import file must not be empty')
  }
  if (format === 'markdown') return parseMarkdownQaDocument(rawContent)
  const items = format === 'json'
    ? parseJsonQa(content)
    : parseDelimitedQa(content, format === 'csv' ? ',' : '\t')
  return { template: format, items: validateAndDedupeQa(items) }
}

export function parseStructuredQa(rawContent: string, format: StructuredQaFormat): readonly PresetQaInput[] {
  return parseStructuredQaDocument(rawContent, format).items
}

/**
 * Produces the exact, cross-source-deduplicated batch that may be shown in a
 * confirmation preview and later committed without reparsing the source files.
 */
export function parseStructuredQaBatch(sources: readonly StructuredQaSource[]): readonly PresetQaInput[] {
  if (sources.length === 0) throw new Error('The QA import batch must not be empty')
  return validateAndDedupeQa(sources.flatMap((source) => parseStructuredQa(source.rawContent, source.format)))
}

export function importSourceDocument(
  store: DataStore,
  input: SourceDocumentImport,
  counter: TokenCounter,
  chunkOptions: ChunkTextOptions = {},
  now = Date.now(),
): DocumentUpsertResult {
  const content = normalizeContent(input.content)
  const chunks = chunkText(content, counter, chunkOptions)
  const kind: DocumentKind = input.format === 'markdown' ? 'markdown' : 'text'
  return store.upsertDocument(
    {
      title: input.title,
      kind,
      content,
      chunks,
      ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
    },
    now,
  )
}

/**
 * Persists source text and its FTS-visible chunks without requiring a model or
 * tokenizer to be loaded in the Electron main process.
 */
export function importSourceDocumentDeferred(
  store: DataStore,
  input: SourceDocumentImport,
  chunkOptions: ChunkTextOptions = {},
  now = Date.now(),
): DocumentUpsertResult {
  return store.upsertDocument(prepareSourceDocumentDeferred(input, chunkOptions), now)
}

export function prepareSourceDocumentDeferred(
  input: SourceDocumentImport,
  chunkOptions: ChunkTextOptions = {},
): DocumentImportInput {
  const content = normalizeContent(input.content)
  const chunks = chunkTextForDeferredEmbedding(content, chunkOptions)
  const kind: DocumentKind = input.format === 'markdown' ? 'markdown' : 'text'
  return {
    title: input.title,
    kind,
    content,
    chunks,
    ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
  }
}

/** Pure preparation step; it never writes a legacy catalogue entry. */
export function prepareProjectFrontDocumentDeferred(
  input: ProjectFrontDocumentPreparation,
  chunkOptions: ChunkTextOptions = {},
): DocumentImportInput {
  const sessionId = input.sessionId.trim()
  if (!sessionId || sessionId.length > 256 || sessionId.includes('\0')) {
    throw new Error('Front session ID is invalid')
  }
  const content = normalizeContent(input.markdown)
  return {
    title: input.title,
    kind: 'front_transcript',
    content,
    chunks: chunkTextForDeferredEmbedding(content, chunkOptions),
    sourceUri: `qaing://front/${sessionId}`,
  }
}

export function importSourceDocumentsDeferred(
  store: DataStore,
  inputs: readonly SourceDocumentImport[],
  chunkOptions: ChunkTextOptions = {},
  now = Date.now(),
): readonly DocumentUpsertResult[] {
  const prepared = inputs.map((input) => prepareSourceDocumentDeferred(input, chunkOptions))
  return store.upsertDocumentsBatch(prepared, now)
}

export function importStructuredQa(
  store: DataStore,
  rawContent: string,
  format: StructuredQaFormat,
  now = Date.now(),
): readonly PresetQaUpsertResult[] {
  return store.upsertPresetQaBatch(parseStructuredQa(rawContent, format), now)
}

export function importStructuredQaBatch(
  store: DataStore,
  sources: readonly StructuredQaSource[],
  now = Date.now(),
): readonly PresetQaUpsertResult[] {
  return store.upsertPresetQaBatchIfNoConflicts(parseStructuredQaBatch(sources), now)
}
