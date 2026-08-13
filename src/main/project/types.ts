export const PROJECT_SCHEMA_VERSION = 1
export const PROJECT_CONVERTER_PROTOCOL = 'qaing-project-converter-v1'
export const PROJECT_CONVERTER_ID = 'qaing.deterministic-markdown'
export const PROJECT_CONVERTER_VERSION = '1'

export type ProjectTrustKind = 'document' | 'preset_qa'
export type ProjectTrigger = 'manual' | 'startup' | 'watcher'
export type ProjectSyncPolicy = 'manual' | 'auto_check_confirm' | 'auto_check_apply'
export type ProjectAvailability = 'available' | 'unavailable' | 'identity_changed'
export type ProjectDetectedType =
  | 'text'
  | 'markdown'
  | 'json'
  | 'csv'
  | 'tsv'
  | 'office'
  | 'pdf'
  | 'image'
  | 'media'
  | 'archive'
  | 'database'
  | 'executable'
  | 'unknown'
export type ProjectConversionDisposition = 'local' | 'external' | 'unsupported' | 'blocked'
export type ProjectFileState =
  | 'ready'
  | 'manual_ready'
  | 'needs_conversion'
  | 'awaiting_external_agent'
  | 'unsupported'
  | 'blocked'
  | 'missing_grace'
  | 'tombstoned'
  | 'failed'
  | 'generated_output_modified'
export type ConversionJobState =
  | 'PREPARED'
  | 'STAGED'
  | 'PUBLISHED_FS'
  | 'COMMITTED'
  | 'FAILED'
  | 'CANCELLED'
export type ProjectSyncPhase = 'scanning' | 'planning' | 'converting' | 'recovering' | 'complete' | 'failed' | 'cancelled'

export type ProjectErrorCode =
  | 'PROJECT_LAYOUT_MISSING'
  | 'PROJECT_LAYOUT_INVALID'
  | 'PROJECT_METADATA_INVALID'
  | 'PROJECT_ID_MISMATCH'
  | 'PROJECT_ROOT_UNAVAILABLE'
  | 'PROJECT_ROOT_IDENTITY_CHANGED'
  | 'INPUT_ESCAPES_ROOT'
  | 'INPUT_SYMLINK_BLOCKED'
  | 'INPUT_SPECIAL_FILE_BLOCKED'
  | 'INPUT_PATH_COLLISION'
  | 'INPUT_UNSUPPORTED'
  | 'INPUT_TOO_LARGE'
  | 'INPUT_LIMIT_EXCEEDED'
  | 'INPUT_SCAN_TIMEOUT'
  | 'INPUT_CHANGED_DURING_READ'
  | 'INPUT_ENCODING_INVALID'
  | 'CONVERTER_UNAVAILABLE'
  | 'CONVERTER_TIMEOUT'
  | 'CONVERTER_CRASHED'
  | 'CONVERTER_INVALID_RESPONSE'
  | 'OUTPUT_INVALID'
  | 'OUTPUT_TOO_LARGE'
  | 'GENERATED_OUTPUT_MODIFIED'
  | 'STALE_GENERATION'
  | 'PROJECT_SESSION_ACTIVE'
  | 'SYNC_CANCELLED'
  | 'DB_COMMIT_FAILED'

export interface ProjectRootIdentity {
  readonly canonicalPath: string
  readonly device: string
  readonly inode: string
}

export interface ProjectDescriptor {
  readonly id: string
  readonly rootPath: string
  readonly rootIdentity: ProjectRootIdentity
  readonly schemaVersion: number
  readonly createdAt: number
  readonly availability: ProjectAvailability
}

export interface PrepareProjectRootInput {
  readonly rootPath: string
  readonly projectId?: string
  readonly createMissing: boolean
  readonly now?: number
}

export interface ProjectScannerLimits {
  readonly maxDepth: number
  readonly maxFiles: number
  readonly maxEntries: number
  readonly maxFileBytes: number
  readonly maxAggregateBytes: number
  readonly timeoutMs: number
}

export interface ProjectScanProbe {
  readonly onHash?: (relativePath: string) => void | Promise<void>
  readonly now?: () => number
}

export interface ProjectSourceObservation {
  readonly relativePath: string
  readonly pathKey: string
  readonly trustKind: ProjectTrustKind
  readonly size: number
  readonly mtimeNs: string
  readonly device: string
  readonly inode: string
  readonly rawSha256: string | null
  readonly detectedType: ProjectDetectedType
  readonly disposition: ProjectConversionDisposition
  readonly errorCode: ProjectErrorCode | null
}

export type LocalProjectSourceObservation = ProjectSourceObservation & {
  readonly detectedType: Extract<ProjectDetectedType, 'text' | 'markdown' | 'json' | 'csv' | 'tsv'>
  readonly disposition: 'local'
  readonly rawSha256: string
  readonly errorCode: null
}

export interface ProjectBlockedObservation {
  readonly relativePath: string
  readonly trustKind: ProjectTrustKind
  readonly errorCode: ProjectErrorCode
}

export interface ProjectScanResult {
  readonly rootIdentity: ProjectRootIdentity
  readonly observations: readonly ProjectSourceObservation[]
  readonly blocked: readonly ProjectBlockedObservation[]
  readonly artifacts: readonly ProjectArtifactObservation[]
  readonly scannedEntries: number
  readonly scannedBytes: number
  readonly completedAt: number
}

export interface ProjectArtifactObservation {
  readonly relativePath: string
  readonly pathKey: string
  readonly trustKind: ProjectTrustKind
  readonly size: number
  readonly sha256: string
}

export interface ProjectManifestEntry extends ProjectSourceObservation {
  readonly sourceId: string
  readonly state: ProjectFileState
  readonly activeRawSha256: string | null
  readonly activeCanonicalSha256: string | null
  readonly outputRelativePath: string | null
  readonly outputSize: number | null
  readonly outputMtimeNs: string | null
  readonly outputDevice: string | null
  readonly outputInode: string | null
  readonly missingSinceGeneration: number | null
  readonly lastSeenGeneration: number
}

export interface PlannedConversion {
  readonly sourceId: string
  readonly observation: LocalProjectSourceObservation
  readonly outputRelativePath: string
  readonly expectedExistingOutputSha256: string | null
  readonly operationId: string
}

export interface PlannedRename {
  readonly sourceId: string
  readonly fromRelativePath: string
  readonly observation: ProjectSourceObservation
}

export interface ProjectIncrementalPlan {
  readonly unchangedSourceIds: readonly string[]
  readonly conversions: readonly PlannedConversion[]
  readonly renames: readonly PlannedRename[]
  readonly unsupported: readonly ProjectSourceObservation[]
  readonly missingGraceSourceIds: readonly string[]
  readonly tombstoneSourceIds: readonly string[]
  readonly ambiguousRelativePaths: readonly string[]
}

export interface ProjectRecord extends ProjectDescriptor {
  readonly scanGeneration: number
}

export interface ProjectSyncRun {
  readonly runId: string
  readonly projectId: string
  readonly generation: number
}

export interface ProjectSyncCounts {
  readonly discovered: number
  readonly unchanged: number
  readonly converted: number
  readonly external: number
  readonly unsupported: number
  readonly blocked: number
  readonly missingGrace: number
  readonly tombstoned: number
  readonly failed: number
}

export interface ProjectSyncProgress {
  readonly projectId: string
  readonly runId: string
  readonly generation: number
  readonly phase: ProjectSyncPhase
  readonly counts: ProjectSyncCounts
  readonly dataRevision?: number
}

export interface ProjectSyncInput {
  readonly projectId: string
  readonly trigger: ProjectTrigger
  readonly apply: boolean
  readonly allowDestructiveChanges?: boolean
}

export interface ProjectSyncResult extends ProjectSyncRun {
  readonly phase: Extract<ProjectSyncPhase, 'complete' | 'failed' | 'cancelled'>
  readonly counts: ProjectSyncCounts
  readonly completedAt: number
}

export interface ProjectRecoverySummary {
  readonly projectId: string
  readonly committed: number
  readonly rolledBack: number
  readonly failed: number
}

export interface PrepareConversionJobInput extends PlannedConversion {
  readonly projectId: string
  readonly runId: string
  readonly generation: number
  readonly inputSha256: string
  readonly tempRelativePath: string
}

export interface RecoverableConversionJob extends PrepareConversionJobInput {
  readonly state: Extract<ConversionJobState, 'PREPARED' | 'STAGED' | 'PUBLISHED_FS'>
  readonly outputSha256: string | null
}

export interface CommitConvertedArtifactInput {
  readonly operationId: string
  readonly projectId: string
  readonly runId: string
  readonly generation: number
  readonly sourceId: string
  readonly trustKind: ProjectTrustKind
  readonly inputSha256: string
  readonly outputRelativePath: string
  readonly canonicalContent: string
  /** SHA-256 of the complete on-disk artifact, including provenance frontmatter. */
  readonly outputSha256: string
  /** SHA-256 of canonicalContent after the project canonicalizer normalized it. */
  readonly canonicalBodySha256: string
  readonly outputSize: number
  readonly outputMtimeNs: string
  readonly outputDevice: string
  readonly outputInode: string
}

export interface CommitManualArtifactInput {
  readonly operationId: string
  readonly projectId: string
  readonly runId: string
  readonly generation: number
  readonly relativePath: string
  readonly trustKind: ProjectTrustKind
  readonly canonicalContent: string
  /** SHA-256 of the complete user-owned manual artifact bytes. */
  readonly outputSha256: string
  /** SHA-256 of canonicalContent after manual-artifact normalization. */
  readonly canonicalBodySha256: string
}

export interface ProjectScanCommitInput {
  readonly runId: string
  readonly projectId: string
  readonly generation: number
  /**
   * scan.artifacts contains the bounded artifact pass. The repository maps
   * known managed outputs to integrity status and treats only the remainder as
   * manual candidates; neither class is a raw converter input.
   */
  readonly scan: ProjectScanResult
  readonly plan: ProjectIncrementalPlan
}

export interface ProjectSyncRepository {
  getProject(projectId: string): Promise<ProjectRecord | null>
  registerProject(project: ProjectDescriptor): Promise<ProjectRecord>
  beginSyncRun(projectId: string, trigger: ProjectTrigger): Promise<ProjectSyncRun>
  loadManifest(projectId: string): Promise<readonly ProjectManifestEntry[]>
  recordScan(input: ProjectScanCommitInput): Promise<void>
  applyIncrementalPlan(input: {
    readonly projectId: string
    readonly runId: string
    readonly generation: number
    readonly renames: readonly PlannedRename[]
    readonly tombstoneSourceIds: readonly string[]
  }): Promise<void>
  validateCanonicalArtifact(input: {
    readonly trustKind: ProjectTrustKind
    readonly canonicalContent: string
    readonly validationProfile: 'generated' | 'manual'
  }): Promise<void>
  prepareConversion(input: PrepareConversionJobInput): Promise<void>
  markConversionStaged(operationId: string, generation: number, outputSha256: string): Promise<void>
  markConversionPublished(operationId: string, generation: number): Promise<void>
  commitConversion(input: CommitConvertedArtifactInput): Promise<void>
  commitManualArtifact(input: CommitManualArtifactInput): Promise<{ readonly inserted: boolean }>
  failManualArtifact(input: {
    readonly projectId: string
    readonly runId: string
    readonly generation: number
    readonly relativePath: string
    readonly trustKind: ProjectTrustKind
    readonly inputSha256: string
    readonly errorCode: ProjectErrorCode
  }): Promise<void>
  failConversion(operationId: string, generation: number, errorCode: ProjectErrorCode): Promise<void>
  cancelConversion(operationId: string, generation: number): Promise<void>
  completeSyncRun(result: ProjectSyncResult): Promise<void>
  listRecoverableJobs(projectId: string): Promise<readonly RecoverableConversionJob[]>
}

export interface ProjectConverterRequest {
  readonly projectId: string
  readonly sourceId: string
  readonly relativePath: string
  readonly trustKind: ProjectTrustKind
  readonly detectedType: Extract<ProjectDetectedType, 'text' | 'markdown' | 'json' | 'csv' | 'tsv'>
  readonly rawSha256: string
  readonly input: Uint8Array
}

export interface ProjectConverterResult {
  readonly canonicalMarkdown: string
  /** SHA-256 of canonicalMarkdown exactly as written to the project filesystem. */
  readonly outputSha256: string
  /** SHA-256 of the canonical Markdown body sent to SQLite importers. */
  readonly canonicalBodySha256: string
}

export interface ProjectConverter {
  convert(request: ProjectConverterRequest, options: { readonly signal: AbortSignal }): Promise<ProjectConverterResult>
  dispose(): Promise<void>
}

export interface ProjectSyncServiceOptions {
  readonly repository: ProjectSyncRepository
  readonly converter: ProjectConverter
  readonly scannerLimits?: Partial<ProjectScannerLimits>
  readonly conversionConcurrency?: number
  readonly conversionTimeoutMs?: number
  readonly maxOutputBytes?: number
  readonly maxAutomaticTombstones?: number
  readonly now?: () => number
  readonly onProgress?: (event: ProjectSyncProgress) => void
  /**
   * Called only for unattended watcher work. Returning false still permits a
   * read-only reconciliation, but prevents publishing a new knowledge version
   * while a live session has frozen the current one.
   */
  readonly canAutoApply?: (projectId: string) => boolean
  readonly watchFactory?: ProjectWatchFactory
  readonly scanProbe?: ProjectScanProbe
}

export interface ProjectWatchHandle {
  close(): void
}

export type ProjectWatchFactory = (
  path: string,
  listener: () => void,
) => ProjectWatchHandle

export interface ProjectSyncService {
  prepareRoot(input: PrepareProjectRootInput, signal?: AbortSignal): Promise<ProjectDescriptor>
  sync(input: ProjectSyncInput, signal?: AbortSignal): Promise<ProjectSyncResult>
  cancel(runId: string): boolean
  recover(projectId: string, signal?: AbortSignal): Promise<ProjectRecoverySummary>
  watch(projectId: string, policy: ProjectSyncPolicy): Promise<void>
  /** Replays an auto-apply pass deferred while a live session pinned knowledge. */
  resumeAutoApply(projectId: string): boolean
  /** Waits out overlapping work, recovers with a bounded retry, then replays authorized apply. */
  resumeAfterSession(projectId: string): Promise<boolean>
  unwatch(projectId: string): void
  dispose(): Promise<void>
}
