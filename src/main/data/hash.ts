import { createHash } from 'node:crypto'

export function normalizeContent(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+$/gm, '')
    .trim()
}

export function normalizeQuestion(value: string): string {
  return normalizeContent(value).normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}_${sha256(value).slice(0, 24)}`
}
