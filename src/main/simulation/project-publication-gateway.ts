import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  PROJECT_OUTPUT_DIRECTORY,
  PROJECT_OUTPUT_QA_DIRECTORY,
} from '../project/layout'
import type { ProjectSyncResult } from '../project/types'
import { normalizeContent } from '../data/hash'
import {
  SimulationPublicationGatewayError,
  type SimulationPublicationGateway,
  type SimulationPublicationMapping,
} from './application'

const MAX_PUBLICATION_BYTES = 4 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u

interface ProjectPublicationGatewayOptions {
  readonly getProjectRootPath: (projectId: string) => string | null | Promise<string | null>
  readonly syncProject: (
    input: { readonly projectId: string; readonly trigger: 'manual'; readonly apply: true },
    signal: AbortSignal,
  ) => Promise<ProjectSyncResult>
  readonly resolveMappings: (input: {
    readonly projectId: string
    readonly items: ReadonlyArray<{
      readonly itemId: string
      readonly question: string
      readonly answer: string
    }>
  }) => readonly SimulationPublicationMapping[]
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function throwIfAborted(signal: AbortSignal, definitelyNotCommitted: boolean): void {
  if (signal.aborted) throw new SimulationPublicationGatewayError('PUBLICATION_CANCELLED', definitelyNotCommitted)
}

function validateId(value: string): string {
  if (!SAFE_ID.test(value)) throw new SimulationPublicationGatewayError('INVALID_PUBLICATION_ID', true)
  return value
}

async function assertDirectDirectory(path: string): Promise<void> {
  const stats = await lstat(path)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SimulationPublicationGatewayError('PUBLICATION_DIRECTORY_INVALID', true)
  }
}

async function readExistingHash(path: string): Promise<string | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size > MAX_PUBLICATION_BYTES) {
        throw new SimulationPublicationGatewayError('PUBLICATION_TARGET_CONFLICT', true)
      }
      return sha256(await handle.readFile())
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SimulationPublicationGatewayError) throw error
    throw new SimulationPublicationGatewayError('PUBLICATION_TARGET_UNREADABLE', true)
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, content: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < content.byteLength) {
    const { bytesWritten } = await handle.write(content, offset, content.byteLength - offset, offset)
    if (bytesWritten < 1) throw new SimulationPublicationGatewayError('PUBLICATION_WRITE_FAILED', true)
    offset += bytesWritten
  }
}

async function publishNoReplace(target: string, content: Uint8Array): Promise<'inserted' | 'replayed'> {
  const directory = dirname(target)
  const expectedHash = sha256(content)
  const existingHash = await readExistingHash(target)
  if (existingHash !== null) {
    if (existingHash !== expectedHash) throw new SimulationPublicationGatewayError('PUBLICATION_TARGET_CONFLICT', true)
    return 'replayed'
  }
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`)
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await writeAll(handle, content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  let linked = false
  try {
    // Node's rename overwrites an existing path on macOS. A hard-link publish
    // provides the required atomic no-replace guarantee, preventing a race
    // from overwriting user content between inspection and publication.
    await link(temporary, target)
    linked = true
    await syncDirectory(directory)
    return 'inserted'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const racedHash = await readExistingHash(target)
      if (racedHash === expectedHash) return 'replayed'
      throw new SimulationPublicationGatewayError('PUBLICATION_TARGET_CONFLICT', true)
    }
    throw new SimulationPublicationGatewayError(
      linked ? 'PUBLICATION_COMMIT_UNKNOWN' : 'PUBLICATION_PUBLISH_FAILED',
      !linked,
    )
  } finally {
    try {
      await rm(temporary, { force: true })
      if (linked) await syncDirectory(directory)
    } catch {
      // Once target publication is durable, a hidden temporary hard-link is
      // harmless and is excluded by the project scanner. Never misclassify
      // successful publication because cleanup itself failed.
    }
  }
}

export class ProjectSimulationPublicationGateway implements SimulationPublicationGateway {
  readonly #getProjectRootPath: ProjectPublicationGatewayOptions['getProjectRootPath']
  readonly #syncProject: ProjectPublicationGatewayOptions['syncProject']
  readonly #resolveMappings: ProjectPublicationGatewayOptions['resolveMappings']

  constructor(options: ProjectPublicationGatewayOptions) {
    this.#getProjectRootPath = options.getProjectRootPath
    this.#syncProject = options.syncProject
    this.#resolveMappings = options.resolveMappings
  }

  async publish(input: Parameters<SimulationPublicationGateway['publish']>[0]): Promise<{
    readonly mappings: readonly SimulationPublicationMapping[]
  }> {
    throwIfAborted(input.signal, true)
    const jobId = validateId(input.jobId)
    const publicationId = validateId(input.publicationId)
    const rootValue = await this.#getProjectRootPath(input.projectId)
    if (!rootValue) throw new SimulationPublicationGatewayError('PROJECT_ROOT_UNAVAILABLE', true)
    const rootPath = await realpath(rootValue)
    const outputRoot = join(rootPath, PROJECT_OUTPUT_DIRECTORY)
    const qaDirectory = join(outputRoot, PROJECT_OUTPUT_QA_DIRECTORY)
    await assertDirectDirectory(outputRoot)
    await assertDirectDirectory(qaDirectory)
    const canonicalDirectory = await realpath(qaDirectory)
    const expectedDirectory = resolve(rootPath, PROJECT_OUTPUT_DIRECTORY, PROJECT_OUTPUT_QA_DIRECTORY)
    if (canonicalDirectory !== expectedDirectory) {
      throw new SimulationPublicationGatewayError('PUBLICATION_DIRECTORY_ESCAPES_PROJECT', true)
    }
    const nameDigest = createHash('sha256').update(`${jobId}\0${publicationId}`).digest('hex').slice(0, 16)
    const target = join(
      canonicalDirectory,
      `QAing模拟问答-${jobId.slice(0, 24)}-${publicationId.slice(0, 24)}-${nameDigest}.md`,
    )
    const targetRelative = relative(rootPath, target)
    if (!targetRelative || targetRelative.startsWith(`..${sep}`) || targetRelative === '..') {
      throw new SimulationPublicationGatewayError('PUBLICATION_PATH_ESCAPES_PROJECT', true)
    }
    const content = new TextEncoder().encode(input.canonicalMarkdown)
    const bodyHash = createHash('sha256')
      .update(normalizeContent(input.canonicalMarkdown), 'utf8')
      .digest('hex')
    if (bodyHash !== input.canonicalBodySha256) {
      throw new SimulationPublicationGatewayError('PUBLICATION_BODY_HASH_MISMATCH', true)
    }
    if (content.byteLength < 1 || content.byteLength > MAX_PUBLICATION_BYTES) {
      throw new SimulationPublicationGatewayError('PUBLICATION_OUTPUT_TOO_LARGE', true)
    }
    throwIfAborted(input.signal, true)
    await publishNoReplace(target, content)
    // Once a file is durably visible the outcome is no longer known-zero.
    // Any later failure leaves the prepared operation replayable by operationId.
    try {
      throwIfAborted(input.signal, false)
      const sync = await this.#syncProject({ projectId: input.projectId, trigger: 'manual', apply: true }, input.signal)
      if (sync.phase !== 'complete') throw new Error('sync did not complete')
      throwIfAborted(input.signal, false)
      return {
        mappings: this.#resolveMappings({ projectId: input.projectId, items: input.items }),
      }
    } catch (error) {
      if (error instanceof SimulationPublicationGatewayError && !error.definitelyNotCommitted) throw error
      throw new SimulationPublicationGatewayError('PUBLICATION_COMMIT_UNKNOWN', false)
    }
  }
}
