import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { validateManualArtifact } from './artifact'
import { canonicalizeProjectInput } from './canonical'
import { ProjectSyncError } from './errors'
import type { ProjectConverterRequest } from './types'

function request(
  detectedType: ProjectConverterRequest['detectedType'],
  content: string,
  trustKind: ProjectConverterRequest['trustKind'] = 'document',
): ProjectConverterRequest {
  const input = Buffer.from(content, 'utf8')
  return {
    projectId: 'project',
    sourceId: 'source_12345678',
    relativePath: trustKind === 'document' ? '原始资料/sample.txt' : '预设QA/sample.json',
    trustKind,
    detectedType,
    rawSha256: createHash('sha256').update(input).digest('hex'),
    input,
  }
}

describe('deterministic project conversion', () => {
  it('normalizes text into deterministic canonical Markdown with controlled provenance', () => {
    const input = request('text', 'line one\r\nline two  \r\n')
    const first = canonicalizeProjectInput(input)
    const second = canonicalizeProjectInput(input)
    expect(second).toEqual(first)
    expect(first.canonicalMarkdown).toContain('qaing_schema: "qaing-converted/v1"')
    expect(first.canonicalMarkdown).toContain('conversion_mode: "local"')
    expect(first.canonicalMarkdown).toContain('```text\nline one\nline two\n```')
    expect(createHash('sha256').update(first.canonicalMarkdown).digest('hex')).toBe(first.outputSha256)
    expect(createHash('sha256').update('# sample.txt\n\n```text\nline one\nline two\n```').digest('hex'))
      .toBe(first.canonicalBodySha256)
  })

  it('canonicalizes JSON key order and CSV tables', () => {
    const json = canonicalizeProjectInput(request('json', '{"z":1,"a":{"y":2,"x":3}}'))
    expect(json.canonicalMarkdown.indexOf('"a"')).toBeLessThan(json.canonicalMarkdown.indexOf('"z"'))
    const csv = canonicalizeProjectInput(request('csv', 'name,value\nA,1\nB,"x,y"'))
    expect(csv.canonicalMarkdown).toContain('| name | value |\n| --- | --- |\n| A | 1 |\n| B | x,y |')
  })

  it('preserves fenced-code headings and rejects malformed quoted delimited input', () => {
    const markdown = canonicalizeProjectInput(request('markdown', '# Heading\n\n```md\n# code heading\n```'))
    expect(markdown.canonicalMarkdown).toContain('## Heading\n\n```md\n# code heading\n```')
    expect(() => canonicalizeProjectInput(request('csv', 'name,value\n"a"x,b'))).toThrowError(ProjectSyncError)
  })

  it('generates only strict QA grammar for structured preset QA', () => {
    const result = canonicalizeProjectInput(request('json', JSON.stringify([
      { question: '价格是多少？', answer: '100 元' },
    ]), 'preset_qa'))
    expect(result.canonicalMarkdown).toContain('content_kind: "preset_qa"')
    expect(result.canonicalMarkdown).toContain('## 问题：价格是多少？\n\n### 答案\n\n100 元')
  })

  it('fails closed on remote Markdown resources and malformed UTF-8', () => {
    expect(() => canonicalizeProjectInput(request('markdown', '# title\n![x](https://example.com/x)')))
      .toThrowError(ProjectSyncError)
    const malformed = request('text', '')
    expect(() => canonicalizeProjectInput({ ...malformed, input: Uint8Array.from([0xff]) }))
      .toThrowError(ProjectSyncError)
  })
})

describe('manual project artifacts', () => {
  it('accepts safe plain document Markdown without QAing frontmatter or a forced H1', () => {
    const raw = Buffer.from('\uFEFF项目背景\r\n\r\n- 已审核事实\r\n', 'utf8')
    const validated = validateManualArtifact(raw, 'document')
    expect(validated.canonicalContent).toBe('项目背景\n\n- 已审核事实')
    expect(validated.outputSha256).toBe(createHash('sha256').update(raw).digest('hex'))
  })

  it('keeps ordinary user YAML frontmatter as document content instead of treating it as QAing provenance', () => {
    const raw = Buffer.from('---\ncontent_kind: notes\nauthor: user\n---\n\nBody')
    expect(validateManualArtifact(raw, 'document').canonicalContent)
      .toBe('---\ncontent_kind: notes\nauthor: user\n---\n\nBody')
  })

  it('accepts explicit manual provenance and strips it before SQLite publication', () => {
    const raw = Buffer.from([
      '---',
      'qaing_schema: "qaing-converted/v1"',
      'content_kind: "source_document"',
      'conversion_mode: "manual"',
      '---',
      '# 手动资料',
      '',
      '可审计正文',
      '',
    ].join('\n'))
    const validated = validateManualArtifact(raw, 'document')
    expect(validated).toMatchObject({
      canonicalContent: '# 手动资料\n\n可审计正文',
    })
    expect(validated.outputSha256).toBe(createHash('sha256').update(raw).digest('hex'))
    expect(validated.canonicalBodySha256)
      .toBe(createHash('sha256').update(validated.canonicalContent).digest('hex'))
    expect(validated.outputSha256).not.toBe(validated.canonicalBodySha256)
  })

  it('accepts the explicitly supported manual QA layout variants at the project boundary', () => {
    const artifact = (body: string): Buffer => Buffer.from([
      '---',
      'qaing_schema: "qaing-converted/v1"',
      'content_kind: "preset_qa"',
      'conversion_mode: "manual"',
      '---',
      body,
    ].join('\n'))
    expect(validateManualArtifact(artifact('**1. 价格多少？**\n\n回答：100 元'), 'preset_qa').canonicalContent)
      .toContain('价格多少')
    expect(validateManualArtifact(artifact('#### 1. 价格多少？\n\n回答：100 元'), 'preset_qa').canonicalContent)
      .toContain('价格多少')
    expect(validateManualArtifact(Buffer.from('## 问题：价格多少？\n\n### 答案\n\n100 元'), 'preset_qa').canonicalContent)
      .toContain('价格多少')
  })

  it('rejects local/app-managed provenance, wrong trust kind, and permissive QA prose', () => {
    const invalid = (body: string, kind = 'source_document', mode = 'manual'): Buffer => Buffer.from([
      '---',
      'qaing_schema: "qaing-converted/v1"',
      `content_kind: "${kind}"`,
      `conversion_mode: "${mode}"`,
      '---',
      body,
    ].join('\n'))
    expect(() => validateManualArtifact(invalid('# A', 'source_document', 'local'), 'document')).toThrow()
    expect(() => validateManualArtifact(invalid('# A', 'preset_qa'), 'document')).toThrow()
    expect(() => validateManualArtifact(invalid('普通问答散文', 'preset_qa'), 'preset_qa')).toThrow()
  })

  it('rejects dangerous HTML, escaping resources, and malformed UTF-8 in plain Markdown', () => {
    expect(() => validateManualArtifact(Buffer.from('safe\n\n<svg onload=alert(1)>'), 'document')).toThrow()
    expect(() => validateManualArtifact(Buffer.from('safe\n\n<div style="background:url(https://invalid)">'), 'document')).toThrow()
    expect(() => validateManualArtifact(Buffer.from('safe\n\n[escape](../outside.txt)'), 'document')).toThrow()
    expect(() => validateManualArtifact(Uint8Array.from([0xff]), 'document')).toThrowError(ProjectSyncError)
  })
})
