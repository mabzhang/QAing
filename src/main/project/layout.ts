import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ProjectSyncError } from './errors'
import { fsyncDirectory, readRootIdentity } from './filesystem'
import {
  PROJECT_SCHEMA_VERSION,
  type PrepareProjectRootInput,
  type ProjectDescriptor,
} from './types'

export const PROJECT_INPUT_DOCUMENTS_DIRECTORY = '原始资料'
export const PROJECT_INPUT_QA_DIRECTORY = '预设QA'
export const PROJECT_OUTPUT_DIRECTORY = '转换资料库'
export const PROJECT_OUTPUT_DOCUMENTS_DIRECTORY = '资料'
export const PROJECT_OUTPUT_QA_DIRECTORY = '预设QA'
export const PROJECT_INTERNAL_DIRECTORY = '.qaing'
export const PROJECT_METADATA_FILE = 'project.json'

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

interface ProjectMetadata {
  readonly schemaVersion: number
  readonly projectId: string
  readonly createdAt: number
}

function parseMetadata(raw: string): ProjectMetadata {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new ProjectSyncError('PROJECT_METADATA_INVALID', 'Project metadata is not valid JSON', false,
      error instanceof Error ? { cause: error } : undefined)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectSyncError('PROJECT_METADATA_INVALID')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'createdAt,projectId,schemaVersion' ||
      record.schemaVersion !== PROJECT_SCHEMA_VERSION ||
      typeof record.projectId !== 'string' || !PROJECT_ID.test(record.projectId) ||
      typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
    throw new ProjectSyncError('PROJECT_METADATA_INVALID')
  }
  return { schemaVersion: record.schemaVersion, projectId: record.projectId, createdAt: record.createdAt }
}

async function ensureDirectDirectory(path: string, createMissing: boolean, mode: number): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new ProjectSyncError('PROJECT_LAYOUT_INVALID')
  } catch (error) {
    if (error instanceof ProjectSyncError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ProjectSyncError('PROJECT_LAYOUT_INVALID', 'Project layout could not be inspected', false,
        error instanceof Error ? { cause: error } : undefined)
    }
    if (!createMissing) throw new ProjectSyncError('PROJECT_LAYOUT_MISSING')
    try {
      await mkdir(path, { mode })
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
    }
    const created = await lstat(path)
    if (created.isSymbolicLink() || !created.isDirectory()) throw new ProjectSyncError('PROJECT_LAYOUT_INVALID')
  }
}

async function readMetadata(path: string): Promise<ProjectMetadata | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size < 1 || stats.size > 16 * 1024) {
        throw new ProjectSyncError('PROJECT_METADATA_INVALID')
      }
      return parseMetadata(await handle.readFile({ encoding: 'utf8' }))
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new ProjectSyncError('PROJECT_LAYOUT_INVALID')
    if (error instanceof ProjectSyncError) throw error
    throw new ProjectSyncError('PROJECT_METADATA_INVALID', 'Project metadata could not be read', false,
      error instanceof Error ? { cause: error } : undefined)
  }
}

async function writeMetadata(path: string, metadata: ProjectMetadata): Promise<void> {
  const temporary = join(dirname(path), `.project.${randomUUID()}.tmp`)
  const payload = `${JSON.stringify(metadata, null, 2)}\n`
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(payload, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
    await fsyncDirectory(dirname(path))
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function prepareProjectRoot(input: PrepareProjectRootInput): Promise<ProjectDescriptor> {
  const identity = await readRootIdentity(input.rootPath)
  const rootPath = identity.canonicalPath
  if (/\.(?:app|bundle|framework|pkg|plugin)$/iu.test(basename(rootPath))) {
    throw new ProjectSyncError('PROJECT_LAYOUT_INVALID')
  }
  const directDirectories: ReadonlyArray<readonly [string, number]> = [
    [PROJECT_INPUT_DOCUMENTS_DIRECTORY, 0o755],
    [PROJECT_INPUT_QA_DIRECTORY, 0o755],
    [PROJECT_OUTPUT_DIRECTORY, 0o755],
    [PROJECT_INTERNAL_DIRECTORY, 0o700],
  ]
  for (const [name, mode] of directDirectories) {
    await ensureDirectDirectory(join(rootPath, name), input.createMissing, mode)
  }
  await ensureDirectDirectory(join(rootPath, PROJECT_OUTPUT_DIRECTORY, PROJECT_OUTPUT_DOCUMENTS_DIRECTORY), input.createMissing, 0o755)
  await ensureDirectDirectory(join(rootPath, PROJECT_OUTPUT_DIRECTORY, PROJECT_OUTPUT_QA_DIRECTORY), input.createMissing, 0o755)

  const metadataPath = join(rootPath, PROJECT_INTERNAL_DIRECTORY, PROJECT_METADATA_FILE)
  let metadata = await readMetadata(metadataPath)
  if (!metadata) {
    if (!input.createMissing) throw new ProjectSyncError('PROJECT_LAYOUT_MISSING')
    const projectId = input.projectId ?? randomUUID()
    if (!PROJECT_ID.test(projectId)) throw new ProjectSyncError('PROJECT_METADATA_INVALID')
    metadata = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId,
      createdAt: input.now ?? Date.now(),
    }
    await writeMetadata(metadataPath, metadata)
    // A concurrent creator is not expected under the main-process single-writer
    // contract, but always re-read the durable file before trusting it.
    metadata = await readMetadata(metadataPath)
    if (!metadata) throw new ProjectSyncError('PROJECT_METADATA_INVALID')
  }
  if (input.projectId !== undefined && input.projectId !== metadata.projectId) {
    throw new ProjectSyncError('PROJECT_ID_MISMATCH')
  }
  return {
    id: metadata.projectId,
    rootPath,
    rootIdentity: identity,
    schemaVersion: metadata.schemaVersion,
    createdAt: metadata.createdAt,
    availability: 'available',
  }
}

export async function verifyProjectDescriptor(project: ProjectDescriptor): Promise<ProjectDescriptor> {
  const current = await prepareProjectRoot({
    rootPath: project.rootPath,
    projectId: project.id,
    createMissing: false,
  })
  if (current.rootIdentity.device !== project.rootIdentity.device ||
      current.rootIdentity.inode !== project.rootIdentity.inode ||
      current.rootIdentity.canonicalPath !== project.rootIdentity.canonicalPath) {
    throw new ProjectSyncError('PROJECT_ROOT_IDENTITY_CHANGED')
  }
  return current
}
