import { createHash } from 'node:crypto'
import { ProjectSyncError } from './errors'
import type { ProjectTrustKind } from './types'

const MAX_FRONTMATTER_BYTES = 16 * 1024
const FORBIDDEN = /<(?:script|iframe|object|embed|link|meta|base|style|svg|math|form|input|button|textarea|select|option|video|audio|canvas)\b|\b(?:on[a-z][a-z0-9_-]*|style|srcdoc)\s*=|\b(?:src|href|srcset|poster|action|formaction|xlink:href)\s*=\s*(?:["']\s*)?(?:https?:|file:|\/|javascript:|data:)|!?\[[^\]]*\]\(\s*(?:https?:|file:|\/|~|javascript:|data:|\.\.(?:\/|\\))/iu
const ABSOLUTE_PATH = /(?:^|[\s("'`])\/(?:Applications|Library|System|Users|Volumes|private|tmp)(?:\/|\b)/mu
const QAING_METADATA_KEY = /^qaing_schema\s*:/mu

export interface ValidatedManualArtifact {
  readonly canonicalContent: string
  readonly outputSha256: string
  readonly canonicalBodySha256: string
}

function normalize(value: string): string {
  return value.replace(/^\uFEFF/u, '').normalize('NFC').replace(/\r\n?/gu, '\n').replace(/[\t ]+$/gmu, '').trim()
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new ProjectSyncError('INPUT_ENCODING_INVALID', 'INPUT_ENCODING_INVALID', false,
      error instanceof Error ? { cause: error } : undefined)
  }
}

function parseFrontmatter(value: string): { readonly metadata: ReadonlyMap<string, string>; readonly body: string } {
  if (!value.startsWith('---\n')) throw new ProjectSyncError('OUTPUT_INVALID')
  const boundary = value.indexOf('\n---\n', 4)
  if (boundary < 0 || boundary > MAX_FRONTMATTER_BYTES) throw new ProjectSyncError('OUTPUT_INVALID')
  const metadata = new Map<string, string>()
  for (const line of value.slice(4, boundary).split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 1) throw new ProjectSyncError('OUTPUT_INVALID')
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key) || metadata.has(key)) throw new ProjectSyncError('OUTPUT_INVALID')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      parsed = raw
    }
    if (typeof parsed !== 'string' || parsed.length > 4_096) throw new ProjectSyncError('OUTPUT_INVALID')
    metadata.set(key, parsed)
  }
  const body = value.slice(boundary + '\n---\n'.length).trim()
  if (!body) throw new ProjectSyncError('OUTPUT_INVALID')
  return { metadata, body }
}

function manualBody(value: string, trustKind: ProjectTrustKind): string {
  if (!value.startsWith('---\n')) return value.trim()
  const boundary = value.indexOf('\n---\n', 4)
  const candidateMetadata = boundary < 0
    ? value.slice(4, Math.min(value.length, MAX_FRONTMATTER_BYTES))
    : value.slice(4, boundary)
  // Ordinary user Markdown may start with a horizontal rule or generic YAML.
  // Only an explicit QAing provenance claim is interpreted as managed
  // frontmatter; malformed or contradictory QAing claims fail closed.
  if (!QAING_METADATA_KEY.test(candidateMetadata)) return value.trim()
  const { metadata, body } = parseFrontmatter(value)
  if (metadata.get('qaing_schema') !== 'qaing-converted/v1' || metadata.get('conversion_mode') !== 'manual') {
    throw new ProjectSyncError('OUTPUT_INVALID')
  }
  const expectedKind = trustKind === 'document' ? 'source_document' : 'preset_qa'
  if (metadata.get('content_kind') !== expectedKind) throw new ProjectSyncError('OUTPUT_INVALID')
  return body
}

function validateQa(body: string): void {
  const hasQuestionShape = /^##\s+(?:问题|Question)\s*[:：]\s*\S+/imu.test(body) ||
    /^\*\*\s*\d+\.\s*\S.+\*\*\s*$/mu.test(body) ||
    /^####\s*\d+\.\s*\S+/mu.test(body)
  const hasAnswerShape = /^###\s+(?:答案|Answer)\s*$/imu.test(body) || /^回答：\s*\S*/mu.test(body)
  if (!hasQuestionShape || !hasAnswerShape) throw new ProjectSyncError('OUTPUT_INVALID')
}

export function validateManualArtifact(bytes: Uint8Array, trustKind: ProjectTrustKind): ValidatedManualArtifact {
  const canonicalContent = `${normalize(decode(bytes))}\n`
  if (FORBIDDEN.test(canonicalContent) || ABSOLUTE_PATH.test(canonicalContent) || canonicalContent.includes('\0')) {
    throw new ProjectSyncError('OUTPUT_INVALID')
  }
  const body = manualBody(canonicalContent, trustKind)
  if (!body) throw new ProjectSyncError('OUTPUT_INVALID')
  if (trustKind === 'preset_qa') validateQa(body)
  return {
    canonicalContent: body,
    outputSha256: createHash('sha256').update(bytes).digest('hex'),
    canonicalBodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
  }
}
