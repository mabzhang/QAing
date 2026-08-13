import { lstat, opendir, realpath } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { ProjectSyncError, throwIfAborted } from './errors'
import {
  isPathInside,
  readRootIdentity,
  readStableFile,
  relativePathKey,
  sameRootIdentity,
} from './filesystem'
import {
  PROJECT_INPUT_DOCUMENTS_DIRECTORY,
  PROJECT_INPUT_QA_DIRECTORY,
  PROJECT_OUTPUT_DIRECTORY,
  PROJECT_OUTPUT_DOCUMENTS_DIRECTORY,
  PROJECT_OUTPUT_QA_DIRECTORY,
  verifyProjectDescriptor,
} from './layout'
import type {
  ProjectBlockedObservation,
  ProjectArtifactObservation,
  ProjectConversionDisposition,
  ProjectDescriptor,
  ProjectDetectedType,
  ProjectScanResult,
  ProjectScannerLimits,
  ProjectSourceObservation,
  ProjectTrustKind,
  ProjectManifestEntry,
  ProjectScanProbe,
} from './types'

export const DEFAULT_PROJECT_SCANNER_LIMITS: ProjectScannerLimits = {
  maxDepth: 12,
  maxFiles: 2_000,
  maxEntries: 8_000,
  maxFileBytes: 50 * 1024 * 1024,
  maxAggregateBytes: 2 * 1024 * 1024 * 1024,
  timeoutMs: 30_000,
}

const IGNORED_NAMES = new Set(['.ds_store', 'thumbs.db'])
const TEMPORARY_SUFFIX = /(?:\.lock|\.tmp|\.temp|\.swp|~)$/iu
const BUNDLE_SUFFIX = /\.(?:app|bundle|framework|pkg|plugin)$/iu
const ARCHIVE_SUFFIX = /\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar|dmg|iso)$/iu
const DATABASE_SUFFIX = /\.(?:db|db3|sqlite|sqlite3|mdb|accdb)$/iu
const EXECUTABLE_SUFFIX = /\.(?:exe|dll|dylib|so|bin|command|sh|bash|zsh|appimage)$/iu
const OFFICE_SUFFIX = /\.(?:docx|pptx|xlsx|rtf|html|htm)$/iu
const IMAGE_SUFFIX = /\.(?:png|jpe?g|gif|webp|heic|tiff?|bmp)$/iu
const MEDIA_SUFFIX = /\.(?:mp3|m4a|wav|aac|flac|mp4|mov|mkv|webm)$/iu

function validateLimits(value: ProjectScannerLimits): ProjectScannerLimits {
  for (const [name, limit] of Object.entries(value)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  if (value.maxFiles > value.maxEntries) throw new TypeError('maxEntries must cover maxFiles')
  return value
}

function ignoredName(name: string): boolean {
  const normalized = name.normalize('NFKC').toLocaleLowerCase('en-US')
  return normalized.startsWith('.') || IGNORED_NAMES.has(normalized) || TEMPORARY_SUFFIX.test(normalized)
}

function classifyFile(name: string, mode: number): {
  readonly detectedType: ProjectDetectedType
  readonly disposition: ProjectConversionDisposition
} {
  const extension = extname(name).toLocaleLowerCase('en-US')
  if ((mode & 0o111) !== 0 || EXECUTABLE_SUFFIX.test(extension)) {
    return { detectedType: 'executable', disposition: 'blocked' }
  }
  if (ARCHIVE_SUFFIX.test(extension)) return { detectedType: 'archive', disposition: 'blocked' }
  if (DATABASE_SUFFIX.test(extension)) return { detectedType: 'database', disposition: 'blocked' }
  if (extension === '.txt') return { detectedType: 'text', disposition: 'local' }
  if (extension === '.md' || extension === '.markdown') return { detectedType: 'markdown', disposition: 'local' }
  if (extension === '.json') return { detectedType: 'json', disposition: 'local' }
  if (extension === '.csv') return { detectedType: 'csv', disposition: 'local' }
  if (extension === '.tsv') return { detectedType: 'tsv', disposition: 'local' }
  if (extension === '.pdf') return { detectedType: 'pdf', disposition: 'external' }
  if (OFFICE_SUFFIX.test(extension)) return { detectedType: 'office', disposition: 'external' }
  if (IMAGE_SUFFIX.test(extension)) return { detectedType: 'image', disposition: 'unsupported' }
  if (MEDIA_SUFFIX.test(extension)) return { detectedType: 'media', disposition: 'unsupported' }
  return { detectedType: 'unknown', disposition: 'unsupported' }
}

function blockedError(disposition: ProjectConversionDisposition): ProjectBlockedObservation['errorCode'] {
  return disposition === 'blocked' ? 'INPUT_UNSUPPORTED' : 'INPUT_SPECIAL_FILE_BLOCKED'
}

function deadlineGuard(signal: AbortSignal, deadline: number, now: () => number): void {
  throwIfAborted(signal)
  if (now() > deadline) throw new ProjectSyncError('INPUT_SCAN_TIMEOUT', 'Project scan timed out', true)
}

interface DirectoryTask {
  readonly absolutePath: string
  readonly projectRelativePath: string
  readonly depth: number
  readonly trustKind: ProjectTrustKind
}

export class BoundedProjectScanner {
  readonly #limits: ProjectScannerLimits
  readonly #probe: ProjectScanProbe

  constructor(limits: Partial<ProjectScannerLimits> = {}, probe: ProjectScanProbe = {}) {
    this.#limits = validateLimits({ ...DEFAULT_PROJECT_SCANNER_LIMITS, ...limits })
    this.#probe = probe
  }

  async scan(
    project: ProjectDescriptor,
    signal: AbortSignal,
    manifest: readonly ProjectManifestEntry[] = [],
  ): Promise<ProjectScanResult> {
    const verified = await verifyProjectDescriptor(project)
    const startingIdentity = verified.rootIdentity
    const now = this.#probe.now ?? Date.now
    const deadline = now() + this.#limits.timeoutMs
    const observations: ProjectSourceObservation[] = []
    const artifacts: ProjectArtifactObservation[] = []
    const blocked: ProjectBlockedObservation[] = []
    const stack: DirectoryTask[] = [
      {
        absolutePath: join(verified.rootPath, PROJECT_INPUT_QA_DIRECTORY),
        projectRelativePath: PROJECT_INPUT_QA_DIRECTORY,
        depth: 0,
        trustKind: 'preset_qa',
      },
      {
        absolutePath: join(verified.rootPath, PROJECT_INPUT_DOCUMENTS_DIRECTORY),
        projectRelativePath: PROJECT_INPUT_DOCUMENTS_DIRECTORY,
        depth: 0,
        trustKind: 'document',
      },
    ]
    let scannedEntries = 0
    let scannedBytes = 0
    const observedPathKeys = new Set<string>()
    const observedPhysicalFiles = new Set<string>()
    const knownByPath = new Map(manifest.map((entry) => [`${entry.trustKind}:${entry.pathKey}`, entry]))
    const knownArtifactByPath = new Map(manifest.flatMap((entry) => entry.outputRelativePath
      ? [[relativePathKey(entry.outputRelativePath), entry] as const]
      : []))

    while (stack.length > 0) {
      deadlineGuard(signal, deadline, now)
      const task = stack.pop()
      if (!task) break
      const directoryStats = await lstat(task.absolutePath)
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
        throw new ProjectSyncError('PROJECT_LAYOUT_INVALID')
      }
      const canonicalDirectory = await realpath(task.absolutePath)
      if (!isPathInside(verified.rootPath, canonicalDirectory)) throw new ProjectSyncError('INPUT_ESCAPES_ROOT')

      const directory = await opendir(task.absolutePath)
      try {
        for await (const entry of directory) {
          deadlineGuard(signal, deadline, now)
          scannedEntries += 1
          if (scannedEntries > this.#limits.maxEntries) throw new ProjectSyncError('INPUT_LIMIT_EXCEEDED')
          if (ignoredName(entry.name)) continue
          const relativePath = `${task.projectRelativePath}/${entry.name.normalize('NFC')}`
          const absolutePath = join(task.absolutePath, entry.name)
          const stats = await lstat(absolutePath, { bigint: true })
          if (stats.isSymbolicLink()) {
            blocked.push({ relativePath, trustKind: task.trustKind, errorCode: 'INPUT_SYMLINK_BLOCKED' })
            continue
          }
          if (stats.isDirectory()) {
            if (BUNDLE_SUFFIX.test(entry.name)) continue
            if (task.depth >= this.#limits.maxDepth) throw new ProjectSyncError('INPUT_LIMIT_EXCEEDED')
            stack.push({
              absolutePath,
              projectRelativePath: relativePath,
              depth: task.depth + 1,
              trustKind: task.trustKind,
            })
            continue
          }
          if (!stats.isFile()) {
            blocked.push({ relativePath, trustKind: task.trustKind, errorCode: 'INPUT_SPECIAL_FILE_BLOCKED' })
            continue
          }
          if (observations.length + blocked.length >= this.#limits.maxFiles) {
            throw new ProjectSyncError('INPUT_LIMIT_EXCEEDED')
          }
          if (stats.size < 0n || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProjectSyncError('INPUT_TOO_LARGE')
          const size = Number(stats.size)
          scannedBytes += size
          if (!Number.isSafeInteger(scannedBytes) || scannedBytes > this.#limits.maxAggregateBytes) {
            throw new ProjectSyncError('INPUT_LIMIT_EXCEEDED')
          }
          const classification = classifyFile(entry.name, Number(stats.mode))
          if (classification.disposition === 'blocked' || size > this.#limits.maxFileBytes) {
            blocked.push({
              relativePath,
              trustKind: task.trustKind,
              errorCode: size > this.#limits.maxFileBytes ? 'INPUT_TOO_LARGE' : blockedError(classification.disposition),
            })
            continue
          }
          const pathKey = relativePathKey(relativePath)
          const quick = {
            size,
            mtimeNs: stats.mtimeNs.toString(),
            device: stats.dev.toString(),
            inode: stats.ino.toString(),
          }
          const known = knownByPath.get(`${task.trustKind}:${pathKey}`)
          const unchangedQuickProbe = known?.activeRawSha256 && known.size === quick.size &&
            known.mtimeNs === quick.mtimeNs && known.device === quick.device && known.inode === quick.inode
          if (!unchangedQuickProbe) await this.#probe.onHash?.(relativePath)
          const hashed = unchangedQuickProbe
            ? { ...quick, sha256: known.activeRawSha256 }
            : await readStableFile(
                verified.rootPath,
                relativePath,
                this.#limits.maxFileBytes,
                signal,
                false,
              )
          if (!unchangedQuickProbe && (hashed.size !== quick.size || hashed.mtimeNs !== quick.mtimeNs ||
              hashed.device !== quick.device || hashed.inode !== quick.inode)) {
            throw new ProjectSyncError('INPUT_CHANGED_DURING_READ', 'INPUT_CHANGED_DURING_READ', true)
          }
          const physicalKey = `${quick.device}:${quick.inode}`
          if (observedPathKeys.has(`${task.trustKind}:${pathKey}`) || observedPhysicalFiles.has(physicalKey)) {
            blocked.push({ relativePath, trustKind: task.trustKind, errorCode: 'INPUT_PATH_COLLISION' })
            continue
          }
          observedPathKeys.add(`${task.trustKind}:${pathKey}`)
          observedPhysicalFiles.add(physicalKey)
          observations.push({
            relativePath,
            pathKey,
            trustKind: task.trustKind,
            size: quick.size,
            mtimeNs: quick.mtimeNs,
            device: quick.device,
            inode: quick.inode,
            rawSha256: hashed.sha256,
            detectedType: classification.detectedType,
            disposition: classification.disposition,
            errorCode: classification.disposition === 'local' ? null : 'INPUT_UNSUPPORTED',
          })
        }
      } finally {
        await directory.close().catch(() => undefined)
      }
    }

    const artifactStack: DirectoryTask[] = [
      {
        absolutePath: join(verified.rootPath, PROJECT_OUTPUT_DIRECTORY, PROJECT_OUTPUT_QA_DIRECTORY),
        projectRelativePath: `${PROJECT_OUTPUT_DIRECTORY}/${PROJECT_OUTPUT_QA_DIRECTORY}`,
        depth: 0,
        trustKind: 'preset_qa',
      },
      {
        absolutePath: join(verified.rootPath, PROJECT_OUTPUT_DIRECTORY, PROJECT_OUTPUT_DOCUMENTS_DIRECTORY),
        projectRelativePath: `${PROJECT_OUTPUT_DIRECTORY}/${PROJECT_OUTPUT_DOCUMENTS_DIRECTORY}`,
        depth: 0,
        trustKind: 'document',
      },
    ]
    while (artifactStack.length > 0) {
      deadlineGuard(signal, deadline, now)
      const task = artifactStack.pop()
      if (!task) break
      const directory = await opendir(task.absolutePath)
      try {
        for await (const entry of directory) {
          deadlineGuard(signal, deadline, now)
          scannedEntries += 1
          if (scannedEntries > this.#limits.maxEntries) throw new ProjectSyncError('INPUT_LIMIT_EXCEEDED')
          if (ignoredName(entry.name)) continue
          const relativePath = `${task.projectRelativePath}/${entry.name.normalize('NFC')}`
          const absolutePath = join(task.absolutePath, entry.name)
          const stats = await lstat(absolutePath, { bigint: true })
          if (stats.isSymbolicLink()) {
            blocked.push({ relativePath, trustKind: task.trustKind, errorCode: 'INPUT_SYMLINK_BLOCKED' })
          } else if (stats.isDirectory()) {
            if (BUNDLE_SUFFIX.test(entry.name)) continue
            if (task.depth >= this.#limits.maxDepth) throw new ProjectSyncError('INPUT_LIMIT_EXCEEDED')
            artifactStack.push({ ...task, absolutePath, projectRelativePath: relativePath, depth: task.depth + 1 })
          } else if (!stats.isFile()) {
            blocked.push({ relativePath, trustKind: task.trustKind, errorCode: 'INPUT_SPECIAL_FILE_BLOCKED' })
          } else if (extname(entry.name).toLocaleLowerCase('en-US') !== '.md') {
            blocked.push({ relativePath, trustKind: task.trustKind, errorCode: 'INPUT_UNSUPPORTED' })
          } else {
            if (observations.length + artifacts.length + blocked.length >= this.#limits.maxFiles) {
              throw new ProjectSyncError('INPUT_LIMIT_EXCEEDED')
            }
            if (stats.size < 0n || stats.size > BigInt(this.#limits.maxFileBytes) ||
                stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
              blocked.push({ relativePath, trustKind: task.trustKind, errorCode: 'INPUT_TOO_LARGE' })
              continue
            }
            const size = Number(stats.size)
            scannedBytes += size
            if (!Number.isSafeInteger(scannedBytes) || scannedBytes > this.#limits.maxAggregateBytes) {
              throw new ProjectSyncError('INPUT_LIMIT_EXCEEDED')
            }
            const pathKey = relativePathKey(relativePath)
            const quick = {
              size,
              mtimeNs: stats.mtimeNs.toString(),
              device: stats.dev.toString(),
              inode: stats.ino.toString(),
            }
            const known = knownArtifactByPath.get(pathKey)
            const unchangedQuickProbe = known?.activeCanonicalSha256 && known.outputSize === quick.size &&
              known.outputMtimeNs === quick.mtimeNs && known.outputDevice === quick.device &&
              known.outputInode === quick.inode
            if (!unchangedQuickProbe) await this.#probe.onHash?.(relativePath)
            const hashed = unchangedQuickProbe
              ? { ...quick, sha256: known.activeCanonicalSha256 }
              : await readStableFile(verified.rootPath, relativePath, this.#limits.maxFileBytes, signal, false)
            if (!unchangedQuickProbe && (hashed.size !== quick.size || hashed.mtimeNs !== quick.mtimeNs ||
                hashed.device !== quick.device || hashed.inode !== quick.inode)) {
              throw new ProjectSyncError('INPUT_CHANGED_DURING_READ', 'INPUT_CHANGED_DURING_READ', true)
            }
            const physicalKey = `${quick.device}:${quick.inode}`
            if (observedPathKeys.has(`${task.trustKind}:${pathKey}`) || observedPhysicalFiles.has(physicalKey)) {
              blocked.push({ relativePath, trustKind: task.trustKind, errorCode: 'INPUT_PATH_COLLISION' })
              continue
            }
            observedPathKeys.add(`${task.trustKind}:${pathKey}`)
            observedPhysicalFiles.add(physicalKey)
            artifacts.push({
              relativePath,
              pathKey,
              trustKind: task.trustKind,
              size: quick.size,
              sha256: hashed.sha256,
            })
          }
        }
      } finally {
        await directory.close().catch(() => undefined)
      }
    }

    const endingIdentity = await readRootIdentity(verified.rootPath)
    if (!sameRootIdentity(startingIdentity, endingIdentity)) {
      throw new ProjectSyncError('PROJECT_ROOT_IDENTITY_CHANGED')
    }
    observations.sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'zh-CN'))
    blocked.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN'))
    artifacts.sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'zh-CN'))
    return {
      rootIdentity: endingIdentity,
      observations,
      blocked,
      artifacts,
      scannedEntries,
      scannedBytes,
      completedAt: now(),
    }
  }
}
