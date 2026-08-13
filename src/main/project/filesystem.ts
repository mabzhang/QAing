import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ProjectSyncError, throwIfAborted } from './errors'
import type { ProjectRootIdentity } from './types'

const READ_CHUNK_BYTES = 64 * 1024

export function normalizedRelativePath(value: string): string {
  const normalized = value.normalize('NFC').replaceAll('\\', '/')
  if (!normalized || normalized.includes('\0') || isAbsolute(normalized)) {
    throw new ProjectSyncError('INPUT_ESCAPES_ROOT')
  }
  const components = normalized.split('/')
  if (components.some((component) => !component || component === '.' || component === '..')) {
    throw new ProjectSyncError('INPUT_ESCAPES_ROOT')
  }
  return components.join('/')
}

export function relativePathKey(value: string): string {
  return normalizedRelativePath(value).normalize('NFKC').toLocaleLowerCase('zh-CN')
}

export function resolveInside(rootPath: string, relativePath: string): string {
  const normalized = normalizedRelativePath(relativePath)
  const candidate = resolve(rootPath, ...normalized.split('/'))
  if (!isPathInside(rootPath, candidate)) throw new ProjectSyncError('INPUT_ESCAPES_ROOT')
  return candidate
}

export function isPathInside(rootPath: string, candidate: string): boolean {
  const child = relative(rootPath, candidate)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

export async function readRootIdentity(rootPath: string): Promise<ProjectRootIdentity> {
  try {
    const canonicalPath = await realpath(rootPath)
    const stats = await lstat(canonicalPath, { bigint: true })
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ProjectSyncError('PROJECT_ROOT_UNAVAILABLE')
    return { canonicalPath, device: stats.dev.toString(), inode: stats.ino.toString() }
  } catch (error) {
    if (error instanceof ProjectSyncError) throw error
    throw new ProjectSyncError('PROJECT_ROOT_UNAVAILABLE', 'Project root is unavailable', true,
      error instanceof Error ? { cause: error } : undefined)
  }
}

export function sameRootIdentity(left: ProjectRootIdentity, right: ProjectRootIdentity): boolean {
  return left.canonicalPath === right.canonicalPath && left.device === right.device && left.inode === right.inode
}

async function assertNoSymlinkComponents(rootPath: string, relativePath: string): Promise<void> {
  let cursor = rootPath
  for (const component of normalizedRelativePath(relativePath).split('/')) {
    cursor = resolve(cursor, component)
    const stats = await lstat(cursor)
    if (stats.isSymbolicLink()) throw new ProjectSyncError('INPUT_SYMLINK_BLOCKED')
  }
}

interface StableFileStats {
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
  readonly device: bigint
  readonly inode: bigint
}

function stableStats(stats: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>): StableFileStats {
  // This overload is only used with `{ bigint: true }`; keeping the conversion
  // local avoids leaking Node's generic Stats shape into the project contract.
  const value = stats as unknown as {
    readonly size: bigint
    readonly mtimeNs: bigint
    readonly ctimeNs: bigint
    readonly dev: bigint
    readonly ino: bigint
  }
  return {
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
    device: value.dev,
    inode: value.ino,
  }
}

function unchanged(left: StableFileStats, right: StableFileStats): boolean {
  return left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.device === right.device && left.inode === right.inode
}

export interface StableFileRead {
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly size: number
  readonly mtimeNs: string
  readonly device: string
  readonly inode: string
}

export async function readStableFile(
  rootPath: string,
  relativePath: string,
  maxBytes: number,
  signal: AbortSignal,
  includeBytes: boolean,
): Promise<StableFileRead> {
  throwIfAborted(signal)
  const canonicalRoot = (await readRootIdentity(rootPath)).canonicalPath
  const normalized = normalizedRelativePath(relativePath)
  const absolutePath = resolveInside(canonicalRoot, normalized)
  await assertNoSymlinkComponents(canonicalRoot, normalized)

  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const canonicalFile = await realpath(absolutePath)
    if (!isPathInside(canonicalRoot, canonicalFile)) throw new ProjectSyncError('INPUT_ESCAPES_ROOT')
    const beforeRaw = await handle.stat({ bigint: true })
    if (!beforeRaw.isFile()) throw new ProjectSyncError('INPUT_SPECIAL_FILE_BLOCKED')
    const before = stableStats(beforeRaw)
    const resolvedStats = await lstat(canonicalFile, { bigint: true })
    if (!resolvedStats.isFile() || resolvedStats.dev !== beforeRaw.dev || resolvedStats.ino !== beforeRaw.ino) {
      throw new ProjectSyncError('INPUT_CHANGED_DURING_READ', 'INPUT_CHANGED_DURING_READ', true)
    }
    if (before.size < 0n || before.size > BigInt(maxBytes) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProjectSyncError('INPUT_TOO_LARGE')
    }
    const expectedSize = Number(before.size)
    const output = includeBytes ? Buffer.allocUnsafe(expectedSize) : Buffer.alloc(0)
    const scratch = includeBytes ? output : Buffer.allocUnsafe(Math.max(1, Math.min(READ_CHUNK_BYTES, expectedSize)))
    const hash = createHash('sha256')
    let offset = 0
    while (offset < expectedSize) {
      throwIfAborted(signal)
      const readSize = Math.min(scratch.byteLength, expectedSize - offset)
      const { bytesRead } = await handle.read(scratch, includeBytes ? offset : 0, readSize, offset)
      if (bytesRead === 0) break
      hash.update(scratch.subarray(includeBytes ? offset : 0, (includeBytes ? offset : 0) + bytesRead))
      offset += bytesRead
    }
    const after = stableStats(await handle.stat({ bigint: true }))
    if (offset !== expectedSize || !unchanged(before, after)) {
      throw new ProjectSyncError('INPUT_CHANGED_DURING_READ', 'Input changed while it was being hashed', true)
    }
    return {
      bytes: output,
      sha256: hash.digest('hex'),
      size: expectedSize,
      mtimeNs: before.mtimeNs.toString(),
      device: before.device.toString(),
      inode: before.inode.toString(),
    }
  } catch (error) {
    if (error instanceof ProjectSyncError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') throw new ProjectSyncError('INPUT_SYMLINK_BLOCKED')
    throw new ProjectSyncError('INPUT_CHANGED_DURING_READ', 'Input could not be read safely', true,
      error instanceof Error ? { cause: error } : undefined)
  } finally {
    await handle.close()
  }
}

export async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
