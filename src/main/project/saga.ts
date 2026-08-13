import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalBody } from './canonical'
import { ProjectSyncError, throwIfAborted } from './errors'
import {
  fsyncDirectory,
  isPathInside,
  readStableFile,
  resolveInside,
} from './filesystem'

async function ensureOutputDirectory(rootPath: string, relativeDirectory: string): Promise<string> {
  let current = rootPath
  for (const component of relativeDirectory.split('/').filter(Boolean)) {
    current = join(current, component)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new ProjectSyncError('PROJECT_LAYOUT_INVALID')
    } catch (error) {
      if (error instanceof ProjectSyncError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current, { mode: 0o755 })
      const stats = await lstat(current)
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new ProjectSyncError('PROJECT_LAYOUT_INVALID')
    }
    const canonical = await realpath(current)
    if (!isPathInside(rootPath, canonical)) throw new ProjectSyncError('INPUT_ESCAPES_ROOT')
  }
  return current
}

async function existingHash(
  rootPath: string,
  relativePath: string,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    return (await readStableFile(rootPath, relativePath, maxOutputBytes, signal, false)).sha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error instanceof ProjectSyncError && error.cause instanceof Error &&
          (error.cause as NodeJS.ErrnoException).code === 'ENOENT')) return null
    throw error
  }
}

export interface StagedArtifact {
  readonly tempRelativePath: string
  readonly finalRelativePath: string
  readonly outputSha256: string
}

export function stagingRelativePath(operationId: string, finalRelativePath: string): string {
  return `${dirname(finalRelativePath).replaceAll('\\', '/')}/.qaing-${operationId}.tmp`
}

export async function stageCanonicalArtifact(input: {
  readonly rootPath: string
  readonly operationId: string
  readonly finalRelativePath: string
  readonly canonicalMarkdown: string
  readonly outputSha256: string
  readonly maxOutputBytes: number
  readonly signal: AbortSignal
}): Promise<StagedArtifact> {
  throwIfAborted(input.signal)
  const bytes = Buffer.from(input.canonicalMarkdown, 'utf8')
  if (bytes.byteLength < 1 || bytes.byteLength > input.maxOutputBytes) throw new ProjectSyncError('OUTPUT_TOO_LARGE')
  if (createHash('sha256').update(bytes).digest('hex') !== input.outputSha256) {
    throw new ProjectSyncError('OUTPUT_INVALID')
  }
  const finalDirectory = dirname(input.finalRelativePath).replaceAll('\\', '/')
  const absoluteDirectory = await ensureOutputDirectory(input.rootPath, finalDirectory)
  const tempRelativePath = stagingRelativePath(input.operationId, input.finalRelativePath)
  const tempPath = resolveInside(input.rootPath, tempRelativePath)
  const handle = await open(
    tempPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  let completed = false
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    completed = true
  } finally {
    await handle.close()
    if (!completed) await rm(tempPath, { force: true })
  }
  await fsyncDirectory(absoluteDirectory)
  return {
    tempRelativePath,
    finalRelativePath: input.finalRelativePath,
    outputSha256: input.outputSha256,
  }
}

export async function publishStagedArtifact(input: {
  readonly rootPath: string
  readonly staged: StagedArtifact
  readonly expectedExistingSha256: string | null
  readonly maxOutputBytes: number
  readonly signal: AbortSignal
}): Promise<void> {
  throwIfAborted(input.signal)
  const currentHash = await existingHash(
    input.rootPath,
    input.staged.finalRelativePath,
    input.maxOutputBytes,
    input.signal,
  )
  if (currentHash !== input.expectedExistingSha256) {
    throw new ProjectSyncError('GENERATED_OUTPUT_MODIFIED')
  }
  const tempPath = resolveInside(input.rootPath, input.staged.tempRelativePath)
  const finalPath = resolveInside(input.rootPath, input.staged.finalRelativePath)
  await rename(tempPath, finalPath)
  await fsyncDirectory(dirname(finalPath))
  const publishedHash = await existingHash(
    input.rootPath,
    input.staged.finalRelativePath,
    input.maxOutputBytes,
    input.signal,
  )
  if (publishedHash !== input.staged.outputSha256) throw new ProjectSyncError('OUTPUT_INVALID')
}

export async function discardStagedArtifact(rootPath: string, tempRelativePath: string): Promise<void> {
  const tempPath = resolveInside(rootPath, tempRelativePath)
  await rm(tempPath, { force: true })
  await fsyncDirectory(dirname(tempPath)).catch(() => undefined)
}

/**
 * Removes only an app-owned published artifact whose bytes still match the
 * conversion job. A user-modified artifact is never removed by recovery.
 */
export async function discardPublishedArtifact(input: {
  readonly rootPath: string
  readonly relativePath: string
  readonly expectedHash: string
  readonly maxOutputBytes: number
  readonly signal: AbortSignal
}): Promise<boolean> {
  throwIfAborted(input.signal)
  const currentHash = await existingHash(input.rootPath, input.relativePath, input.maxOutputBytes, input.signal)
  if (currentHash === null) return false
  if (currentHash !== input.expectedHash) throw new ProjectSyncError('GENERATED_OUTPUT_MODIFIED')
  const outputPath = resolveInside(input.rootPath, input.relativePath)
  await rm(outputPath)
  await fsyncDirectory(dirname(outputPath))
  return true
}

export async function readPublishedCanonical(input: {
  readonly rootPath: string
  readonly relativePath: string
  readonly expectedHash: string
  readonly maxOutputBytes: number
  readonly signal: AbortSignal
}): Promise<{
  readonly canonicalMarkdown: string
  readonly canonicalBody: string
  readonly size: number
  readonly mtimeNs: string
  readonly device: string
  readonly inode: string
}> {
  const read = await readStableFile(input.rootPath, input.relativePath, input.maxOutputBytes, input.signal, true)
  if (read.sha256 !== input.expectedHash) throw new ProjectSyncError('OUTPUT_INVALID')
  let canonicalMarkdown: string
  try {
    canonicalMarkdown = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
  } catch (error) {
    throw new ProjectSyncError('OUTPUT_INVALID', 'OUTPUT_INVALID', false,
      error instanceof Error ? { cause: error } : undefined)
  }
  return {
    canonicalMarkdown,
    canonicalBody: canonicalBody(canonicalMarkdown),
    size: read.size,
    mtimeNs: read.mtimeNs,
    device: read.device,
    inode: read.inode,
  }
}
