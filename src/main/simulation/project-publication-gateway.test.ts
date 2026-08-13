import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROJECT_OUTPUT_DIRECTORY,
  PROJECT_OUTPUT_QA_DIRECTORY,
} from '../project/layout'
import {
  ProjectSimulationPublicationGateway,
} from './project-publication-gateway'
import type { SimulationPublicationGateway } from './application'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qaing-simulation-publication-'))
  temporaryRoots.push(root)
  await mkdir(join(root, PROJECT_OUTPUT_DIRECTORY, PROJECT_OUTPUT_QA_DIRECTORY), { recursive: true })
  return root
}

function input(root: string): Parameters<SimulationPublicationGateway['publish']>[0] {
  void root
  const canonicalMarkdown = '# 预设 QA\n\n## 预算\n\n**1. 预算多少？**\n\n回答：100万元。\n'
  return {
    operationId: 'publish-operation',
    projectId: 'project-a',
    jobId: 'job-a',
    publicationId: 'publication-a',
    canonicalMarkdown,
    canonicalBodySha256: createHash('sha256').update(canonicalMarkdown.trim(), 'utf8').digest('hex'),
    itemIds: ['item-a'],
    items: [{ itemId: 'item-a', question: '预算多少？', answer: '100万元。' }],
    signal: new AbortController().signal,
  }
}

function targetPath(root: string): string {
  const suffix = createHash('sha256').update('job-a\0publication-a').digest('hex').slice(0, 16)
  return join(
    root, PROJECT_OUTPUT_DIRECTORY, PROJECT_OUTPUT_QA_DIRECTORY,
    `QAing模拟问答-job-a-publication-a-${suffix}.md`,
  )
}

function gateway(root: string, sync = vi.fn(async () => ({
  projectId: 'project-a', runId: 'run-a', generation: 1, phase: 'complete' as const,
  counts: {
    discovered: 1, unchanged: 0, converted: 0, external: 0, unsupported: 0,
    blocked: 0, missingGrace: 0, tombstoned: 0, failed: 0,
  },
  completedAt: 100,
}))) {
  const resolveMappings = vi.fn(() => [{ itemId: 'item-a', presetQaId: 'preset-a' }])
  return {
    instance: new ProjectSimulationPublicationGateway({
      getProjectRootPath: async () => root,
      syncProject: sync,
      resolveMappings,
    }),
    sync,
    resolveMappings,
  }
}

describe('project simulation publication gateway', () => {
  it('atomically creates a managed QA artifact, applies ProjectSync, and resolves active mappings', async () => {
    const root = await projectRoot()
    const subject = gateway(root)
    await expect(subject.instance.publish(input(root))).resolves.toEqual({
      mappings: [{ itemId: 'item-a', presetQaId: 'preset-a' }],
    })
    const target = targetPath(root)
    await expect(readFile(target, 'utf8')).resolves.toBe(input(root).canonicalMarkdown)
    expect(subject.sync).toHaveBeenCalledWith(
      { projectId: 'project-a', trigger: 'manual', apply: true },
      expect.any(AbortSignal),
    )
    expect(subject.resolveMappings).toHaveBeenCalledWith({
      projectId: 'project-a',
      items: [{ itemId: 'item-a', question: '预算多少？', answer: '100万元。' }],
    })
  })

  it('replays identical content and refuses to overwrite different user content', async () => {
    const root = await projectRoot()
    const subject = gateway(root)
    await subject.instance.publish(input(root))
    await expect(subject.instance.publish(input(root))).resolves.toMatchObject({ mappings: [{ itemId: 'item-a' }] })
    const target = targetPath(root)
    await writeFile(target, '用户已修改', 'utf8')
    await expect(subject.instance.publish(input(root))).rejects.toMatchObject({
      message: 'PUBLICATION_TARGET_CONFLICT', definitelyNotCommitted: true,
    })
    await expect(readFile(target, 'utf8')).resolves.toBe('用户已修改')
  })

  it('rejects a symlinked output directory without writing outside the project', async () => {
    const root = await projectRoot()
    const outside = await mkdtemp(join(tmpdir(), 'qaing-simulation-outside-'))
    temporaryRoots.push(outside)
    const qaDirectory = join(root, PROJECT_OUTPUT_DIRECTORY, PROJECT_OUTPUT_QA_DIRECTORY)
    await rm(qaDirectory, { recursive: true })
    await symlink(outside, qaDirectory)
    const subject = gateway(root)
    await expect(subject.instance.publish(input(root))).rejects.toMatchObject({
      message: 'PUBLICATION_DIRECTORY_INVALID', definitelyNotCommitted: true,
    })
  })

  it('rejects a mismatched prepared body hash before publishing a file', async () => {
    const root = await projectRoot()
    const subject = gateway(root)
    await expect(subject.instance.publish({
      ...input(root),
      canonicalBodySha256: 'f'.repeat(64),
    })).rejects.toMatchObject({ message: 'PUBLICATION_BODY_HASH_MISMATCH', definitelyNotCommitted: true })
  })

  it('classifies any failure after durable file publication as unknown commit state', async () => {
    const root = await projectRoot()
    const subject = gateway(root, vi.fn(async () => { throw new Error('sync crashed') }))
    await expect(subject.instance.publish(input(root))).rejects.toMatchObject({
      message: 'PUBLICATION_COMMIT_UNKNOWN', definitelyNotCommitted: false,
    })
    const target = targetPath(root)
    await expect(readFile(target, 'utf8')).resolves.toBe(input(root).canonicalMarkdown)
  })
})
