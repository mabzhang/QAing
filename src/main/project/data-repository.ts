import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { DataStore } from '../data/database'
import { prepareSourceDocumentDeferred, validateCanonicalArtifact } from '../data/importers'
import type {
  ProjectManifestEntryRecord as StoredManifestEntry,
  ProjectRecord as StoredProjectRecord,
  ProjectScanObservation as StoredScanObservation,
  ProjectSourceFileRecord,
} from '../data/types'
import { ProjectSyncError } from './errors'
import { relativePathKey } from './filesystem'
import {
  PROJECT_INPUT_DOCUMENTS_DIRECTORY,
  PROJECT_INPUT_QA_DIRECTORY,
} from './layout'
import { parseProjectRootIdentity, serializeProjectRootIdentity } from './root-identity'
import type {
  CommitConvertedArtifactInput,
  CommitManualArtifactInput,
  LocalProjectSourceObservation,
  ProjectDescriptor,
  ProjectErrorCode,
  ProjectFileState,
  ProjectManifestEntry,
  ProjectDetectedType,
  ProjectRecord,
  ProjectScanCommitInput,
  ProjectSyncRepository,
  ProjectSyncResult,
  ProjectSyncRun,
  ProjectTrigger,
  RecoverableConversionJob,
} from './types'
import { PROJECT_CONVERTER_ID, PROJECT_CONVERTER_VERSION } from './types'

export { parseProjectRootIdentity, serializeProjectRootIdentity } from './root-identity'

function stableId(prefix: string, ...parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\0')
  return `${prefix}_${hash.digest('hex').slice(0, 24)}`
}

function rethrowProjectMutation(error: unknown): never {
  if (error instanceof Error && error.message === 'PROJECT_SESSION_ACTIVE') {
    throw new ProjectSyncError('PROJECT_SESSION_ACTIVE', 'PROJECT_SESSION_ACTIVE', true, { cause: error })
  }
  throw error
}

function storedTrigger(trigger: ProjectTrigger): 'manual' | 'watch' | 'startup' {
  return trigger === 'watcher' ? 'watch' : trigger
}

function projectRecord(record: StoredProjectRecord): ProjectRecord {
  let identity
  try {
    identity = parseProjectRootIdentity(record.rootIdentity)
  } catch (error) {
    throw new ProjectSyncError('PROJECT_METADATA_INVALID', 'PROJECT_METADATA_INVALID', false,
      error instanceof Error ? { cause: error } : undefined)
  }
  return {
    id: record.id,
    rootPath: record.rootPath,
    rootIdentity: identity,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    availability: record.availability,
    scanGeneration: record.scanGeneration,
  }
}

function projectFileState(entry: StoredManifestEntry): ProjectFileState {
  if (entry.state === 'tombstoned') return 'tombstoned'
  if (entry.state === 'missing_grace') return 'missing_grace'
  if (entry.errorCode === 'GENERATED_OUTPUT_MODIFIED') return 'generated_output_modified'
  if (entry.conversionDisposition === 'external') return 'awaiting_external_agent'
  if (entry.conversionDisposition === 'unsupported') return 'unsupported'
  if (entry.state === 'blocked') return 'blocked'
  if (entry.state === 'conversion_failed' || entry.state === 'commit_failed' || entry.state === 'index_failed') return 'failed'
  // Once SQLite has committed the canonical body, an embedding/index callback
  // may still be pending. Re-conversion would neither help nor be idempotent,
  // so expose that source to the file planner as ready.
  if (entry.state === 'ready' || entry.state === 'embedding_pending') return 'ready'
  return 'needs_conversion'
}

function detectedType(value: string): ProjectDetectedType {
  switch (value) {
    case 'text':
    case 'markdown':
    case 'json':
    case 'csv':
    case 'tsv':
    case 'office':
    case 'pdf':
    case 'image':
    case 'media':
    case 'archive':
    case 'database':
    case 'executable':
    case 'unknown':
      return value
    default:
      return 'unknown'
  }
}

function manifestEntry(entry: StoredManifestEntry): ProjectManifestEntry {
  return {
    sourceId: entry.sourceId,
    relativePath: entry.relativePath,
    pathKey: entry.pathKey,
    trustKind: entry.trustKind,
    size: entry.sizeBytes,
    mtimeNs: entry.mtimeNs,
    device: entry.deviceId ?? '',
    inode: entry.inode ?? '',
    rawSha256: entry.rawSha256,
    detectedType: detectedType(entry.detectedType),
    disposition: entry.conversionDisposition,
    errorCode: entry.errorCode as ProjectErrorCode | null,
    state: projectFileState(entry),
    activeRawSha256: entry.activeRawSha256,
    activeCanonicalSha256: entry.activeCanonicalSha256,
    outputRelativePath: entry.outputRelativePath,
    outputSize: entry.outputSizeBytes,
    outputMtimeNs: entry.outputMtimeNs,
    outputDevice: entry.outputDeviceId,
    outputInode: entry.outputInode,
    missingSinceGeneration: entry.missingSinceGeneration,
    lastSeenGeneration: entry.lastSeenGeneration,
  }
}

function sourceObservation(observation: ProjectScanCommitInput['scan']['observations'][number]): StoredScanObservation {
  const supported = observation.disposition === 'local' && observation.errorCode === null
  return {
    trustKind: observation.trustKind,
    displayRelativePath: observation.relativePath,
    pathKey: observation.pathKey,
    sizeBytes: observation.size,
    mtimeNs: observation.mtimeNs,
    deviceId: observation.device,
    inode: observation.inode,
    // Every regular input is content-hashed by the bounded scanner, including
    // files that require an external/manual converter.  Keeping that digest is
    // what makes an unsupported PDF/Office file stable across scans and lets a
    // later external conversion prove exactly which source bytes it handled.
    // Special files rejected before hashing still enter through
    // blockedObservation with a null digest.
    rawSha256: observation.rawSha256,
    detectedType: observation.detectedType,
    conversionDisposition: observation.disposition,
    blockedReason: supported ? null : (observation.errorCode ?? 'INPUT_UNSUPPORTED'),
  }
}

function isInputPath(relativePath: string): boolean {
  return relativePath.startsWith(`${PROJECT_INPUT_DOCUMENTS_DIRECTORY}/`) ||
    relativePath.startsWith(`${PROJECT_INPUT_QA_DIRECTORY}/`)
}

function blockedObservation(
  blocked: ProjectScanCommitInput['scan']['blocked'][number],
): StoredScanObservation | null {
  if (!isInputPath(blocked.relativePath)) return null
  return {
    trustKind: blocked.trustKind,
    displayRelativePath: blocked.relativePath,
    pathKey: relativePathKey(blocked.relativePath),
    sizeBytes: 0,
    mtimeNs: '0',
    rawSha256: null,
    detectedType: 'unknown',
    conversionDisposition: 'blocked',
    blockedReason: blocked.errorCode,
  }
}

function localObservation(source: ProjectSourceFileRecord): LocalProjectSourceObservation {
  if (source.observedRawSha256 === null || source.conversionDisposition !== 'local' ||
      (source.detectedType !== 'text' && source.detectedType !== 'markdown' && source.detectedType !== 'json' &&
        source.detectedType !== 'csv' && source.detectedType !== 'tsv')) {
    throw new ProjectSyncError('PROJECT_METADATA_INVALID')
  }
  return {
    relativePath: source.displayRelativePath,
    pathKey: source.pathKey,
    trustKind: source.trustKind,
    size: source.sizeBytes,
    mtimeNs: source.mtimeNs,
    device: source.deviceId ?? '',
    inode: source.inode ?? '',
    rawSha256: source.observedRawSha256,
    detectedType: source.detectedType,
    disposition: 'local',
    errorCode: null,
  }
}

export interface DataStoreProjectSyncRepositoryOptions {
  readonly store: DataStore
  readonly now?: () => number
  readonly runIdFactory?: () => string
  readonly onKnowledgeCommitted?: (projectId: string, sourceId: string, revisionId: string) => void | Promise<void>
}

/**
 * Synchronous SQLite mutations are exposed through the async project port so
 * filesystem/converter orchestration never receives a database handle.
 */
export class DataStoreProjectSyncRepository implements ProjectSyncRepository {
  readonly #store: DataStore
  readonly #now: () => number
  readonly #runIdFactory: () => string
  readonly #onKnowledgeCommitted: DataStoreProjectSyncRepositoryOptions['onKnowledgeCommitted']

  constructor(options: DataStoreProjectSyncRepositoryOptions) {
    this.#store = options.store
    this.#now = options.now ?? Date.now
    this.#runIdFactory = options.runIdFactory ?? randomUUID
    this.#onKnowledgeCommitted = options.onKnowledgeCommitted
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const stored = this.#store.getProject(projectId)
    return stored ? projectRecord(stored) : null
  }

  async registerProject(project: ProjectDescriptor): Promise<ProjectRecord> {
    const existing = this.#store.getProject(project.id)
    if (existing) {
      let existingIdentity
      try {
        existingIdentity = parseProjectRootIdentity(existing.rootIdentity)
      } catch (error) {
        throw new ProjectSyncError('PROJECT_METADATA_INVALID', 'PROJECT_METADATA_INVALID', false,
          error instanceof Error ? { cause: error } : undefined)
      }
      if (
        existing.rootPath !== project.rootPath || existing.schemaVersion !== project.schemaVersion ||
        existingIdentity.canonicalPath !== project.rootIdentity.canonicalPath ||
        existingIdentity.device !== project.rootIdentity.device || existingIdentity.inode !== project.rootIdentity.inode
      ) {
        throw new ProjectSyncError('PROJECT_ID_MISMATCH')
      }
      const reopened = existing.availability === 'available'
        ? existing
        : this.#store.setProjectAvailability(project.id, 'available', null, this.#now())
      // Reopening a durable project must preserve its user-selected policy,
      // manifest, last-good knowledge and scan generation.
      return projectRecord(reopened)
    }
    const stored = this.#store.createProjectManifest({
      id: project.id,
      displayName: basename(project.rootPath) || '未命名项目',
      rootPath: project.rootPath,
      rootIdentity: serializeProjectRootIdentity(project.rootIdentity),
      schemaVersion: project.schemaVersion,
      syncPolicy: 'auto_check_confirm',
    }, project.createdAt)
    return projectRecord(stored)
  }

  async beginSyncRun(projectId: string, trigger: ProjectTrigger): Promise<ProjectSyncRun> {
    const project = this.#store.getProject(projectId)
    if (!project) throw new ProjectSyncError('PROJECT_ROOT_UNAVAILABLE')
    const run = this.#store.beginProjectScan({
      runId: this.#runIdFactory(),
      projectId,
      trigger: storedTrigger(trigger),
      rootIdentity: project.rootIdentity,
      startedAt: this.#now(),
    })
    return { projectId, runId: run.runId, generation: run.generation }
  }

  async loadManifest(projectId: string): Promise<readonly ProjectManifestEntry[]> {
    // Check-only scans persist rename candidates for UI/confirmation. They are
    // not real source identities and must not shadow the original source on a
    // later apply scan, otherwise a pending rename silently becomes add+delete.
    return this.#store.listProjectManifestEntries(projectId)
      .filter((entry) => isInputPath(entry.relativePath) &&
        entry.errorCode !== 'RENAME_CONFIRMATION_REQUIRED' && entry.errorCode !== 'RENAME_AMBIGUOUS')
      .map(manifestEntry)
  }

  async recordScan(input: ProjectScanCommitInput): Promise<void> {
    const sourceKeys = new Set(input.scan.observations.map((entry) => `${entry.trustKind}:${entry.pathKey}`))
    const blocked = input.scan.blocked
      .map(blockedObservation)
      .filter((entry): entry is StoredScanObservation => entry !== null && !sourceKeys.has(`${entry.trustKind}:${entry.pathKey}`))
    const managedOutputPaths = new Set(
      this.#store.listProjectManifestEntries(input.projectId)
        .flatMap((entry) => entry.outputRelativePath ? [relativePathKey(entry.outputRelativePath)] : []),
    )
    const manualArtifacts = input.scan.artifacts
      .filter((artifact) => !managedOutputPaths.has(artifact.pathKey))
      .map((artifact): StoredScanObservation => ({
      trustKind: artifact.trustKind,
      displayRelativePath: artifact.relativePath,
      pathKey: artifact.pathKey,
      sizeBytes: artifact.size,
      // ProjectArtifactObservation intentionally omits a quick-probe mtime:
      // manual artifacts are re-hashed on every bounded validation pass.
      mtimeNs: '0',
      rawSha256: artifact.sha256,
      detectedType: 'markdown',
      conversionDisposition: 'local',
      blockedReason: null,
      }))
    this.#store.applyProjectScanManifest({
      runId: input.runId,
      projectId: input.projectId,
      generation: input.generation,
      observations: [...input.scan.observations.map(sourceObservation), ...blocked, ...manualArtifacts],
      completedAt: input.scan.completedAt,
    })
    const storedManifest = this.#store.listProjectManifestEntries(input.projectId)
    const sourceByOutputPath = new Map(storedManifest.flatMap((entry) => entry.outputRelativePath
      ? [[relativePathKey(entry.outputRelativePath), entry.sourceId] as const]
      : []))
    const artifactByPath = new Map(input.scan.artifacts.map((artifact) => [artifact.pathKey, artifact]))
    for (const blockedOutput of input.scan.blocked) {
      if (blockedOutput.errorCode !== 'GENERATED_OUTPUT_MODIFIED') continue
      const sourceId = sourceByOutputPath.get(relativePathKey(blockedOutput.relativePath))
      const artifact = artifactByPath.get(relativePathKey(blockedOutput.relativePath))
      if (!sourceId || !artifact) throw new ProjectSyncError('PROJECT_METADATA_INVALID')
      this.#store.markProjectManagedOutputModified({
        projectId: input.projectId,
        runId: input.runId,
        generation: input.generation,
        sourceId,
        observedOutputSha256: artifact.sha256,
      }, this.#now())
    }
    // Scan freshness and semantic-index readiness are orthogonal. The scan
    // store restores last-good rows optimistically; immediately derive their
    // actual ready/pending/failed state from current embedding jobs.
    this.#store.reconcileProjectIndexState(input.projectId, this.#now())
    // The filesystem planner and SQLite manifest must agree before any file is
    // converted. This catches source-ID/revision drift at the scan boundary.
    for (const conversion of input.plan.conversions) {
      const revision = this.#store.findProjectSourceRevision({
        sourceId: conversion.sourceId,
        generation: input.generation,
        rawSha256: conversion.observation.rawSha256,
      }) ?? this.#store.ensureProjectSourceRevision({
        sourceId: conversion.sourceId,
        generation: input.generation,
        rawSha256: conversion.observation.rawSha256,
        sizeBytes: conversion.observation.size,
        detectedType: conversion.observation.detectedType,
      }, this.#now())
      if (revision.sourceId !== conversion.sourceId) throw new ProjectSyncError('PROJECT_METADATA_INVALID')
    }
  }

  async applyIncrementalPlan(input: Parameters<ProjectSyncRepository['applyIncrementalPlan']>[0]): Promise<void> {
    this.#store.applyProjectIncrementalPlan({
      projectId: input.projectId,
      runId: input.runId,
      generation: input.generation,
      renames: input.renames.map((entry) => ({
        sourceId: entry.sourceId,
        trustKind: entry.observation.trustKind,
        displayRelativePath: entry.observation.relativePath,
        pathKey: entry.observation.pathKey,
        sizeBytes: entry.observation.size,
        mtimeNs: entry.observation.mtimeNs,
        deviceId: entry.observation.device,
        inode: entry.observation.inode,
        rawSha256: entry.observation.rawSha256 ?? '',
        detectedType: entry.observation.detectedType,
        conversionDisposition: entry.observation.disposition,
        errorCode: entry.observation.errorCode,
      })),
      tombstoneSourceIds: input.tombstoneSourceIds,
      appliedAt: this.#now(),
    })
  }

  async validateCanonicalArtifact(input: Parameters<ProjectSyncRepository['validateCanonicalArtifact']>[0]): Promise<void> {
    validateCanonicalArtifact(input)
  }

  async prepareConversion(input: Parameters<ProjectSyncRepository['prepareConversion']>[0]): Promise<void> {
    const revision = this.#store.findProjectSourceRevision({
      sourceId: input.sourceId,
      generation: input.generation,
      rawSha256: input.inputSha256,
    })
    if (!revision) throw new ProjectSyncError('STALE_GENERATION')
    this.#store.prepareConversionJob({
      operationId: input.operationId,
      projectId: input.projectId,
      sourceId: input.sourceId,
      revisionId: revision.revisionId,
      generation: input.generation,
      inputSha256: input.inputSha256,
      tempRelativePath: input.tempRelativePath,
      finalRelativePath: input.outputRelativePath,
      conversionMode: 'local',
      converterId: PROJECT_CONVERTER_ID,
      converterVersion: PROJECT_CONVERTER_VERSION,
      artifactSchemaVersion: 1,
      cacheKey: input.operationId,
    }, this.#now())
  }

  async markConversionStaged(operationId: string, generation: number, outputSha256: string): Promise<void> {
    const job = this.#requireJob(operationId, generation)
    const source = this.#store.getProjectSource(job.sourceId)
    if (!source) throw new ProjectSyncError('PROJECT_METADATA_INVALID')
    this.#store.stageConversionArtifact({
      operationId,
      artifactId: stableId('artifact', operationId, outputSha256),
      outputSha256,
      contentKind: source.trustKind,
    }, this.#now())
  }

  async markConversionPublished(operationId: string, generation: number): Promise<void> {
    const job = this.#requireJob(operationId, generation)
    if (!job.outputSha256) throw new ProjectSyncError('PROJECT_METADATA_INVALID')
    this.#store.markConversionPublished(operationId, job.outputSha256, this.#now())
  }

  async commitConversion(input: CommitConvertedArtifactInput): Promise<void> {
    const job = this.#requireJob(input.operationId, input.generation)
    if (!job.artifactId || job.projectId !== input.projectId || job.sourceId !== input.sourceId) {
      throw new ProjectSyncError('PROJECT_METADATA_INVALID')
    }
    const validated = validateCanonicalArtifact({
      trustKind: input.trustKind,
      canonicalContent: input.canonicalContent,
      validationProfile: 'generated',
    })
    try {
      if (input.trustKind === 'document') {
        this.#store.commitProjectDocumentArtifact({
        operationId: input.operationId,
        artifactId: job.artifactId,
        outputSha256: input.outputSha256,
        canonicalBodySha256: input.canonicalBodySha256,
        document: prepareSourceDocumentDeferred({
          title: basename(input.outputRelativePath),
          format: 'markdown',
          content: validated.normalizedContent,
        }),
        outputSizeBytes: input.outputSize,
        outputMtimeNs: input.outputMtimeNs,
        outputDeviceId: input.outputDevice,
        outputInode: input.outputInode,
        }, this.#now())
      } else {
        this.#store.commitProjectQaArtifact({
        operationId: input.operationId,
        artifactId: job.artifactId,
        canonicalContent: validated.normalizedContent,
        outputSha256: input.outputSha256,
        canonicalBodySha256: input.canonicalBodySha256,
        items: validated.items,
        outputSizeBytes: input.outputSize,
        outputMtimeNs: input.outputMtimeNs,
        outputDeviceId: input.outputDevice,
        outputInode: input.outputInode,
        }, this.#now())
      }
    } catch (error) {
      rethrowProjectMutation(error)
    }
    await this.#finishKnowledgeCommit(input.projectId, input.sourceId, job.revisionId)
  }

  async commitManualArtifact(input: CommitManualArtifactInput): Promise<{ readonly inserted: boolean }> {
    const validated = validateCanonicalArtifact({
      trustKind: input.trustKind,
      canonicalContent: input.canonicalContent,
      validationProfile: 'manual',
    })
    const common = {
      operationId: input.operationId,
      projectId: input.projectId,
      runId: input.runId,
      generation: input.generation,
      displayRelativePath: input.relativePath,
      pathKey: relativePathKey(input.relativePath),
      trustKind: input.trustKind,
      canonicalContent: validated.normalizedContent,
      outputSha256: input.outputSha256,
      canonicalBodySha256: input.canonicalBodySha256,
    }
    let result
    try {
      result = input.trustKind === 'document'
        ? this.#store.commitManualProjectArtifact({
            ...common,
            document: prepareSourceDocumentDeferred({
              title: basename(input.relativePath),
              format: 'markdown',
              content: validated.normalizedContent,
            }),
          }, this.#now())
        : this.#store.commitManualProjectArtifact({ ...common, qaItems: validated.items }, this.#now())
    } catch (error) {
      rethrowProjectMutation(error)
    }
    if (result.inserted) {
      const source = this.#store.getProjectSource(result.source.sourceId)
      if (source?.activeRevisionId) {
        await this.#runKnowledgeHook(input.projectId, source.sourceId, source.activeRevisionId)
      }
    }
    return { inserted: result.inserted }
  }

  async failManualArtifact(input: Parameters<ProjectSyncRepository['failManualArtifact']>[0]): Promise<void> {
    this.#store.failManualProjectArtifact({
      projectId: input.projectId,
      runId: input.runId,
      generation: input.generation,
      displayRelativePath: input.relativePath,
      pathKey: relativePathKey(input.relativePath),
      trustKind: input.trustKind,
      inputSha256: input.inputSha256,
      errorCode: input.errorCode,
    }, this.#now())
  }

  async failConversion(operationId: string, generation: number, errorCode: ProjectErrorCode): Promise<void> {
    const job = this.#store.getConversionJob(operationId)
    if (!job) return
    if (job.generation !== generation) throw new ProjectSyncError('STALE_GENERATION')
    if (job.state === 'failed' && job.errorCode === errorCode) return
    this.#store.failConversionJob(operationId, errorCode, this.#now())
  }

  async cancelConversion(operationId: string, generation: number): Promise<void> {
    const job = this.#store.getConversionJob(operationId)
    if (!job) return
    if (job.generation !== generation) throw new ProjectSyncError('STALE_GENERATION')
    if (job.state === 'cancelled') return
    this.#store.cancelConversionJob(operationId, this.#now())
  }

  async completeSyncRun(result: ProjectSyncResult): Promise<void> {
    const state = result.phase === 'cancelled'
      ? 'cancelled'
      : result.phase === 'failed'
        ? 'failed'
        : result.counts.failed > 0
          ? 'completed_with_errors'
          : 'completed'
    this.#store.finishProjectSync(
      result.runId,
      state,
      state === 'failed' ? 'PROJECT_SYNC_FAILED' : null,
      result.completedAt,
      {
        discovered: result.counts.discovered,
        unchanged: result.counts.unchanged,
        converted: result.counts.converted,
        manualReady: this.#store.getProjectStatusSummary(result.projectId).manualReady,
        missingGrace: result.counts.missingGrace,
        tombstoned: result.counts.tombstoned,
        // SQLite deliberately persists one blocked bucket. Keep all terminal
        // non-convertible observations in it so the live and restart progress
        // projections have the same completed/total denominator.
        blocked: result.counts.blocked + result.counts.external + result.counts.unsupported,
        failed: result.counts.failed,
      },
    )
  }

  async listRecoverableJobs(projectId: string): Promise<readonly RecoverableConversionJob[]> {
    return this.#store.listProjectRecoveryWork({ projectId, limit: 2_000 }).map((job) => {
      const source = this.#store.getProjectSource(job.sourceId)
      if (!source) throw new ProjectSyncError('PROJECT_METADATA_INVALID')
      const manifest = this.#store.listProjectManifestEntries(projectId).find((entry) => entry.sourceId === job.sourceId)
      return {
        operationId: job.operationId,
        projectId: job.projectId,
        runId: this.#runIdForGeneration(projectId, job.generation),
        generation: job.generation,
        sourceId: job.sourceId,
        observation: localObservation(source),
        outputRelativePath: job.finalRelativePath,
        expectedExistingOutputSha256: manifest?.activeCanonicalSha256 ?? null,
        inputSha256: job.inputSha256,
        tempRelativePath: job.tempRelativePath,
        state: job.state === 'prepared' ? 'PREPARED' : job.state === 'staged' ? 'STAGED' : 'PUBLISHED_FS',
        outputSha256: job.outputSha256,
      }
    })
  }

  #requireJob(operationId: string, generation: number): NonNullable<ReturnType<DataStore['getConversionJob']>> {
    const job = this.#store.getConversionJob(operationId)
    if (!job || job.generation !== generation) throw new ProjectSyncError('STALE_GENERATION')
    return job
  }

  #runIdForGeneration(projectId: string, generation: number): string {
    const jobs = this.#store.listProjectRecoveryWork({ projectId, limit: 2_000 })
    const runId = jobs.find((entry) => entry.generation === generation)?.operationId
    // ConversionJobRecord deliberately does not expose runId. Recovery commit
    // only needs a bounded stable audit identifier, never a live sync owner.
    return runId ? stableId('recovery', projectId, String(generation), runId) : stableId('recovery', projectId, String(generation))
  }

  async #finishKnowledgeCommit(projectId: string, sourceId: string, revisionId: string): Promise<void> {
    await this.#runKnowledgeHook(projectId, sourceId, revisionId)
  }

  async #runKnowledgeHook(projectId: string, sourceId: string, revisionId: string): Promise<void> {
    try {
      await this.#onKnowledgeCommitted?.(projectId, sourceId, revisionId)
    } catch {
      // SQLite/FTS commit is already durable. Vector indexing owns its own
      // pending/failed job lifecycle and cannot retroactively fail conversion.
    } finally {
      this.#store.reconcileProjectIndexState(projectId, this.#now())
    }
  }
}
