import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { ProjectSyncError } from './errors'
import {
  PROJECT_CONVERTER_ID,
  PROJECT_CONVERTER_VERSION,
  PROJECT_SCHEMA_VERSION,
  type ProjectConverterRequest,
  type ProjectConverterResult,
} from './types'

const FORBIDDEN_MARKUP = /<(?:script|iframe|object|embed|link|meta)\b|(?:src|href)\s*=\s*["'](?:https?:|file:|\/)/iu
const REMOTE_MARKDOWN_RESOURCE = /!?\[[^\]]*\]\(\s*(?:https?:|file:|\/)/iu

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new ProjectSyncError('INPUT_ENCODING_INVALID', 'Input must be valid UTF-8', false,
      error instanceof Error ? { cause: error } : undefined)
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/^\uFEFF/u, '')
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t ]+$/gmu, '')
    .trim()
}

function assertSafeMarkdown(value: string): void {
  if (!value || value.includes('\0') || FORBIDDEN_MARKUP.test(value) || REMOTE_MARKDOWN_RESOURCE.test(value)) {
    throw new ProjectSyncError('OUTPUT_INVALID')
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value.normalize('NFC'))
}

function provenance(request: ProjectConverterRequest): string {
  return [
    '---',
    `qaing_schema: ${yamlString(`qaing-converted/v${String(PROJECT_SCHEMA_VERSION)}`)}`,
    `content_kind: ${yamlString(request.trustKind === 'document' ? 'source_document' : 'preset_qa')}`,
    `source_id: ${yamlString(request.sourceId)}`,
    `source_relative_path: ${yamlString(request.relativePath)}`,
    `source_sha256: ${yamlString(request.rawSha256)}`,
    `trust_kind: ${yamlString(request.trustKind)}`,
    `conversion_mode: ${yamlString('local')}`,
    `converter_id: ${yamlString(PROJECT_CONVERTER_ID)}`,
    `converter_version: ${yamlString(PROJECT_CONVERTER_VERSION)}`,
    '---',
  ].join('\n')
}

function markdownTitle(request: ProjectConverterRequest): string {
  return basename(request.relativePath).replace(/[\r\n#]/gu, ' ').trim() || '未命名资料'
}

function fenceFor(value: string): string {
  let width = 3
  for (const match of value.matchAll(/`+/gu)) width = Math.max(width, (match[0]?.length ?? 0) + 1)
  return '`'.repeat(width)
}

function textBody(request: ProjectConverterRequest, source: string): string {
  const fence = fenceFor(source)
  return `# ${markdownTitle(request)}\n\n${fence}text\n${source}\n${fence}`
}

function demoteMarkdownHeadings(source: string): string {
  const lines = source.split('\n')
  const output: string[] = []
  let fence: { readonly marker: '`' | '~'; readonly width: number } | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const next = lines[index + 1]
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)
    if (fenceMatch) {
      const run = fenceMatch[1] ?? ''
      const marker = run[0] as '`' | '~'
      if (fence === null) fence = { marker, width: run.length }
      else if (fence.marker === marker && run.length >= fence.width) fence = null
      output.push(line)
      continue
    }
    if (fence !== null) {
      output.push(line)
      continue
    }
    if (line.trim() && next !== undefined && /^\s*=+\s*$/u.test(next)) {
      output.push(`## ${line.trim()}`)
      index += 1
      continue
    }
    if (line.trim() && next !== undefined && /^\s*-{3,}\s*$/u.test(next)) {
      output.push(`### ${line.trim()}`)
      index += 1
      continue
    }
    output.push(line.replace(/^(\s{0,3})(#{1,6})(?=\s|$)/u, (_match, indentation: string, hashes: string) => (
      `${indentation}${'#'.repeat(Math.min(6, hashes.length + 1))}`
    )))
  }
  return output.join('\n')
}

function markdownBody(request: ProjectConverterRequest, source: string): string {
  return `# ${markdownTitle(request)}\n\n${demoteMarkdownHeadings(source)}`
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortedJson(record[key])]))
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown
  } catch (error) {
    throw new ProjectSyncError('OUTPUT_INVALID', 'JSON input is invalid', false,
      error instanceof Error ? { cause: error } : undefined)
  }
}

interface QaItem {
  readonly question: string
  readonly answer: string
}

function qaItemsFromJson(value: unknown): readonly QaItem[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>).items)
      ? (value as { readonly items: unknown[] }).items
      : null
  if (!items || items.length < 1) throw new ProjectSyncError('OUTPUT_INVALID')
  return items.map((item) => {
    if (typeof item !== 'object' || item === null) throw new ProjectSyncError('OUTPUT_INVALID')
    const rawQuestion = (item as Record<string, unknown>).question
    const rawAnswer = (item as Record<string, unknown>).answer
    if (typeof rawQuestion !== 'string' || typeof rawAnswer !== 'string') throw new ProjectSyncError('OUTPUT_INVALID')
    const question = normalizeText(rawQuestion)
    const answer = normalizeText(rawAnswer)
    if (!question || !answer) throw new ProjectSyncError('OUTPUT_INVALID')
    return { question, answer }
  })
}

function qaMarkdown(items: readonly QaItem[]): string {
  return items.map((item) => `## 问题：${item.question}\n\n### 答案\n\n${item.answer}`).join('\n\n')
}

function jsonBody(request: ProjectConverterRequest, source: string): string {
  const value = parseJson(source)
  if (request.trustKind === 'preset_qa') return qaMarkdown(qaItemsFromJson(value))
  const rendered = JSON.stringify(sortedJson(value), null, 2)
  return `# ${markdownTitle(request)}\n\n\`\`\`json\n${rendered}\n\`\`\``
}

function parseDelimited(source: string, delimiter: ',' | '\t'): readonly (readonly string[])[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let closedQuote = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? ''
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
        closedQuote = true
      } else {
        field += character
      }
      continue
    }
    if (closedQuote && character !== delimiter && character !== '\n') throw new ProjectSyncError('OUTPUT_INVALID')
    if (character === '"' && field.length === 0 && !closedQuote) {
      quoted = true
    } else if (character === '"') {
      throw new ProjectSyncError('OUTPUT_INVALID')
    } else if (character === delimiter) {
      row.push(field)
      field = ''
      closedQuote = false
    } else if (character === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      closedQuote = false
    } else {
      field += character
    }
  }
  if (quoted) throw new ProjectSyncError('OUTPUT_INVALID')
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  if (rows.length < 1) throw new ProjectSyncError('OUTPUT_INVALID')
  const width = Math.max(...rows.map((value) => value.length))
  if (width < 1 || width > 256) throw new ProjectSyncError('OUTPUT_INVALID')
  return rows.map((value) => [...value, ...Array.from({ length: width - value.length }, () => '')])
}

function markdownCell(value: string): string {
  return normalizeText(value).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function tableMarkdown(rows: readonly (readonly string[])[]): string {
  const header = rows[0]
  if (!header) throw new ProjectSyncError('OUTPUT_INVALID')
  const normalizedHeader = header.map((value, index) => markdownCell(value) || `column_${String(index + 1)}`)
  const separator = normalizedHeader.map(() => '---')
  return [normalizedHeader, separator, ...rows.slice(1).map((row) => row.map(markdownCell))]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n')
}

function qaItemsFromRows(rows: readonly (readonly string[])[]): readonly QaItem[] {
  const header = rows[0]?.map((value) => normalizeText(value).normalize('NFKC').toLocaleLowerCase('en-US'))
  const questionIndex = header?.findIndex((value) => value === 'question' || value === '问题') ?? -1
  const answerIndex = header?.findIndex((value) => value === 'answer' || value === '答案' || value === '回答') ?? -1
  if (questionIndex < 0 || answerIndex < 0) throw new ProjectSyncError('OUTPUT_INVALID')
  const items = rows.slice(1).map((row) => ({
    question: normalizeText(row[questionIndex] ?? ''),
    answer: normalizeText(row[answerIndex] ?? ''),
  }))
  if (items.length < 1 || items.some((item) => !item.question || !item.answer)) {
    throw new ProjectSyncError('OUTPUT_INVALID')
  }
  return items
}

function delimitedBody(request: ProjectConverterRequest, source: string, delimiter: ',' | '\t'): string {
  const rows = parseDelimited(source, delimiter)
  if (request.trustKind === 'preset_qa') return qaMarkdown(qaItemsFromRows(rows))
  return `# ${markdownTitle(request)}\n\n${tableMarkdown(rows)}`
}

export function canonicalizeProjectInput(request: ProjectConverterRequest): ProjectConverterResult {
  if (!/^[a-f0-9]{64}$/u.test(request.rawSha256)) throw new ProjectSyncError('OUTPUT_INVALID')
  const source = normalizeText(decodeUtf8(request.input))
  if (!source) throw new ProjectSyncError('OUTPUT_INVALID')
  let body: string
  switch (request.detectedType) {
    case 'text':
      if (request.trustKind === 'preset_qa') throw new ProjectSyncError('INPUT_UNSUPPORTED')
      body = textBody(request, source)
      break
    case 'markdown':
      body = request.trustKind === 'preset_qa' ? source : markdownBody(request, source)
      break
    case 'json':
      body = jsonBody(request, source)
      break
    case 'csv':
      body = delimitedBody(request, source, ',')
      break
    case 'tsv':
      body = delimitedBody(request, source, '\t')
      break
  }
  assertSafeMarkdown(body)
  const canonicalMarkdown = `${provenance(request)}\n\n${body}\n`
  const normalizedBody = canonicalBody(canonicalMarkdown)
  return {
    canonicalMarkdown,
    outputSha256: createHash('sha256').update(canonicalMarkdown, 'utf8').digest('hex'),
    canonicalBodySha256: createHash('sha256').update(normalizedBody, 'utf8').digest('hex'),
  }
}

export function canonicalBody(canonicalMarkdown: string): string {
  const normalized = canonicalMarkdown.replace(/\r\n?/gu, '\n')
  if (!normalized.startsWith('---\n')) throw new ProjectSyncError('OUTPUT_INVALID')
  const boundary = normalized.indexOf('\n---\n\n', 4)
  if (boundary < 0) throw new ProjectSyncError('OUTPUT_INVALID')
  const body = normalized.slice(boundary + '\n---\n\n'.length).trim()
  if (!body) throw new ProjectSyncError('OUTPUT_INVALID')
  return body
}
