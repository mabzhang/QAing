import { execFile } from 'node:child_process'
import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareProjectRoot } from './layout'
import { BoundedProjectScanner } from './scanner'

const execFileAsync = promisify(execFile)
const fixtures: string[] = []

async function fixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'qaing-project-'))
  fixtures.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('project layout and scanner', () => {
  it('creates the fixed layout and minimal durable metadata', async () => {
    const root = await fixture()
    const project = await prepareProjectRoot({ rootPath: root, createMissing: true, now: 123 })
    expect(project.rootPath).toBe(await realpath(root))
    expect(JSON.parse(await readFile(join(root, '.qaing', 'project.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      projectId: project.id,
      createdAt: 123,
    })
    await expect(prepareProjectRoot({
      rootPath: root,
      projectId: project.id,
      createMissing: false,
    })).resolves.toMatchObject({ id: project.id })
  })

  it('never follows symlinks and reports special files without reading them', async () => {
    const root = await fixture()
    const outside = await fixture()
    const project = await prepareProjectRoot({ rootPath: root, createMissing: true })
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(root, '原始资料', 'escape.txt'))
    await execFileAsync('/usr/bin/mkfifo', [join(root, '原始资料', 'pipe')])
    const scan = await new BoundedProjectScanner().scan(project, new AbortController().signal)
    expect(scan.observations).toHaveLength(0)
    expect(scan.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: '原始资料/escape.txt', errorCode: 'INPUT_SYMLINK_BLOCKED' }),
      expect.objectContaining({ relativePath: '原始资料/pipe', errorCode: 'INPUT_SPECIAL_FILE_BLOCKED' }),
    ]))
  })

  it('hashes local inputs and finds manual artifacts in a separate pass', async () => {
    const root = await fixture()
    const project = await prepareProjectRoot({ rootPath: root, createMissing: true })
    await mkdir(join(root, '原始资料', '子目录'))
    await writeFile(join(root, '原始资料', '子目录', 'a.txt'), 'hello')
    await writeFile(join(root, '转换资料库', '资料', 'manual.md'), [
      '---',
      'qaing_schema: "qaing-converted/v1"',
      'content_kind: "source_document"',
      'conversion_mode: "manual"',
      '---',
      '# 手动资料',
      '',
      '正文',
      '',
    ].join('\n'))
    const scan = await new BoundedProjectScanner().scan(project, new AbortController().signal)
    expect(scan.observations).toEqual([
      expect.objectContaining({ relativePath: '原始资料/子目录/a.txt', detectedType: 'text', disposition: 'local' }),
    ])
    expect(scan.artifacts).toEqual([
      expect.objectContaining({ relativePath: '转换资料库/资料/manual.md', trustKind: 'document' }),
    ])
  })

  it('fails the entire complete scan on a hard capacity limit', async () => {
    const root = await fixture()
    const project = await prepareProjectRoot({ rootPath: root, createMissing: true })
    await writeFile(join(root, '原始资料', 'a.txt'), 'a')
    await writeFile(join(root, '原始资料', 'b.txt'), 'b')
    const scanner = new BoundedProjectScanner({ maxFiles: 1, maxEntries: 20 })
    await expect(scanner.scan(project, new AbortController().signal)).rejects.toMatchObject({
      code: 'INPUT_LIMIT_EXCEEDED',
    })
  })

  it('does not treat hard-link aliases as independent trusted sources', async () => {
    const root = await fixture()
    const project = await prepareProjectRoot({ rootPath: root, createMissing: true })
    const first = join(root, '原始资料', 'a.txt')
    await writeFile(first, 'same inode')
    await link(first, join(root, '预设QA', 'alias.txt'))
    const scan = await new BoundedProjectScanner().scan(project, new AbortController().signal)
    expect(scan.observations).toHaveLength(1)
    expect(scan.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'INPUT_PATH_COLLISION' }),
    ]))
  })

  it('fails a complete scan when the deadline expires', async () => {
    const root = await fixture()
    const project = await prepareProjectRoot({ rootPath: root, createMissing: true })
    await writeFile(join(root, '原始资料', 'a.txt'), 'a')
    let now = 0
    const scanner = new BoundedProjectScanner({ timeoutMs: 1 }, { now: () => now++ })
    await expect(scanner.scan(project, new AbortController().signal)).rejects.toMatchObject({
      code: 'INPUT_SCAN_TIMEOUT',
    })
  })

  it('rejects an input that changes between quick observation and descriptor hashing', async () => {
    const root = await fixture()
    const project = await prepareProjectRoot({ rootPath: root, createMissing: true })
    const path = join(root, '原始资料', 'a.txt')
    await writeFile(path, 'first')
    const scanner = new BoundedProjectScanner({}, {
      onHash: async () => { await writeFile(path, 'changed after stat') },
    })
    await expect(scanner.scan(project, new AbortController().signal)).rejects.toMatchObject({
      code: 'INPUT_CHANGED_DURING_READ',
    })
  })
})
