import Database from 'better-sqlite3'
import type {
  AnswerOrigin,
  QaAnswerVersion,
  QaRoundStatus,
  QaWorkspacePage,
  QaWorkspaceRound,
  RetrievalRoute,
  SourceReference,
} from '../../core/types'
import { applyMigrations } from './migrations'
import { normalizeContent, normalizeQuestion, sha256, stableId } from './hash'
import { parseStructuredQaDocument, validateAndDedupeQa } from './importers'
import { projectSourceId } from '../project/planner'
import type {
  AudioSource,
  ChunkInput,
  ChunkRecord,
  DocumentImportInput,
  DocumentKind,
  DocumentRecord,
  EmbeddingMetadata,
  EnsureQaRoundInput,
  FrontDraftRecord,
  FrontDraftStatus,
  IndexJobRecord,
  IndexJobStatus,
  IndexOwnerType,
  KeywordHit,
  PresetQaInput,
  PresetQaRecord,
  QaWorkspacePageInput,
  LegacyQaWorkspacePageInput,
  QaWorkspaceExportPageInput,
  QaWorkspaceExportSnapshot,
  DeleteQaWorkspaceRoundResult,
  ClearQaWorkspaceProjectResult,
  AssignLegacyQaSessionResult,
  CloseQaRoundInput,
  SaveQaAnswerVersionInput,
  SaveQaAnswerVersionResult,
  SessionMode,
  SessionRecord,
  StoredVector,
  CommitQaRoundInput,
  CommitQaRoundResult,
  CloseQaRoundResult,
  TurnRecord,
  ApplyProjectScanManifestInput,
  ApplyProjectIncrementalPlanInput,
  BeginProjectScanInput,
  CommitProjectDocumentArtifactInput,
  CommitProjectFrontDocumentInput,
  CommitProjectQaArtifactInput,
  CommitManualProjectArtifactInput,
  FailManualProjectArtifactInput,
  ConversionArtifactRecord,
  ConversionJobRecord,
  ConversionJobState,
  ConversionSagaResult,
  CreateProjectManifestInput,
  PrepareConversionJobInput,
  ProjectAvailability,
  ProjectDocumentLinkRecord,
  ProjectFrontDocumentLinkRecord,
  ProjectManifestEntryRecord,
  ProjectQaLinkRecord,
  ProjectRecord,
  ProjectScanApplyResult,
  ProjectScanObservation,
  ProjectSourceFileRecord,
  ProjectSourcePage,
  ProjectSourcePageInput,
  ProjectSourceRevisionRecord,
  ProjectSourceState,
  ProjectSourceTaskRecord,
  ProjectStatusSummary,
  ProjectIndexReconcileResult,
  MarkProjectManagedOutputModifiedInput,
  ProjectSyncCounts,
  ProjectSyncPolicy,
  ProjectSyncRunRecord,
  ProjectSyncRunState,
  StageConversionArtifactInput,
  CancelSimulationPublicationInput,
  CommitSimulationBatchInput,
  CompleteSimulationPublicationInput,
  CreateSimulationJobInput,
  PrepareSimulationPublicationInput,
  ReviewSimulationItemsInput,
  ResolveSimulationPublicationMappingsInput,
  SimulationBatchCommitResult,
  SimulationBatchRecord,
  SimulationCitationInput,
  SimulationCitationRecord,
  SimulationEvidenceHit,
  SimulationGapPage,
  SimulationGapReason,
  SimulationGapRecord,
  SimulationInterviewBrief,
  SimulationItemPage,
  SimulationItemRecord,
  SimulationJobPage,
  SimulationJobRecord,
  SimulationJobStatus,
  SimulationPageInput,
  SimulationProjectFence,
  SimulationPublicationBundle,
  SimulationPublicationDraftBundle,
  SimulationPublicationRecord,
  SimulationPublicationMapping,
  SimulationResultPageInput,
  TransitionSimulationJobInput,
  UpdateSimulationItemInput,
  UpdateSimulationItemResult,
} from './types'

interface SqlDocumentRow {
  id: string
  title: string
  kind: DocumentKind
  source_uri: string | null
  content: string
  content_hash: string
  created_at: number
  updated_at: number
}

interface SqlChunkRow {
  id: string
  document_id: string
  ordinal: number
  content: string
  content_hash: string
  token_count: number
  embedding: Buffer | null
  embedding_model_id: string | null
  embedding_model_revision: string | null
  embedding_dimension: number | null
  embedding_normalized: number
  embedded_at: number | null
}

interface SqlPresetQaRow {
  id: string
  question: string
  normalized_question: string
  answer: string
  content_hash: string
  embedding: Buffer | null
  embedding_model_id: string | null
  embedding_model_revision: string | null
  embedding_dimension: number | null
  embedding_normalized: number
  embedded_at: number | null
  created_at: number
  updated_at: number
}

interface SqlSessionRow {
  id: string
  project_id: string | null
  mode: SessionMode
  audio_source: AudioSource
  status: string
  started_at: number
  ended_at: number | null
}

interface SqlTurnRow {
  id: string
  project_id: string | null
  session_id: string
  ordinal: number
  question: string
  answer: string
  source_ids_json: string
  round_id: string | null
  answer_origin: AnswerOrigin | null
  selected_answer_version_id: string | null
  created_at: number
}

interface SqlQaRoundRow {
  id: string
  project_id: string | null
  session_id: string
  ordinal: number
  status: QaRoundStatus
  question_preview: string
  started_at: number
  completed_at: number | null
  selected_answer_version_id: string | null
}

interface SqlQaRoundPageRow extends SqlQaRoundRow {
  cursor_rowid: number
}

interface SqlQaAnswerVersionRow {
  id: string
  project_id: string | null
  operation_id: string
  round_id: string
  ordinal: number
  stage: QaAnswerVersion['stage']
  question_revision: number
  question_snapshot: string
  question_identity: string
  answer: string
  retrieval_route: RetrievalRoute
  sources_json: string
  elapsed_ms: number
  created_at: number
  is_selected: number
  is_superseded: number
  answer_unchanged: number
  content_fingerprint: string
}

interface SqlFrontDraftRow {
  id: string
  session_id: string
  transcript: string
  content_hash: string
  structured_markdown: string | null
  status: FrontDraftStatus
  created_at: number
  updated_at: number
}

interface SqlIndexJobRow {
  id: string
  owner_type: IndexOwnerType
  owner_id: string
  operation: 'upsert' | 'delete'
  content_hash: string
  status: IndexJobStatus
  attempt_count: number
  last_error_code: string | null
  available_at: number
  created_at: number
  updated_at: number
}

interface SqlProjectRow {
  id: string
  display_name: string
  root_path: string
  root_identity: string
  schema_version: number
  sync_policy: ProjectSyncPolicy
  scan_generation: number
  knowledge_version: number
  availability: ProjectAvailability
  last_error_code: string | null
  last_scan_at: number | null
  data_revision: number
  created_at: number
  updated_at: number
}

interface SqlProjectSourceFileRow {
  source_id: string
  project_id: string
  trust_kind: ProjectSourceFileRecord['trustKind']
  display_relative_path: string
  path_key: string
  category_hint: ProjectSourceFileRecord['categoryHint']
  size_bytes: number
  mtime_ns: string
  device_id: string | null
  inode: string | null
  observed_raw_sha256: string | null
  detected_type: string
  conversion_disposition: ProjectSourceFileRecord['conversionDisposition']
  active_revision_id: string | null
  last_good_revision_id: string | null
  last_seen_generation: number
  state: ProjectSourceState
  error_code: string | null
  missing_since_generation: number | null
  tombstoned_at: number | null
  created_at: number
  updated_at: number
}

interface SqlProjectSourcePageRow extends SqlProjectSourceFileRow {
  cursor_rowid: number
}

interface SqlProjectSourceRevisionRow {
  revision_id: string
  source_id: string
  raw_sha256: string
  size_bytes: number
  detected_type: string
  generation: number
  state: ProjectSourceRevisionRecord['state']
  conversion_mode: ProjectSourceRevisionRecord['conversionMode']
  converter_id: string | null
  converter_version: string | null
  artifact_schema_version: number | null
  model_id: string | null
  model_revision: string | null
  prompt_config_hash: string | null
  cache_key: string | null
  error_code: string | null
  created_at: number
  activated_at: number | null
}

interface SqlConversionArtifactRow {
  artifact_id: string
  revision_id: string
  relative_output_path: string
  output_sha256: string
  canonical_body_sha256: string | null
  output_size_bytes: number | null
  output_mtime_ns: string | null
  output_device_id: string | null
  output_inode: string | null
  content_kind: ConversionArtifactRecord['contentKind']
  warnings_json: string
  validation_state: ConversionArtifactRecord['validationState']
  published_at: number | null
  committed_at: number | null
  manual_modified_at: number | null
  created_at: number
  updated_at: number
}

interface SqlConversionJobRow {
  operation_id: string
  project_id: string
  source_id: string
  revision_id: string
  artifact_id: string | null
  generation: number
  state: ConversionJobState
  input_sha256: string
  temp_relative_path: string
  final_relative_path: string
  output_sha256: string | null
  conversion_mode: ConversionJobRecord['conversionMode']
  converter_id: string
  converter_version: string
  artifact_schema_version: number
  model_id: string | null
  model_revision: string | null
  prompt_config_hash: string | null
  cache_key: string
  attempt: number
  error_code: string | null
  created_at: number
  updated_at: number
}

interface SqlProjectSyncRunRow {
  run_id: string
  project_id: string
  generation: number
  trigger: ProjectSyncRunRecord['trigger']
  state: ProjectSyncRunState
  root_identity: string
  counts_json: string
  error_code: string | null
  started_at: number
  completed_at: number | null
  updated_at: number
}

interface SqlSimulationJobRow {
  job_id: string
  project_id: string
  create_operation_id: string
  knowledge_version: number
  project_data_revision: number
  source_manifest_hash: string
  source_count: number
  target_count: number
  brief_json: string
  brief_fingerprint: string
  status: SimulationJobStatus
  generation: number
  reliable_count: number
  gap_count: number
  approved_count: number
  published_count: number
  next_batch_ordinal: number
  data_revision: number
  large_run_acknowledged_at: number | null
  error_code: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

interface SqlSimulationJobPageRow extends SqlSimulationJobRow {
  cursor_rowid: number
}

interface SqlSimulationCheckpointRow {
  operation_id: string
  job_id: string
  kind: 'create' | 'status' | 'batch' | 'item_update' | 'review' | 'publication_prepare' |
    'publication_complete' | 'publication_cancel' | 'recovery'
  content_fingerprint: string
  result_data_revision: number
  created_at: number
}

interface SqlSimulationBatchRow {
  batch_id: string
  job_id: string
  operation_id: string
  ordinal: number
  planned_count: number
  reliable_count: number
  gap_count: number
  content_fingerprint: string
  created_at: number
}

interface SqlSimulationItemRow {
  item_id: string
  job_id: string
  batch_id: string
  ordinal: number
  question: string
  answer: string
  category: string | null
  review_state: SimulationItemRecord['reviewState']
  content_fingerprint: string
  edited_at: number | null
  reviewed_at: number | null
  published_at: number | null
  created_at: number
}

interface SqlSimulationItemPageRow extends SqlSimulationItemRow {
  cursor_rowid: number
}

interface SqlSimulationCitationRow {
  citation_id: string
  item_id: string
  ordinal: number
  chunk_id: string
  document_id: string
  title: string
  source_id: string | null
  source_revision_id: string | null
  content_hash: string
  excerpt: string
}

interface SqlSimulationGapRow {
  gap_id: string
  job_id: string
  batch_id: string
  ordinal: number
  topic: string
  reason: SimulationGapReason
  missing_count: number
  suggested_material: string
  checked_source_count: number
  created_at: number
}

interface SqlSimulationGapPageRow extends SqlSimulationGapRow {
  cursor_rowid: number
}

interface SqlSimulationPublicationRow {
  publication_id: string
  job_id: string
  operation_id: string
  status: SimulationPublicationRecord['status']
  content_fingerprint: string
  created_at: number
  updated_at: number
  completed_at: number | null
}

export interface DocumentUpsertResult {
  readonly document: DocumentRecord
  readonly inserted: boolean
  readonly contentChanged: boolean
  readonly removedChunkIds: readonly string[]
}

export interface PresetQaUpsertResult {
  readonly record: PresetQaRecord
  readonly inserted: boolean
  readonly contentChanged: boolean
}

export interface EmbeddingWrite {
  readonly ownerType: IndexOwnerType
  readonly ownerId: string
  readonly contentHash: string
  readonly vector: Float32Array
  readonly metadata: EmbeddingMetadata
}

export const MAX_EXACT_VECTORS = 20_000
export const MAX_QA_ANSWER_VERSIONS = 9
export const MAX_QA_CANDIDATE_VERSIONS = 8
export const MAX_QA_SOURCE_REFERENCES = 8
export const MAX_QA_WORKSPACE_PAGE_SIZE = 20
export const MAX_QA_ANSWER_CHARACTERS = 16_000
export const MAX_QA_WORKSPACE_PAGE_BYTES = 1_572_864
const MAX_QA_ROUND_ID_CHARACTERS = 128
const WORKSPACE_CURSOR_VERSION = 3
const WORKSPACE_CURSOR_SCOPE_BYTES = 16
const WORKSPACE_CURSOR_BYTES = 41
const WORKSPACE_CURSOR_CHARACTERS = 55
const PROJECT_SOURCE_CURSOR_VERSION = 1
const PROJECT_SOURCE_CURSOR_BYTES = 9
const PROJECT_SOURCE_CURSOR_CHARACTERS = 12
const MAX_PROJECT_SOURCE_PAGE_SIZE = 20
const MAX_PROJECT_RECOVERY_ITEMS = 2_000
const SIMULATION_CURSOR_VERSION = 1
const SIMULATION_CURSOR_SCOPE_BYTES = 16
const SIMULATION_CURSOR_BYTES = 33
const SIMULATION_CURSOR_CHARACTERS = 44
const MAX_SIMULATION_PAGE_SIZE = 20
const MAX_SIMULATION_EVIDENCE_HITS = 20
const MAX_SIMULATION_BATCH_PLANNED_COUNT = 40
const MAX_SIMULATION_TARGET_COUNT = 10_000
const MAX_SIMULATION_CITATIONS = 8
const MAX_SIMULATION_CITATION_EXCERPT_CHARACTERS = 1_600
const MAX_SIMULATION_PUBLICATION_ITEMS = 200
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u

export class VectorCapacityError extends Error {
  constructor(readonly capacity: number) {
    super(`Embedding capacity of ${capacity} records exceeded`)
    this.name = 'VectorCapacityError'
  }
}

function validateNonEmpty(value: string, field: string): string {
  const normalized = normalizeContent(value)
  if (!normalized) throw new Error(`${field} must not be empty`)
  return normalized
}

function validateBoundedText(value: string, field: string, maximumCharacters: number): string {
  const normalized = validateNonEmpty(value, field)
  if ([...normalized].length > maximumCharacters) {
    throw new Error(`${field} exceeds its ${maximumCharacters}-character limit`)
  }
  return normalized
}

function validateNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`)
  return value
}

function validateTimestamp(value: number, field: string): number {
  return validateNonNegativeInteger(value, field)
}

function validateSafePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`)
  return value
}

function validateIdentifier(value: string, field: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)) {
    throw new Error(`${field} is invalid`)
  }
  return normalized
}

function validateSha256(value: string, field: string): string {
  const normalized = value.trim().toLocaleLowerCase('en-US')
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${field} must be a lowercase SHA-256 hex digest`)
  return normalized
}

function validateOptionalErrorCode(value: string | null | undefined, field = 'errorCode'): string | null {
  if (value === undefined || value === null || value === '') return null
  if (!ERROR_CODE_PATTERN.test(value)) throw new Error(`${field} is invalid`)
  return value
}

function validateRootPath(value: string): string {
  const normalized = value.normalize('NFC').trim()
  if (!normalized.startsWith('/') || normalized.length > 4096 || normalized.includes('\0')) {
    throw new Error('rootPath must be a bounded absolute local path')
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized
}

function validateRelativeProjectPath(value: string, field: string): string {
  const normalized = value.normalize('NFC').replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (
    normalized.length < 1 || normalized.length > 4096 || normalized.startsWith('/') ||
    normalized.includes('\0') || normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${field} must remain inside the project root`)
  }
  return normalized
}

function validateMtimeNs(value: string): string {
  const normalized = value.trim()
  if (!/^\d{1,32}$/u.test(normalized)) throw new Error('mtimeNs must be decimal nanoseconds')
  return normalized
}

function validateWarnings(warnings: readonly string[] | undefined): readonly string[] {
  if (!warnings) return []
  if (warnings.length > 100) throw new Error('warnings must contain at most 100 codes')
  const seen = new Set<string>()
  for (const warning of warnings) {
    if (!ERROR_CODE_PATTERN.test(warning) || seen.has(warning)) throw new Error('warnings contain an invalid code')
    seen.add(warning)
  }
  return [...seen]
}

function validateSourceReferences(sources: readonly SourceReference[]): readonly SourceReference[] {
  if (sources.length > MAX_QA_SOURCE_REFERENCES) {
    throw new Error(`sources must contain at most ${MAX_QA_SOURCE_REFERENCES} references`)
  }
  const seen = new Set<string>()
  return sources.map((source, index) => {
    const id = validateBoundedText(source.id, `sources[${index}].id`, 256)
    if (seen.has(id)) throw new Error('sources must not contain duplicate IDs')
    seen.add(id)
    const documentId = validateBoundedText(source.documentId, `sources[${index}].documentId`, 256)
    const title = validateBoundedText(source.title, `sources[${index}].title`, 300)
    const excerpt = validateBoundedText(source.excerpt, `sources[${index}].excerpt`, 1_600)
    if (source.kind !== 'preset_qa' && source.kind !== 'source_document') {
      throw new Error(`sources[${index}].kind is invalid`)
    }
    if (!Number.isFinite(source.score) || source.score < -1 || source.score > 1) {
      throw new Error(`sources[${index}].score must be finite and between -1 and 1`)
    }
    return { id, documentId, title, kind: source.kind, excerpt, score: source.score }
  })
}

function parseSourceReferences(raw: string): readonly SourceReference[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new Error('Stored QA answer sources are invalid')
  }
  if (!Array.isArray(parsed)) throw new Error('Stored QA answer sources are invalid')
  return validateSourceReferences(parsed as SourceReference[])
}

function answerVersionFingerprint(input: {
  readonly stage: QaAnswerVersion['stage']
  readonly questionRevision: number
  readonly questionSnapshot: string
  readonly questionIdentity: string
  readonly answer: string
  readonly retrievalRoute: RetrievalRoute
  readonly sources: readonly SourceReference[]
}): string {
  return sha256(JSON.stringify({
    stage: input.stage,
    questionRevision: input.questionRevision,
    questionIdentity: input.questionIdentity,
    answer: input.answer,
    retrievalRoute: input.retrievalRoute,
    sourceIds: input.sources.map((source) => source.id).sort(),
  }))
}

function validateChunks(chunks: readonly ChunkInput[]): readonly ChunkInput[] {
  if (chunks.length === 0) throw new Error('A document must contain at least one chunk')
  return chunks.map((chunk, index) => {
    const content = validateNonEmpty(chunk.content, `chunks[${index}].content`)
    if (!Number.isSafeInteger(chunk.tokenCount) || chunk.tokenCount < 1 || chunk.tokenCount > 512) {
      throw new Error(`chunks[${index}].tokenCount must be an integer between 1 and 512`)
    }
    return { content, tokenCount: chunk.tokenCount }
  })
}

function encodeVector(vector: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT)
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index] ?? 0, index * Float32Array.BYTES_PER_ELEMENT)
  }
  return buffer
}

function decodeVector(buffer: Buffer | null, dimension: number | null): Float32Array | null {
  if (buffer === null || dimension === null) return null
  if (buffer.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error('Stored embedding byte length does not match its dimension')
  }
  const vector = new Float32Array(dimension)
  for (let index = 0; index < dimension; index += 1) {
    vector[index] = buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT)
  }
  return vector
}

function assertNormalizedVector(vector: Float32Array, metadata: EmbeddingMetadata): void {
  if (!metadata.normalized) throw new Error('Only normalized embeddings may be persisted')
  if (metadata.dimension !== vector.length || vector.length === 0) {
    throw new Error('Embedding dimension does not match vector length')
  }
  let normSquared = 0
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('Embedding contains a non-finite value')
    normSquared += value * value
  }
  if (Math.abs(Math.sqrt(normSquared) - 1) > 0.001) {
    throw new Error('Embedding must be L2-normalized before persistence')
  }
}

function documentFromRow(row: SqlDocumentRow): DocumentRecord {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    sourceUri: row.source_uri,
    content: row.content,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function chunkFromRow(row: SqlChunkRow): ChunkRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    ordinal: row.ordinal,
    content: row.content,
    contentHash: row.content_hash,
    tokenCount: row.token_count,
    embedding: decodeVector(row.embedding, row.embedding_dimension),
    embeddingModelId: row.embedding_model_id,
    embeddingModelRevision: row.embedding_model_revision,
    embeddingDimension: row.embedding_dimension,
    embeddingNormalized: row.embedding_normalized === 1,
    embeddedAt: row.embedded_at,
  }
}

function presetQaFromRow(row: SqlPresetQaRow): PresetQaRecord {
  return {
    id: row.id,
    question: row.question,
    normalizedQuestion: row.normalized_question,
    answer: row.answer,
    contentHash: row.content_hash,
    embedding: decodeVector(row.embedding, row.embedding_dimension),
    embeddingModelId: row.embedding_model_id,
    embeddingModelRevision: row.embedding_model_revision,
    embeddingDimension: row.embedding_dimension,
    embeddingNormalized: row.embedding_normalized === 1,
    embeddedAt: row.embedded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function sessionFromRow(row: SqlSessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    mode: row.mode,
    audioSource: row.audio_source,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

function turnFromRow(row: SqlTurnRow): TurnRecord {
  const parsed = JSON.parse(row.source_ids_json) as unknown
  const sourceIds = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    question: row.question,
    answer: row.answer,
    sourceIds,
    roundId: row.round_id,
    answerOrigin: row.answer_origin,
    selectedAnswerVersionId: row.selected_answer_version_id,
    createdAt: row.created_at,
  }
}

function boundedLegacyWorkspaceText(value: string, maximumCharacters: number): string {
  let characters = 0
  let prefixEnd = 0
  let offset = 0
  for (const character of value) {
    if (characters === maximumCharacters - 1) prefixEnd = offset
    characters += 1
    offset += character.length
    if (characters > maximumCharacters) return `${value.slice(0, prefixEnd)}…`
  }
  return value
}

function boundedLegacyWorkspaceId(value: string, namespace: string): string {
  return value.length <= 256 ? value : stableId(namespace, value)
}

function answerVersionFromRow(row: SqlQaAnswerVersionRow): QaAnswerVersion {
  const legacy = row.stage === 'legacy_committed'
  return {
    id: legacy ? boundedLegacyWorkspaceId(row.id, 'legacy_version_view') : row.id,
    roundId: legacy ? boundedLegacyWorkspaceId(row.round_id, 'legacy_round_view') : row.round_id,
    ordinal: row.ordinal,
    stage: row.stage,
    questionRevision: row.question_revision,
    questionSnapshot: legacy ? boundedLegacyWorkspaceText(row.question_snapshot, 4_000) : row.question_snapshot,
    questionIdentity: legacy ? boundedLegacyWorkspaceText(row.question_identity, 512) : row.question_identity,
    answer: legacy ? boundedLegacyWorkspaceText(row.answer, MAX_QA_ANSWER_CHARACTERS) : row.answer,
    retrievalRoute: row.retrieval_route,
    sources: parseSourceReferences(row.sources_json),
    elapsedMs: row.elapsed_ms,
    createdAt: row.created_at,
    isSelected: row.is_selected === 1,
    isSuperseded: row.is_superseded === 1,
    answerUnchanged: row.answer_unchanged === 1,
  }
}

function roundFromRow(row: SqlQaRoundRow, versions: readonly QaAnswerVersion[]): QaWorkspaceRound {
  const legacy = versions.some((version) => version.stage === 'legacy_committed')
  return {
    id: legacy ? boundedLegacyWorkspaceId(row.id, 'legacy_round_view') : row.id,
    sessionId: legacy ? boundedLegacyWorkspaceId(row.session_id, 'legacy_session_view') : row.session_id,
    ordinal: row.ordinal,
    status: row.status,
    questionPreview: legacy ? boundedLegacyWorkspaceText(row.question_preview, 4_000) : row.question_preview,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    selectedAnswerVersionId: legacy && row.selected_answer_version_id !== null
      ? boundedLegacyWorkspaceId(row.selected_answer_version_id, 'legacy_version_view')
      : row.selected_answer_version_id,
    versions,
  }
}

interface WorkspaceCursorPayload {
  readonly scopeDigest: Buffer
  readonly dataRevision: number
  readonly startedAt: number
  readonly rowid: number
}

function workspaceScopeDigest(projectId: string | null): Buffer {
  return Buffer.from(sha256(`qa-workspace-scope:${projectId ?? 'legacy'}`), 'hex').subarray(0, WORKSPACE_CURSOR_SCOPE_BYTES)
}

function encodeWorkspaceCursor(
  row: Pick<SqlQaRoundPageRow, 'started_at' | 'cursor_rowid'>,
  projectId: string | null,
  dataRevision: number,
): string {
  if (!Number.isSafeInteger(row.started_at) || row.started_at < 0) {
    throw new Error('Workspace cursor timestamp is invalid')
  }
  if (!Number.isSafeInteger(row.cursor_rowid) || row.cursor_rowid < 1) {
    throw new Error('Workspace cursor row is invalid')
  }
  validateNonNegativeInteger(dataRevision, 'dataRevision')
  const payload = Buffer.allocUnsafe(WORKSPACE_CURSOR_BYTES)
  payload.writeUInt8(WORKSPACE_CURSOR_VERSION, 0)
  workspaceScopeDigest(projectId).copy(payload, 1)
  payload.writeBigUInt64BE(BigInt(dataRevision), 17)
  payload.writeBigUInt64BE(BigInt(row.started_at), 25)
  payload.writeBigUInt64BE(BigInt(row.cursor_rowid), 33)
  return payload.toString('base64url')
}

function decodeWorkspaceCursor(cursor: string): WorkspaceCursorPayload {
  const fail = (): never => { throw new Error('Invalid workspace cursor') }
  if (!new RegExp(`^[A-Za-z0-9_-]{${WORKSPACE_CURSOR_CHARACTERS}}$`, 'u').test(cursor)) return fail()
  try {
    const payload = Buffer.from(cursor, 'base64url')
    if (payload.length !== WORKSPACE_CURSOR_BYTES || payload.readUInt8(0) !== WORKSPACE_CURSOR_VERSION) return fail()
    const dataRevision = payload.readBigUInt64BE(17)
    const startedAt = payload.readBigUInt64BE(25)
    const rowid = payload.readBigUInt64BE(33)
    if (
      dataRevision > BigInt(Number.MAX_SAFE_INTEGER) || startedAt > BigInt(Number.MAX_SAFE_INTEGER) ||
      rowid < 1n || rowid > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return fail()
    }
    return {
      scopeDigest: Buffer.from(payload.subarray(1, 17)),
      dataRevision: Number(dataRevision),
      startedAt: Number(startedAt),
      rowid: Number(rowid),
    }
  } catch {
    return fail()
  }
}

function workspacePageByteLength(page: QaWorkspacePage): number {
  return Buffer.byteLength(JSON.stringify(page), 'utf8')
}

function assertWorkspaceRoundFitsPage(round: QaWorkspaceRound, dataRevision: number): void {
  const maximumEnvelope: QaWorkspacePage = {
    projectId: 'p'.repeat(128),
    totalRounds: Number.MAX_SAFE_INTEGER,
    items: [round],
    nextCursor: 'A'.repeat(WORKSPACE_CURSOR_CHARACTERS),
    dataRevision: Math.max(dataRevision, Number.MAX_SAFE_INTEGER),
  }
  if (workspacePageByteLength(maximumEnvelope) > MAX_QA_WORKSPACE_PAGE_BYTES) {
    throw new Error('QA round exceeds the workspace page byte budget')
  }
}

function frontDraftFromRow(row: SqlFrontDraftRow): FrontDraftRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    transcript: row.transcript,
    contentHash: row.content_hash,
    structuredMarkdown: row.structured_markdown,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function indexJobFromRow(row: SqlIndexJobRow): IndexJobRecord {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    operation: row.operation,
    contentHash: row.content_hash,
    status: row.status,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    availableAt: row.available_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function projectFromRow(row: SqlProjectRow): ProjectRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    rootPath: row.root_path,
    rootIdentity: row.root_identity,
    schemaVersion: row.schema_version,
    syncPolicy: row.sync_policy,
    scanGeneration: row.scan_generation,
    knowledgeVersion: row.knowledge_version,
    availability: row.availability,
    lastErrorCode: row.last_error_code,
    lastScanAt: row.last_scan_at,
    dataRevision: row.data_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function projectSourceFromRow(row: SqlProjectSourceFileRow): ProjectSourceFileRecord {
  return {
    sourceId: row.source_id,
    projectId: row.project_id,
    trustKind: row.trust_kind,
    displayRelativePath: row.display_relative_path,
    pathKey: row.path_key,
    categoryHint: row.category_hint,
    sizeBytes: row.size_bytes,
    mtimeNs: row.mtime_ns,
    deviceId: row.device_id,
    inode: row.inode,
    observedRawSha256: row.observed_raw_sha256,
    detectedType: row.detected_type,
    conversionDisposition: row.conversion_disposition,
    activeRevisionId: row.active_revision_id,
    lastGoodRevisionId: row.last_good_revision_id,
    lastSeenGeneration: row.last_seen_generation,
    state: row.state,
    errorCode: row.error_code,
    missingSinceGeneration: row.missing_since_generation,
    tombstonedAt: row.tombstoned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function projectRevisionFromRow(row: SqlProjectSourceRevisionRow): ProjectSourceRevisionRecord {
  return {
    revisionId: row.revision_id,
    sourceId: row.source_id,
    rawSha256: row.raw_sha256,
    sizeBytes: row.size_bytes,
    detectedType: row.detected_type,
    generation: row.generation,
    state: row.state,
    conversionMode: row.conversion_mode,
    converterId: row.converter_id,
    converterVersion: row.converter_version,
    artifactSchemaVersion: row.artifact_schema_version,
    modelId: row.model_id,
    modelRevision: row.model_revision,
    promptConfigHash: row.prompt_config_hash,
    cacheKey: row.cache_key,
    errorCode: row.error_code,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  }
}

function conversionArtifactFromRow(row: SqlConversionArtifactRow): ConversionArtifactRecord {
  const parsed = JSON.parse(row.warnings_json) as unknown
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error('Stored conversion artifact warnings are invalid')
  }
  return {
    artifactId: row.artifact_id,
    revisionId: row.revision_id,
    relativeOutputPath: row.relative_output_path,
    outputSha256: row.output_sha256,
    canonicalBodySha256: row.canonical_body_sha256,
    outputSizeBytes: row.output_size_bytes,
    outputMtimeNs: row.output_mtime_ns,
    outputDeviceId: row.output_device_id,
    outputInode: row.output_inode,
    contentKind: row.content_kind,
    warnings: parsed,
    validationState: row.validation_state,
    publishedAt: row.published_at,
    committedAt: row.committed_at,
    manualModifiedAt: row.manual_modified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function conversionJobFromRow(row: SqlConversionJobRow): ConversionJobRecord {
  return {
    operationId: row.operation_id,
    projectId: row.project_id,
    sourceId: row.source_id,
    revisionId: row.revision_id,
    artifactId: row.artifact_id,
    generation: row.generation,
    state: row.state,
    inputSha256: row.input_sha256,
    tempRelativePath: row.temp_relative_path,
    finalRelativePath: row.final_relative_path,
    outputSha256: row.output_sha256,
    conversionMode: row.conversion_mode,
    converterId: row.converter_id,
    converterVersion: row.converter_version,
    artifactSchemaVersion: row.artifact_schema_version,
    modelId: row.model_id,
    modelRevision: row.model_revision,
    promptConfigHash: row.prompt_config_hash,
    cacheKey: row.cache_key,
    attempt: row.attempt,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const EMPTY_PROJECT_SYNC_COUNTS: ProjectSyncCounts = {
  discovered: 0,
  added: 0,
  changed: 0,
  renamed: 0,
  unchanged: 0,
  converted: 0,
  manualReady: 0,
  missingGrace: 0,
  tombstoned: 0,
  blocked: 0,
  failed: 0,
}

function validateProjectSyncCounts(value: unknown): ProjectSyncCounts {
  if (typeof value !== 'object' || value === null) throw new Error('Stored project sync counts are invalid')
  const row = value as Record<string, unknown>
  const result = { ...EMPTY_PROJECT_SYNC_COUNTS }
  for (const key of Object.keys(result) as Array<keyof ProjectSyncCounts>) {
    const count = row[key]
    // v6 databases created before converted/manualReady were added do not have
    // these two JSON properties. They are a backwards-compatible zero.
    if ((key === 'converted' || key === 'manualReady') && count === undefined) continue
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error('Stored project sync counts are invalid')
    }
    result[key] = count as number
  }
  return result
}

function projectSyncRunFromRow(row: SqlProjectSyncRunRow): ProjectSyncRunRecord {
  return {
    runId: row.run_id,
    projectId: row.project_id,
    generation: row.generation,
    trigger: row.trigger,
    state: row.state,
    rootIdentity: row.root_identity,
    counts: validateProjectSyncCounts(JSON.parse(row.counts_json) as unknown),
    errorCode: row.error_code,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  }
}

function validateSimulationBrief(input: SimulationInterviewBrief): SimulationInterviewBrief {
  const validateList = (values: readonly string[], field: string, required: boolean): readonly string[] => {
    if (required && values.length === 0) throw new Error(`${field} must contain at least one entry`)
    if (values.length > 20) throw new Error(`${field} must contain at most 20 entries`)
    const seen = new Set<string>()
    return values.map((value, index) => {
      const normalized = validateBoundedText(value, `${field}[${index}]`, 500)
      if (seen.has(normalized)) throw new Error(`${field} must not contain duplicate entries`)
      seen.add(normalized)
      return normalized
    })
  }
  if (input.answerStyle !== 'concise' && input.answerStyle !== 'standard' && input.answerStyle !== 'detailed') {
    throw new Error('brief.answerStyle is invalid')
  }
  return {
    intervieweeIdentity: validateBoundedText(input.intervieweeIdentity, 'brief.intervieweeIdentity', 500),
    audience: validateBoundedText(input.audience, 'brief.audience', 500),
    focusTopics: validateList(input.focusTopics, 'brief.focusTopics', true),
    scenario: validateBoundedText(input.scenario, 'brief.scenario', 1_000),
    answerStyle: input.answerStyle,
    excludedTopics: validateList(input.excludedTopics, 'brief.excludedTopics', false),
  }
}

function parseSimulationBrief(raw: string): SimulationInterviewBrief {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new Error('Stored simulation interview brief is invalid')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Stored simulation interview brief is invalid')
  const value = parsed as Record<string, unknown>
  if (
    typeof value.intervieweeIdentity !== 'string' || typeof value.audience !== 'string' ||
    !Array.isArray(value.focusTopics) || !value.focusTopics.every((entry) => typeof entry === 'string') ||
    typeof value.scenario !== 'string' ||
    (value.answerStyle !== 'concise' && value.answerStyle !== 'standard' && value.answerStyle !== 'detailed') ||
    !Array.isArray(value.excludedTopics) || !value.excludedTopics.every((entry) => typeof entry === 'string')
  ) throw new Error('Stored simulation interview brief is invalid')
  return validateSimulationBrief({
    intervieweeIdentity: value.intervieweeIdentity,
    audience: value.audience,
    focusTopics: value.focusTopics,
    scenario: value.scenario,
    answerStyle: value.answerStyle,
    excludedTopics: value.excludedTopics,
  })
}

function simulationJobFromRow(row: SqlSimulationJobRow): SimulationJobRecord {
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    createOperationId: row.create_operation_id,
    knowledgeVersion: row.knowledge_version,
    projectDataRevision: row.project_data_revision,
    sourceManifestHash: row.source_manifest_hash,
    sourceCount: row.source_count,
    targetCount: row.target_count,
    brief: parseSimulationBrief(row.brief_json),
    briefFingerprint: row.brief_fingerprint,
    status: row.status,
    generation: row.generation,
    reliableCount: row.reliable_count,
    gapCount: row.gap_count,
    approvedCount: row.approved_count,
    publishedCount: row.published_count,
    nextBatchOrdinal: row.next_batch_ordinal,
    dataRevision: row.data_revision,
    largeRunAcknowledgedAt: row.large_run_acknowledged_at,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function simulationBatchFromRow(row: SqlSimulationBatchRow): SimulationBatchRecord {
  return {
    batchId: row.batch_id,
    jobId: row.job_id,
    operationId: row.operation_id,
    ordinal: row.ordinal,
    plannedCount: row.planned_count,
    reliableCount: row.reliable_count,
    gapCount: row.gap_count,
    contentFingerprint: row.content_fingerprint,
    createdAt: row.created_at,
  }
}

function simulationCitationFromRow(row: SqlSimulationCitationRow): SimulationCitationRecord {
  return {
    citationId: row.citation_id,
    itemId: row.item_id,
    ordinal: row.ordinal,
    chunkId: row.chunk_id,
    documentId: row.document_id,
    title: row.title,
    sourceId: row.source_id,
    sourceRevisionId: row.source_revision_id,
    contentHash: row.content_hash,
    excerpt: row.excerpt,
  }
}

function simulationItemContentFingerprint(
  question: string,
  answer: string,
  category: string | null,
  citations: ReadonlyArray<{
    readonly chunkId: string
    readonly sourceId?: string | null
    readonly sourceRevisionId?: string | null
    readonly contentHash: string
  }>,
): string {
  return sha256(JSON.stringify({
    question: normalizeQuestion(question),
    answer: normalizeContent(answer),
    category,
    citations: citations.map((citation) => ({
      chunkId: citation.chunkId,
      sourceId: citation.sourceId ?? null,
      sourceRevisionId: citation.sourceRevisionId ?? null,
      contentHash: citation.contentHash,
    })),
  }))
}

function simulationItemFromRow(
  row: SqlSimulationItemRow,
  citations: readonly SimulationCitationRecord[],
): SimulationItemRecord {
  return {
    itemId: row.item_id,
    jobId: row.job_id,
    batchId: row.batch_id,
    ordinal: row.ordinal,
    question: row.question,
    answer: row.answer,
    category: row.category,
    reviewState: row.review_state,
    contentFingerprint: row.content_fingerprint,
    citations,
    editedAt: row.edited_at,
    reviewedAt: row.reviewed_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  }
}

function simulationGapFromRow(row: SqlSimulationGapRow): SimulationGapRecord {
  return {
    gapId: row.gap_id,
    jobId: row.job_id,
    batchId: row.batch_id,
    ordinal: row.ordinal,
    topic: row.topic,
    reason: row.reason,
    missingCount: row.missing_count,
    suggestedMaterial: row.suggested_material,
    checkedSourceCount: row.checked_source_count,
    createdAt: row.created_at,
  }
}

function simulationPublicationFromRow(
  row: SqlSimulationPublicationRow,
  itemIds: readonly string[],
  presetQaIds: readonly string[],
): SimulationPublicationRecord {
  return {
    publicationId: row.publication_id,
    jobId: row.job_id,
    operationId: row.operation_id,
    status: row.status,
    contentFingerprint: row.content_fingerprint,
    itemIds,
    presetQaIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

interface SimulationCursorPayload {
  readonly scopeDigest: Buffer
  readonly dataRevision: number
  readonly rowid: number
}

function simulationScopeDigest(scope: string): Buffer {
  return Buffer.from(sha256(`simulation-scope:${scope}`), 'hex').subarray(0, SIMULATION_CURSOR_SCOPE_BYTES)
}

function boundedSimulationExcerpt(value: string): string {
  const characters = [...value]
  return characters.length <= MAX_SIMULATION_CITATION_EXCERPT_CHARACTERS
    ? value
    : characters.slice(0, MAX_SIMULATION_CITATION_EXCERPT_CHARACTERS).join('')
}

function encodeSimulationCursor(rowid: number, scope: string, dataRevision: number): string {
  if (!Number.isSafeInteger(rowid) || rowid < 1) throw new Error('Simulation cursor row is invalid')
  validateNonNegativeInteger(dataRevision, 'dataRevision')
  const payload = Buffer.allocUnsafe(SIMULATION_CURSOR_BYTES)
  payload.writeUInt8(SIMULATION_CURSOR_VERSION, 0)
  simulationScopeDigest(scope).copy(payload, 1)
  payload.writeBigUInt64BE(BigInt(dataRevision), 17)
  payload.writeBigUInt64BE(BigInt(rowid), 25)
  return payload.toString('base64url')
}

function decodeSimulationCursor(cursor: string): SimulationCursorPayload {
  const fail = (): never => { throw new Error('Invalid simulation cursor') }
  if (!new RegExp(`^[A-Za-z0-9_-]{${SIMULATION_CURSOR_CHARACTERS}}$`, 'u').test(cursor)) return fail()
  try {
    const payload = Buffer.from(cursor, 'base64url')
    if (payload.length !== SIMULATION_CURSOR_BYTES || payload.readUInt8(0) !== SIMULATION_CURSOR_VERSION) return fail()
    const dataRevision = payload.readBigUInt64BE(17)
    const rowid = payload.readBigUInt64BE(25)
    if (dataRevision > BigInt(Number.MAX_SAFE_INTEGER) || rowid < 1n || rowid > BigInt(Number.MAX_SAFE_INTEGER)) {
      return fail()
    }
    return {
      scopeDigest: Buffer.from(payload.subarray(1, 17)),
      dataRevision: Number(dataRevision),
      rowid: Number(rowid),
    }
  } catch {
    return fail()
  }
}

function encodeProjectSourceCursor(rowid: number): string {
  if (!Number.isSafeInteger(rowid) || rowid < 1) throw new Error('Project source cursor row is invalid')
  const payload = Buffer.allocUnsafe(PROJECT_SOURCE_CURSOR_BYTES)
  payload.writeUInt8(PROJECT_SOURCE_CURSOR_VERSION, 0)
  payload.writeBigUInt64BE(BigInt(rowid), 1)
  return payload.toString('base64url')
}

function decodeProjectSourceCursor(cursor: string): number {
  const fail = (): never => { throw new Error('Invalid project source cursor') }
  if (!new RegExp(`^[A-Za-z0-9_-]{${PROJECT_SOURCE_CURSOR_CHARACTERS}}$`, 'u').test(cursor)) return fail()
  try {
    const payload = Buffer.from(cursor, 'base64url')
    if (payload.length !== PROJECT_SOURCE_CURSOR_BYTES || payload.readUInt8(0) !== PROJECT_SOURCE_CURSOR_VERSION) {
      return fail()
    }
    const rowid = payload.readBigUInt64BE(1)
    if (rowid < 1n || rowid > BigInt(Number.MAX_SAFE_INTEGER)) return fail()
    return Number(rowid)
  } catch {
    return fail()
  }
}

function makeFtsQuery(query: string): string | null {
  const characters = [...normalizeContent(query).normalize('NFKC')]
  if (characters.length < 3) return null
  const terms: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index <= characters.length - 3 && terms.length < 24; index += 1) {
    const term = characters.slice(index, index + 3).join('')
    if (!/[\p{L}\p{N}]/u.test(term) || seen.has(term)) continue
    seen.add(term)
    terms.push(`"${term.replaceAll('"', '""')}"`)
  }
  return terms.length > 0 ? terms.join(' OR ') : null
}

/**
 * SQLite is the canonical store and all mutations go through this single,
 * synchronous writer. The class deliberately does not expose its connection.
 */
export class DataStore {
  readonly #database: Database.Database
  #closed = false
  #writing = false

  constructor(path: string) {
    this.#database = new Database(path)
    this.#database.pragma('foreign_keys = ON')
    this.#database.pragma('busy_timeout = 5000')
    this.#database.pragma('journal_mode = WAL')
    this.#database.pragma('synchronous = FULL')
    applyMigrations(this.#database)
    this.#recoverOpenQaRounds(Date.now())
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#database.close()
  }

  integrityCheck(): string {
    this.#assertOpen()
    const row = this.#database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    return row.integrity_check
  }

  schemaVersion(): number {
    this.#assertOpen()
    return (this.#database.pragma('user_version', { simple: true }) as number | undefined) ?? 0
  }

  createProjectManifest(input: CreateProjectManifestInput, now = Date.now()): ProjectRecord {
    const id = validateIdentifier(input.id, 'projectId')
    const displayName = validateBoundedText(input.displayName, 'displayName', 200)
    const rootPath = validateRootPath(input.rootPath)
    const rootIdentity = validateBoundedText(input.rootIdentity, 'rootIdentity', 512)
    const schemaVersion = validateSafePositiveInteger(input.schemaVersion, 'schemaVersion')
    const syncPolicy = input.syncPolicy ?? 'auto_check_confirm'
    return this.#write(() => {
      const existing = this.getProject(id)
      if (existing) {
        const identical = existing.displayName === displayName && existing.rootPath === rootPath &&
          existing.rootIdentity === rootIdentity && existing.schemaVersion === schemaVersion &&
          existing.syncPolicy === syncPolicy
        if (!identical) throw new Error('Project manifest conflicts with an existing project')
        return existing
      }
      const rootConflict = this.#database
        .prepare('SELECT id FROM projects WHERE root_path = ? OR root_identity = ? LIMIT 1')
        .get(rootPath, rootIdentity) as { id: string } | undefined
      if (rootConflict) throw new Error('Project root already belongs to a different project')
      this.#database
        .prepare(
          `INSERT INTO projects(
            id, display_name, root_path, root_identity, schema_version, sync_policy,
            availability, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)`,
        )
        .run(id, displayName, rootPath, rootIdentity, schemaVersion, syncPolicy, now, now)
      this.#bumpGlobalProjectRevision()
      return this.getProject(id) as ProjectRecord
    })
  }

  relocateProjectManifest(
    input: { readonly projectId: string; readonly rootPath: string; readonly rootIdentity: string },
    now = Date.now(),
  ): ProjectRecord {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const rootPath = validateRootPath(input.rootPath)
    const rootIdentity = validateBoundedText(input.rootIdentity, 'rootIdentity', 512)
    return this.#write(() => {
      const project = this.#requireProject(projectId)
      if (project.rootPath === rootPath && project.rootIdentity === rootIdentity && project.availability === 'available') {
        return project
      }
      const conflict = this.#database
        .prepare('SELECT id FROM projects WHERE id != ? AND (root_path = ? OR root_identity = ?) LIMIT 1')
        .get(projectId, rootPath, rootIdentity) as { id: string } | undefined
      if (conflict) throw new Error('Project root already belongs to a different project')
      this.#database
        .prepare(
          `UPDATE projects SET root_path = ?, root_identity = ?, availability = 'available',
             last_error_code = NULL, data_revision = data_revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(rootPath, rootIdentity, now, projectId)
      this.#bumpGlobalProjectRevision()
      return this.getProject(projectId) as ProjectRecord
    })
  }

  setProjectAvailability(
    projectId: string,
    availability: ProjectAvailability,
    errorCode?: string | null,
    now = Date.now(),
  ): ProjectRecord {
    validateIdentifier(projectId, 'projectId')
    const normalizedError = validateOptionalErrorCode(errorCode)
    if (availability === 'available' && normalizedError !== null) {
      throw new Error('An available project cannot have an availability error')
    }
    return this.#write(() => {
      const existing = this.#requireProject(projectId)
      if (existing.availability === availability && existing.lastErrorCode === normalizedError) return existing
      this.#database
        .prepare(
          `UPDATE projects SET availability = ?, last_error_code = ?, data_revision = data_revision + 1,
             updated_at = ? WHERE id = ?`,
        )
        .run(availability, normalizedError, now, projectId)
      this.#bumpGlobalProjectRevision()
      return this.getProject(projectId) as ProjectRecord
    })
  }

  setProjectSyncPolicy(projectId: string, policy: ProjectSyncPolicy, now = Date.now()): ProjectRecord {
    validateIdentifier(projectId, 'projectId')
    return this.#write(() => {
      const existing = this.#requireProject(projectId)
      if (existing.syncPolicy === policy) return existing
      this.#database
        .prepare('UPDATE projects SET sync_policy = ?, data_revision = data_revision + 1, updated_at = ? WHERE id = ?')
        .run(policy, now, projectId)
      this.#bumpGlobalProjectRevision()
      return this.getProject(projectId) as ProjectRecord
    })
  }

  getProject(projectId: string): ProjectRecord | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as SqlProjectRow | undefined
    return row ? projectFromRow(row) : null
  }

  listProjects(): readonly ProjectRecord[] {
    this.#assertOpen()
    return (this.#database.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id').all() as SqlProjectRow[])
      .map(projectFromRow)
  }

  getActiveProjectId(): string | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT active_project_id FROM project_state WHERE singleton = 1').get() as {
      active_project_id: string | null
    }
    return row.active_project_id
  }

  setActiveProject(projectId: string | null): number {
    if (projectId !== null) validateIdentifier(projectId, 'projectId')
    return this.#write(() => {
      if (projectId !== null) this.#requireProject(projectId)
      const existing = this.getActiveProjectId()
      if (existing === projectId) return this.projectDataRevision()
      const activeProjectSession = this.#database
        .prepare('SELECT id FROM sessions WHERE project_id IS NOT NULL AND ended_at IS NULL ORDER BY started_at LIMIT 1')
        .get()
      if (activeProjectSession) throw new Error('Cannot switch projects while a project session is active')
      this.#database
        .prepare('UPDATE project_state SET active_project_id = ?, data_revision = data_revision + 1 WHERE singleton = 1')
        .run(projectId)
      return this.projectDataRevision()
    })
  }

  projectDataRevision(): number {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT data_revision FROM project_state WHERE singleton = 1').get() as {
      data_revision: number
    }
    return row.data_revision
  }

  beginProjectScan(input: BeginProjectScanInput): ProjectSyncRunRecord {
    const runId = validateIdentifier(input.runId, 'runId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const rootIdentity = validateBoundedText(input.rootIdentity, 'rootIdentity', 512)
    const startedAt = validateTimestamp(input.startedAt ?? Date.now(), 'startedAt')
    return this.#write(() => {
      const existingRun = this.getProjectSyncRun(runId)
      if (existingRun) {
        if (
          existingRun.projectId !== projectId || existingRun.trigger !== input.trigger ||
          existingRun.rootIdentity !== rootIdentity
        ) throw new Error('Project sync run ID conflicts with different input')
        return existingRun
      }
      const project = this.#requireProject(projectId)
      if (project.availability !== 'available') throw new Error('Project root is not available')
      if (project.rootIdentity !== rootIdentity) throw new Error('Project root identity changed')
      const active = this.#database
        .prepare("SELECT run_id FROM sync_runs WHERE project_id = ? AND state IN ('scanning', 'processing') LIMIT 1")
        .get(projectId) as { run_id: string } | undefined
      if (active) throw new Error('A project sync run is already active')
      const generation = project.scanGeneration + 1
      this.#database
        .prepare(
          `INSERT INTO sync_runs(
            run_id, project_id, generation, trigger, state, root_identity, counts_json, started_at, updated_at
          ) VALUES (?, ?, ?, ?, 'scanning', ?, ?, ?, ?)`,
        )
        .run(runId, projectId, generation, input.trigger, rootIdentity, JSON.stringify(EMPTY_PROJECT_SYNC_COUNTS), startedAt, startedAt)
      this.#database
        .prepare('UPDATE projects SET scan_generation = ?, data_revision = data_revision + 1, updated_at = ? WHERE id = ?')
        .run(generation, startedAt, projectId)
      this.#bumpGlobalProjectRevision()
      return this.getProjectSyncRun(runId) as ProjectSyncRunRecord
    })
  }

  getProjectSyncRun(runId: string): ProjectSyncRunRecord | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM sync_runs WHERE run_id = ?').get(runId) as
      | SqlProjectSyncRunRow
      | undefined
    return row ? projectSyncRunFromRow(row) : null
  }

  applyProjectScanManifest(input: ApplyProjectScanManifestInput): ProjectScanApplyResult {
    const runId = validateIdentifier(input.runId, 'runId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const generation = validateSafePositiveInteger(input.generation, 'generation')
    const completedAt = validateTimestamp(input.completedAt ?? Date.now(), 'completedAt')
    const observations = this.#validateProjectObservations(input.observations)
    return this.#write(() => {
      const run = this.getProjectSyncRun(runId)
      if (!run || run.projectId !== projectId || run.generation !== generation) {
        throw new Error('Project scan run does not match its project generation')
      }
      const project = this.#requireProject(projectId)
      if (project.scanGeneration !== generation || run.state !== 'scanning') {
        throw new Error('Stale project scan generation cannot update the manifest')
      }

      const counts = { ...EMPTY_PROJECT_SYNC_COUNTS, discovered: observations.length }
      const addedSourceIds: string[] = []
      const changedSourceIds: string[] = []
      const renamedSourceIds: string[] = []
      const unchangedSourceIds: string[] = []
      const missingGraceSourceIds: string[] = []
      const tombstonedSourceIds: string[] = []
      const pendingRevisions: Array<{ sourceId: string; revisionId: string }> = []
      const pendingRenames: Array<ProjectScanApplyResult['pendingRenames'][number]> = []
      const pendingTombstoneSourceIds: string[] = []
      const existingRows = this.#database
        .prepare('SELECT * FROM source_files WHERE project_id = ? ORDER BY source_id')
        .all(projectId) as SqlProjectSourceFileRow[]
      const unmatched = new Map(existingRows.map((row) => [row.source_id, row]))
      const byPath = new Map(existingRows.map((row) => [`${row.trust_kind}:${row.path_key}`, row]))
      const observedRenameKeyCounts = new Map<string, number>()
      for (const observation of observations) {
        if (observation.rawSha256 === null) continue
        const key = `${observation.trustKind}:${observation.detectedType}:${observation.rawSha256}`
        observedRenameKeyCounts.set(key, (observedRenameKeyCounts.get(key) ?? 0) + 1)
      }

      for (const observation of observations) {
        const exact = byPath.get(`${observation.trustKind}:${observation.pathKey}`)
        if (exact) {
          unmatched.delete(exact.source_id)
          const rawHash = observation.rawSha256
          if (rawHash === null || observation.conversionDisposition !== 'local') {
            this.#updateBlockedSource(exact, observation, generation, completedAt)
            counts.blocked += 1
            continue
          }
          if (exact.observed_raw_sha256 === rawHash) {
            this.#database
              .prepare(
                `UPDATE source_files SET display_relative_path = ?, size_bytes = ?, mtime_ns = ?,
                   device_id = ?, inode = ?, detected_type = ?, conversion_disposition = ?, category_hint = ?, last_seen_generation = ?,
                   state = CASE
                     WHEN last_good_revision_id IS NULL THEN 'needs_conversion'
                     WHEN state IN ('missing_grace', 'blocked') THEN 'embedding_pending'
                     WHEN state = 'tombstoned' THEN 'needs_conversion'
                     ELSE state
                   END,
                   error_code = CASE WHEN state IN ('missing_grace', 'blocked', 'tombstoned') THEN NULL ELSE error_code END,
                   missing_since_generation = NULL, tombstoned_at = NULL, updated_at = ?
                 WHERE source_id = ?`,
              )
              .run(
                observation.displayRelativePath, observation.sizeBytes, observation.mtimeNs,
                observation.deviceId, observation.inode, observation.detectedType, observation.conversionDisposition,
                observation.categoryHint,
                generation, completedAt, exact.source_id,
              )
            if (exact.last_good_revision_id === null) {
              const pending = this.#database
                .prepare(
                  `SELECT revision_id FROM source_revisions WHERE source_id = ? AND raw_sha256 = ?
                   ORDER BY created_at DESC, rowid DESC LIMIT 1`,
                )
                .get(exact.source_id, rawHash) as { revision_id: string } | undefined
              if (pending) {
                this.#database
                  .prepare("UPDATE source_revisions SET generation = ?, state = 'observed', error_code = NULL WHERE revision_id = ?")
                  .run(generation, pending.revision_id)
                pendingRevisions.push({ sourceId: exact.source_id, revisionId: pending.revision_id })
              }
            }
            counts.unchanged += 1
            unchangedSourceIds.push(exact.source_id)
          } else {
            const revisionId = this.#recordChangedSource(exact, observation, generation, completedAt)
            counts.changed += 1
            changedSourceIds.push(exact.source_id)
            pendingRevisions.push({ sourceId: exact.source_id, revisionId })
          }
          continue
        }

        const renameCandidates = observation.rawSha256 === null ? [] : [...unmatched.values()].filter((row) =>
          row.trust_kind === observation.trustKind && row.detected_type === observation.detectedType &&
          row.observed_raw_sha256 === observation.rawSha256,
        )
        const renameKey = observation.rawSha256 === null
          ? null
          : `${observation.trustKind}:${observation.detectedType}:${observation.rawSha256}`
        if (renameCandidates.length === 1 && renameKey !== null && observedRenameKeyCounts.get(renameKey) === 1) {
          pendingRenames.push({
            sourceId: (renameCandidates[0] as SqlProjectSourceFileRow).source_id,
            trustKind: observation.trustKind,
            displayRelativePath: observation.displayRelativePath,
            pathKey: observation.pathKey,
            categoryHint: observation.categoryHint,
            sizeBytes: observation.sizeBytes,
            mtimeNs: observation.mtimeNs,
            deviceId: observation.deviceId,
            inode: observation.inode,
            rawSha256: observation.rawSha256 as string,
            detectedType: observation.detectedType,
          })
        }
        const sourceId = projectSourceId(projectId, observation.trustKind, observation.pathKey)
        const renamePending = renameCandidates.length > 0
        const locallyConvertible = observation.rawSha256 !== null && observation.conversionDisposition === 'local' &&
          observation.blockedReason === null
        this.#database
          .prepare(
            `INSERT INTO source_files(
              source_id, project_id, trust_kind, display_relative_path, path_key, category_hint,
              size_bytes, mtime_ns, device_id, inode, observed_raw_sha256, detected_type, conversion_disposition,
              last_seen_generation, state, error_code, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sourceId, projectId, observation.trustKind, observation.displayRelativePath,
            observation.pathKey, observation.categoryHint, observation.sizeBytes, observation.mtimeNs,
            observation.deviceId, observation.inode, observation.rawSha256, observation.detectedType,
            observation.conversionDisposition,
            generation, !locallyConvertible || renamePending ? 'blocked' : 'needs_conversion',
            renamePending ? (renameCandidates.length > 1 ? 'RENAME_AMBIGUOUS' : 'RENAME_CONFIRMATION_REQUIRED') : observation.blockedReason,
            completedAt, completedAt,
          )
        if (locallyConvertible && !renamePending) {
          const revisionId = this.#insertObservedRevision(
            sourceId, observation.rawSha256, observation.sizeBytes, observation.detectedType, generation, completedAt,
          )
          counts.added += 1
          addedSourceIds.push(sourceId)
          pendingRevisions.push({ sourceId, revisionId })
        } else {
          counts.blocked += 1
        }
      }

      for (const missing of unmatched.values()) {
        if (missing.state === 'tombstoned') continue
        if (missing.missing_since_generation === null) {
          this.#database
            .prepare(
              `UPDATE source_files SET state = 'missing_grace', error_code = NULL,
                 missing_since_generation = ?, updated_at = ? WHERE source_id = ?`,
            )
            .run(generation, completedAt, missing.source_id)
          counts.missingGrace += 1
          missingGraceSourceIds.push(missing.source_id)
        } else if (generation > missing.missing_since_generation) {
          pendingTombstoneSourceIds.push(missing.source_id)
        }
      }

      this.#database
        .prepare("UPDATE sync_runs SET state = 'processing', counts_json = ?, updated_at = ? WHERE run_id = ?")
        .run(JSON.stringify(counts), completedAt, runId)
      this.#database
        .prepare(
          `UPDATE projects SET last_scan_at = ?, data_revision = data_revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(completedAt, completedAt, projectId)
      this.#bumpGlobalProjectRevision()
      return {
        run: this.getProjectSyncRun(runId) as ProjectSyncRunRecord,
        counts,
        addedSourceIds,
        changedSourceIds,
        renamedSourceIds,
        unchangedSourceIds,
        missingGraceSourceIds,
        tombstonedSourceIds,
        pendingRenames,
        pendingTombstoneSourceIds,
        pendingRevisions,
      }
    })
  }

  finishProjectSync(
    runId: string,
    state: Extract<ProjectSyncRunState, 'completed' | 'completed_with_errors' | 'failed' | 'cancelled'>,
    errorCode?: string | null,
    completedAt = Date.now(),
    finalCounts?: Partial<ProjectSyncCounts>,
  ): ProjectSyncRunRecord {
    validateIdentifier(runId, 'runId')
    const normalizedError = validateOptionalErrorCode(errorCode)
    return this.#write(() => {
      const run = this.getProjectSyncRun(runId)
      if (!run) throw new Error('Project sync run does not exist')
      if (!['scanning', 'processing'].includes(run.state)) {
        if (run.state === state && run.errorCode === normalizedError) {
          const replayedCounts = this.#mergeProjectSyncCounts(run.counts, finalCounts)
          if (JSON.stringify(replayedCounts) !== JSON.stringify(run.counts)) {
            throw new Error('Project sync run final counts conflict with its committed result')
          }
          return run
        }
        throw new Error('Project sync run is already terminal')
      }
      if (run.state === 'scanning' && (state === 'completed' || state === 'completed_with_errors')) {
        throw new Error('A scan manifest must be applied before successful completion')
      }
      const counts = this.#mergeProjectSyncCounts(run.counts, finalCounts)
      this.#database
        .prepare(
          `UPDATE sync_runs SET state = ?, counts_json = ?, error_code = ?, completed_at = ?, updated_at = ?
           WHERE run_id = ?`,
        )
        .run(state, JSON.stringify(counts), normalizedError, completedAt, completedAt, runId)
      this.#database
        .prepare('UPDATE projects SET data_revision = data_revision + 1, updated_at = ? WHERE id = ?')
        .run(completedAt, run.projectId)
      this.#bumpGlobalProjectRevision()
      return this.getProjectSyncRun(runId) as ProjectSyncRunRecord
    })
  }

  getProjectSource(sourceId: string): ProjectSourceFileRecord | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM source_files WHERE source_id = ?').get(sourceId) as
      | SqlProjectSourceFileRow
      | undefined
    return row ? projectSourceFromRow(row) : null
  }

  getProjectSourceRevision(revisionId: string): ProjectSourceRevisionRecord | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM source_revisions WHERE revision_id = ?').get(revisionId) as
      | SqlProjectSourceRevisionRow
      | undefined
    return row ? projectRevisionFromRow(row) : null
  }

  findProjectSourceRevision(input: {
    readonly sourceId: string
    readonly generation: number
    readonly rawSha256: string
  }): ProjectSourceRevisionRecord | null {
    this.#assertOpen()
    const rawSha256 = validateSha256(input.rawSha256, 'rawSha256')
    const row = this.#database
      .prepare(
        `SELECT * FROM source_revisions WHERE source_id = ? AND generation = ? AND raw_sha256 = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(input.sourceId, input.generation, rawSha256) as SqlProjectSourceRevisionRow | undefined
    return row ? projectRevisionFromRow(row) : null
  }

  ensureProjectSourceRevision(input: {
    readonly sourceId: string
    readonly generation: number
    readonly rawSha256: string
    readonly sizeBytes: number
    readonly detectedType: string
  }, now = Date.now()): ProjectSourceRevisionRecord {
    const sourceId = validateIdentifier(input.sourceId, 'sourceId')
    const generation = validateSafePositiveInteger(input.generation, 'generation')
    const rawSha256 = validateSha256(input.rawSha256, 'rawSha256')
    const sizeBytes = validateNonNegativeInteger(input.sizeBytes, 'sizeBytes')
    const detectedType = validateBoundedText(input.detectedType, 'detectedType', 128)
    return this.#write(() => {
      const source = this.getProjectSource(sourceId)
      if (!source) throw new Error('Project source does not exist')
      const project = this.#requireProject(source.projectId)
      if (
        project.scanGeneration !== generation || source.lastSeenGeneration !== generation ||
        source.observedRawSha256 !== rawSha256 || source.sizeBytes !== sizeBytes || source.detectedType !== detectedType
      ) throw new Error('Project source revision no longer matches the current scan generation')
      const existing = this.findProjectSourceRevision({ sourceId, generation, rawSha256 })
      if (existing) return existing
      const revisionId = this.#insertObservedRevision(sourceId, rawSha256, sizeBytes, detectedType, generation, now)
      this.#database
        .prepare(
          `UPDATE source_files SET state = 'needs_conversion', error_code = NULL, updated_at = ?
           WHERE source_id = ?`,
        )
        .run(now, sourceId)
      this.#bumpProjectRevision(source.projectId, now)
      return this.getProjectSourceRevision(revisionId) as ProjectSourceRevisionRecord
    })
  }

  applyProjectIncrementalPlan(input: ApplyProjectIncrementalPlanInput): {
    readonly renamedSourceIds: readonly string[]
    readonly tombstonedSourceIds: readonly string[]
    readonly knowledgeVersion: number
  } {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const runId = validateIdentifier(input.runId, 'runId')
    const generation = validateSafePositiveInteger(input.generation, 'generation')
    const appliedAt = validateTimestamp(input.appliedAt ?? Date.now(), 'appliedAt')
    return this.#write(() => {
      const project = this.#requireProject(projectId)
      const run = this.getProjectSyncRun(runId)
      if (!run || run.projectId !== projectId || run.generation !== generation || project.scanGeneration !== generation) {
        throw new Error('Stale project plan cannot be applied')
      }
      const renamedSourceIds: string[] = []
      const tombstonedSourceIds: string[] = []
      const seenRenameSources = new Set<string>()
      const seenRenamePaths = new Set<string>()
      for (const rename of input.renames) {
        const sourceId = validateIdentifier(rename.sourceId, 'sourceId')
        const path = validateRelativeProjectPath(rename.displayRelativePath, 'displayRelativePath')
        const pathKey = validateRelativeProjectPath(rename.pathKey, 'pathKey')
        if (seenRenameSources.has(sourceId) || seenRenamePaths.has(`${rename.trustKind}:${pathKey}`)) {
          throw new Error('Project rename plan contains a duplicate source or path')
        }
        seenRenameSources.add(sourceId)
        seenRenamePaths.add(`${rename.trustKind}:${pathKey}`)
        const source = this.getProjectSource(sourceId)
        if (!source || source.projectId !== projectId || source.trustKind !== rename.trustKind) {
          throw new Error('Project rename source does not belong to the project')
        }
        const hash = validateSha256(rename.rawSha256, 'rawSha256')
        if (source.observedRawSha256 !== hash) {
          throw new Error('Project rename plan no longer matches its source content')
        }
        const disposition = rename.conversionDisposition ?? 'local'
        const errorCode = validateOptionalErrorCode(rename.errorCode, 'errorCode')
        if (disposition === 'local' && errorCode !== null) {
          throw new Error('A local renamed source cannot have a conversion error')
        }
        const collision = this.#database
          .prepare(
            `SELECT source_id FROM source_files WHERE project_id = ? AND trust_kind = ? AND path_key = ?
             AND source_id != ? LIMIT 1`,
          )
          .get(projectId, rename.trustKind, pathKey, sourceId) as { source_id: string } | undefined
        if (collision) {
          const pending = this.getProjectSource(collision.source_id)
          if (pending?.lastGoodRevisionId !== null) throw new Error('Project rename target is already in use')
          this.#database.prepare('DELETE FROM source_files WHERE source_id = ?').run(collision.source_id)
        }
        this.#database
          .prepare(
            `UPDATE source_files SET display_relative_path = ?, path_key = ?, category_hint = ?, size_bytes = ?,
               mtime_ns = ?, device_id = ?, inode = ?, detected_type = ?, conversion_disposition = ?,
               last_seen_generation = ?, state = CASE
                 WHEN ? != 'local' THEN 'blocked'
                 WHEN last_good_revision_id IS NULL THEN 'needs_conversion'
                 ELSE 'embedding_pending'
               END,
               error_code = ?, missing_since_generation = NULL, tombstoned_at = NULL, updated_at = ?
             WHERE source_id = ?`,
          )
          .run(
            path, pathKey, rename.categoryHint ?? null, validateNonNegativeInteger(rename.sizeBytes, 'sizeBytes'),
            validateMtimeNs(rename.mtimeNs), rename.deviceId?.trim() || null, rename.inode?.trim() || null,
            validateBoundedText(rename.detectedType, 'detectedType', 128), disposition,
            generation, disposition, errorCode, appliedAt, sourceId,
          )
        renamedSourceIds.push(sourceId)
      }

      let knowledgeChanged = false
      for (const sourceIdValue of new Set(input.tombstoneSourceIds)) {
        const sourceId = validateIdentifier(sourceIdValue, 'sourceId')
        const source = this.getProjectSource(sourceId)
        if (!source || source.projectId !== projectId || source.missingSinceGeneration === null ||
          generation <= source.missingSinceGeneration) {
          throw new Error('Project tombstone is not confirmed by two complete scan generations')
        }
        this.#database
          .prepare("UPDATE source_files SET state = 'tombstoned', tombstoned_at = ?, updated_at = ? WHERE source_id = ?")
          .run(appliedAt, appliedAt, sourceId)
        const documentChanges = this.#database
          .prepare('UPDATE project_document_links SET active = 0 WHERE source_id = ? AND active = 1')
          .run(sourceId).changes
        const qaChanges = this.#database
          .prepare('UPDATE project_qa_links SET active = 0 WHERE source_id = ? AND active = 1')
          .run(sourceId).changes
        knowledgeChanged ||= documentChanges + qaChanges > 0
        tombstonedSourceIds.push(sourceId)
      }
      this.#database
        .prepare(
          `UPDATE projects SET knowledge_version = knowledge_version + ?, data_revision = data_revision + 1,
             updated_at = ? WHERE id = ?`,
        )
        .run(knowledgeChanged ? 1 : 0, appliedAt, projectId)
      const updatedCounts: ProjectSyncCounts = {
        ...run.counts,
        renamed: renamedSourceIds.length,
        tombstoned: tombstonedSourceIds.length,
      }
      this.#database
        .prepare('UPDATE sync_runs SET counts_json = ?, updated_at = ? WHERE run_id = ?')
        .run(JSON.stringify(updatedCounts), appliedAt, runId)
      this.#bumpGlobalProjectRevision()
      this.reconcileProjectIndexState(projectId, appliedAt)
      return {
        renamedSourceIds,
        tombstonedSourceIds,
        knowledgeVersion: (this.getProject(projectId) as ProjectRecord).knowledgeVersion,
      }
    })
  }

  markProjectManagedOutputModified(
    input: MarkProjectManagedOutputModifiedInput,
    now = Date.now(),
  ): ProjectSourceFileRecord {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const runId = validateIdentifier(input.runId, 'runId')
    const generation = validateSafePositiveInteger(input.generation, 'generation')
    const sourceId = validateIdentifier(input.sourceId, 'sourceId')
    const observedOutputSha256 = validateSha256(input.observedOutputSha256, 'observedOutputSha256')
    return this.#write(() => {
      const project = this.#requireProject(projectId)
      const run = this.getProjectSyncRun(runId)
      const source = this.getProjectSource(sourceId)
      if (
        !run || run.projectId !== projectId || run.generation !== generation ||
        project.scanGeneration !== generation || !source || source.projectId !== projectId ||
        source.activeRevisionId === null
      ) throw new Error('Managed-output failure belongs to a stale or unrelated project source')
      const artifact = this.#database
        .prepare(
          `SELECT artifact_id, output_sha256, validation_state FROM conversion_artifacts
           WHERE artifact_id = (
             SELECT artifact_id FROM project_document_links WHERE source_id = ? AND active = 1
             UNION ALL
             SELECT artifact_id FROM project_qa_links WHERE source_id = ? AND active = 1
             LIMIT 1
           ) AND validation_state IN ('committed', 'modified')`,
        )
        .get(sourceId, sourceId) as {
          artifact_id: string
          output_sha256: string
          validation_state: ConversionArtifactRecord['validationState']
        } | undefined
      if (!artifact) throw new Error('Managed-output source has no committed artifact')
      if (
        source.state === 'blocked' && source.errorCode === 'GENERATED_OUTPUT_MODIFIED' &&
        artifact.validation_state === 'modified' && artifact.output_sha256 !== observedOutputSha256
      ) return source
      if (artifact.output_sha256 === observedOutputSha256) {
        throw new Error('Managed-output hash still matches the committed artifact')
      }
      this.#database
        .prepare(
          `UPDATE conversion_artifacts SET validation_state = 'modified', manual_modified_at = ?, updated_at = ?
           WHERE artifact_id = ?`,
        )
        .run(now, now, artifact.artifact_id)
      this.#database
        .prepare(
          `UPDATE source_files SET state = 'blocked', error_code = 'GENERATED_OUTPUT_MODIFIED',
             last_seen_generation = ?, missing_since_generation = NULL, tombstoned_at = NULL, updated_at = ?
           WHERE source_id = ?`,
        )
        .run(generation, now, sourceId)
      this.#bumpProjectRevision(projectId, now)
      return this.getProjectSource(sourceId) as ProjectSourceFileRecord
    })
  }

  getProjectStatusSummary(projectId: string): ProjectStatusSummary {
    this.#assertOpen()
    const project = this.#requireProject(projectId)
    const counts = this.#database
      .prepare(
        `SELECT
           COUNT(*) AS total_files,
           SUM(CASE WHEN state = 'ready' THEN 1 ELSE 0 END) AS ready,
           SUM(CASE WHEN state IN (
             'missing_grace', 'blocked', 'conversion_failed', 'commit_failed', 'index_failed'
           ) THEN 1 ELSE 0 END) AS attention,
           SUM(CASE WHEN state IN ('conversion_failed', 'commit_failed', 'index_failed') THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN EXISTS (
             SELECT 1 FROM source_revisions r
             WHERE r.revision_id = source_files.active_revision_id AND r.conversion_mode = 'manual'
           ) THEN 1 ELSE 0 END) AS manual_ready,
           SUM(CASE WHEN state = 'blocked' AND conversion_disposition = 'external' THEN 1 ELSE 0 END) AS awaiting_external,
           SUM(CASE WHEN state = 'needs_conversion' THEN 1 ELSE 0 END) AS needs_conversion
         FROM source_files WHERE project_id = ? AND state != 'tombstoned'`,
      )
      .get(projectId) as {
        total_files: number
        ready: number | null
        attention: number | null
        failed: number | null
        manual_ready: number | null
        awaiting_external: number | null
        needs_conversion: number | null
      }
    const usableCounts = this.#database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM (
             SELECT 'source:' || l.source_id AS source_key
             FROM project_document_links l JOIN source_files s ON s.source_id = l.source_id
             WHERE s.project_id = ? AND l.active = 1
             GROUP BY l.source_id
             UNION ALL
             SELECT 'front:' || f.session_id AS source_key
             FROM project_front_document_links f WHERE f.project_id = ?
             GROUP BY f.session_id
           )) AS usable_document_sources,
           (SELECT COUNT(DISTINCT l.source_id)
            FROM project_qa_links l JOIN source_files s ON s.source_id = l.source_id
            WHERE s.project_id = ? AND l.active = 1) AS usable_preset_qa_sources,
           (SELECT COUNT(DISTINCT l.preset_qa_id)
            FROM project_qa_links l JOIN source_files s ON s.source_id = l.source_id
            WHERE s.project_id = ? AND l.active = 1) AS usable_preset_qa_items`,
      )
      .get(projectId, projectId, projectId, projectId) as {
        usable_document_sources: number
        usable_preset_qa_sources: number
        usable_preset_qa_items: number
      }
    const embeddingCounts = this.#database
      .prepare(
        `WITH active_owners(owner_type, owner_id, content_hash, has_embedding) AS (
           SELECT DISTINCT 'chunk', c.id, c.content_hash,
             CASE WHEN c.embedding IS NOT NULL AND c.embedding_normalized = 1 THEN 1 ELSE 0 END
           FROM project_document_links l
           JOIN source_files s ON s.source_id = l.source_id
           JOIN chunks c ON c.document_id = l.document_id
           WHERE s.project_id = ? AND l.active = 1
           UNION
           SELECT DISTINCT 'chunk', c.id, c.content_hash,
             CASE WHEN c.embedding IS NOT NULL AND c.embedding_normalized = 1 THEN 1 ELSE 0 END
           FROM project_front_document_links f
           JOIN chunks c ON c.document_id = f.document_id
           WHERE f.project_id = ?
           UNION
           SELECT DISTINCT 'preset_qa', q.id, q.content_hash,
             CASE WHEN q.embedding IS NOT NULL AND q.embedding_normalized = 1 THEN 1 ELSE 0 END
           FROM project_qa_links l
           JOIN source_files s ON s.source_id = l.source_id
           JOIN preset_qa q ON q.id = l.preset_qa_id
           WHERE s.project_id = ? AND l.active = 1
         ), owner_status AS (
           SELECT o.*,
             (SELECT j.status FROM index_jobs j
              WHERE j.owner_type = o.owner_type AND j.owner_id = o.owner_id
                AND j.operation = 'upsert' AND j.content_hash = o.content_hash
              ORDER BY j.updated_at DESC, j.rowid DESC LIMIT 1) AS job_status
           FROM active_owners o
         )
         SELECT
           SUM(CASE WHEN has_embedding = 1 AND job_status = 'ready' THEN 1 ELSE 0 END) AS ready_embedding,
           SUM(CASE WHEN job_status = 'failed' THEN 1 ELSE 0 END) AS failed_embedding,
           SUM(CASE WHEN job_status IS NULL OR job_status NOT IN ('ready', 'failed') OR
             (job_status = 'ready' AND has_embedding = 0) THEN 1 ELSE 0 END)
             AS pending_embedding
         FROM owner_status`,
      )
      .get(projectId, projectId, projectId) as {
        ready_embedding: number | null
        failed_embedding: number | null
        pending_embedding: number | null
      }
    const latestRunRow = this.#database
      .prepare('SELECT * FROM sync_runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get(projectId) as SqlProjectSyncRunRow | undefined
    const linked = this.#database
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM project_document_links l JOIN source_files s ON s.source_id = l.source_id
           WHERE s.project_id = ? AND l.active = 1
           UNION ALL
           SELECT 1 FROM project_front_document_links f WHERE f.project_id = ?
           UNION ALL
           SELECT 1 FROM project_qa_links l JOIN source_files s ON s.source_id = l.source_id
           WHERE s.project_id = ? AND l.active = 1
         ) AS usable`,
      )
      .get(projectId, projectId, projectId) as { usable: number }
    return {
      projectId,
      availability: project.availability,
      knowledgeVersion: project.knowledgeVersion,
      dataRevision: project.dataRevision,
      lastScanAt: project.lastScanAt,
      totalFiles: counts.total_files,
      ready: counts.ready ?? 0,
      attention: counts.attention ?? 0,
      failed: counts.failed ?? 0,
      pendingEmbedding: embeddingCounts.pending_embedding ?? 0,
      readyEmbedding: embeddingCounts.ready_embedding ?? 0,
      failedEmbedding: embeddingCounts.failed_embedding ?? 0,
      manualReady: counts.manual_ready ?? 0,
      awaitingExternal: counts.awaiting_external ?? 0,
      needsConversion: counts.needs_conversion ?? 0,
      usableDocumentSources: usableCounts.usable_document_sources,
      usablePresetQaSources: usableCounts.usable_preset_qa_sources,
      usablePresetQaItems: usableCounts.usable_preset_qa_items,
      actionRequiredSources: counts.attention ?? 0,
      hasUsableKnowledge: linked.usable === 1,
      latestRun: latestRunRow ? projectSyncRunFromRow(latestRunRow) : null,
    }
  }

  getProjectSimulationFence(projectIdValue: string): SimulationProjectFence {
    this.#assertOpen()
    const projectId = validateIdentifier(projectIdValue, 'projectId')
    const project = this.#requireProject(projectId)
    const rows = this.#database
      .prepare(
        `SELECT 'source' AS kind, l.source_id AS source_id, s.active_revision_id AS revision_id,
           l.document_id AS document_id, d.content_hash AS content_hash
         FROM project_document_links l
         JOIN source_files s ON s.source_id = l.source_id
         JOIN documents d ON d.id = l.document_id
         WHERE s.project_id = ? AND l.active = 1
         UNION ALL
         SELECT 'front' AS kind, f.session_id AS source_id, NULL AS revision_id,
           f.document_id AS document_id, f.document_content_hash AS content_hash
         FROM project_front_document_links f WHERE f.project_id = ?
         ORDER BY kind, source_id, revision_id, document_id, content_hash`,
      )
      .all(projectId, projectId) as Array<{
        kind: 'source' | 'front'
        source_id: string
        revision_id: string | null
        document_id: string
        content_hash: string
      }>
    return {
      projectId,
      knowledgeVersion: project.knowledgeVersion,
      projectDataRevision: project.dataRevision,
      sourceManifestHash: sha256(JSON.stringify(rows)),
      sourceCount: rows.length,
    }
  }

  searchProjectSimulationEvidence(input: {
    readonly projectId: string
    readonly knowledgeVersion: number
    readonly sourceManifestHash?: string
    readonly query: string
    readonly limit?: number
  }): readonly SimulationEvidenceHit[] {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const knowledgeVersion = validateNonNegativeInteger(input.knowledgeVersion, 'knowledgeVersion')
    const expectedManifest = input.sourceManifestHash === undefined
      ? null
      : validateSha256(input.sourceManifestHash, 'sourceManifestHash')
    const query = validateBoundedText(input.query, 'query', 4_000)
    const limit = Math.max(1, Math.min(MAX_SIMULATION_EVIDENCE_HITS, input.limit ?? MAX_SIMULATION_EVIDENCE_HITS))
    const read = this.#database.transaction((): readonly SimulationEvidenceHit[] => {
      const startFence = this.getProjectSimulationFence(projectId)
      if (
        startFence.knowledgeVersion !== knowledgeVersion ||
        (expectedManifest !== null && startFence.sourceManifestHash !== expectedManifest)
      ) throw new Error('SIMULATION_KNOWLEDGE_STALE')
      const scopeSql = `(EXISTS (
        SELECT 1 FROM project_document_links l JOIN source_files s ON s.source_id = l.source_id
        WHERE l.document_id = d.id AND l.active = 1 AND s.project_id = ?
      ) OR EXISTS (
        SELECT 1 FROM project_front_document_links f WHERE f.document_id = d.id AND f.project_id = ?
      ))`
      const select = `SELECT c.id AS chunk_id, c.document_id, d.title, c.content AS excerpt,
          c.content_hash,
          (SELECT l.source_id FROM project_document_links l JOIN source_files s ON s.source_id = l.source_id
           WHERE l.document_id = d.id AND l.active = 1 AND s.project_id = ?
           ORDER BY l.source_id LIMIT 1) AS source_id,
          (SELECT s.active_revision_id FROM project_document_links l JOIN source_files s ON s.source_id = l.source_id
           WHERE l.document_id = d.id AND l.active = 1 AND s.project_id = ?
           ORDER BY l.source_id LIMIT 1) AS source_revision_id`
      const ftsQuery = makeFtsQuery(query)
      const rows = ftsQuery
        ? this.#database
            .prepare(
              `${select}
               FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
               JOIN documents d ON d.id = c.document_id
               WHERE chunks_fts MATCH ? AND ${scopeSql}
               ORDER BY bm25(chunks_fts), c.id LIMIT ?`,
            )
            .all(projectId, projectId, ftsQuery, projectId, projectId, limit)
        : this.#database
            .prepare(
              `${select}
               FROM chunks c JOIN documents d ON d.id = c.document_id
               WHERE c.content LIKE ? ESCAPE '\\' AND ${scopeSql}
               ORDER BY d.updated_at DESC, c.ordinal, c.id LIMIT ?`,
            )
            .all(
              projectId,
              projectId,
              `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
              projectId,
              projectId,
              limit,
            )
      const result = (rows as Array<{
        chunk_id: string
        document_id: string
        source_id: string | null
        source_revision_id: string | null
        title: string
        excerpt: string
        content_hash: string
      }>).map((row) => ({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        sourceId: row.source_id,
        sourceRevisionId: row.source_revision_id,
        title: row.title,
        excerpt: boundedSimulationExcerpt(row.excerpt),
        contentHash: row.content_hash,
      }))
      const endFence = this.getProjectSimulationFence(projectId)
      if (
        endFence.knowledgeVersion !== startFence.knowledgeVersion ||
        endFence.sourceManifestHash !== startFence.sourceManifestHash
      ) throw new Error('SIMULATION_KNOWLEDGE_STALE')
      return result
    })
    return read.deferred()
  }

  getProjectSimulationSummary(projectIdValue: string): {
    readonly projectId: string
    readonly draftItems: number
    readonly evidenceGaps: number
    readonly approvedItems: number
    readonly publishedItems: number
    readonly dataRevision: number
  } {
    this.#assertOpen()
    const projectId = validateIdentifier(projectIdValue, 'projectId')
    this.#requireProject(projectId)
    const row = this.#database
      .prepare(
        `SELECT
           SUM(CASE WHEN i.review_state = 'draft' THEN 1 ELSE 0 END) AS draft_items,
           SUM(CASE WHEN i.review_state = 'approved' THEN 1 ELSE 0 END) AS approved_items,
           SUM(CASE WHEN i.review_state = 'published' THEN 1 ELSE 0 END) AS published_items
         FROM simulation_items i JOIN simulation_jobs j ON j.job_id = i.job_id
         WHERE j.project_id = ?`,
      )
      .get(projectId) as {
        draft_items: number | null
        approved_items: number | null
        published_items: number | null
      }
    const gap = this.#database
      .prepare(
        `SELECT COALESCE(SUM(g.missing_count), 0) AS count
         FROM simulation_gaps g JOIN simulation_jobs j ON j.job_id = g.job_id
         WHERE j.project_id = ?`,
      )
      .get(projectId) as { count: number }
    return {
      projectId,
      draftItems: row.draft_items ?? 0,
      evidenceGaps: gap.count,
      approvedItems: row.approved_items ?? 0,
      publishedItems: row.published_items ?? 0,
      dataRevision: this.#simulationProjectRevision(projectId),
    }
  }

  getProjectSourcePage(input: ProjectSourcePageInput): ProjectSourcePage {
    this.#assertOpen()
    const projectId = validateIdentifier(input.projectId, 'projectId')
    this.#requireProject(projectId)
    const limit = Math.min(MAX_PROJECT_SOURCE_PAGE_SIZE, Math.max(1, input.limit ?? MAX_PROJECT_SOURCE_PAGE_SIZE))
    const cursorRowid = input.cursor ? decodeProjectSourceCursor(input.cursor) : null
    const filter = input.filter ?? 'all'
    const filterSql = filter === 'attention'
      ? `AND state IN (
          'missing_grace', 'blocked', 'conversion_failed', 'commit_failed', 'index_failed'
        )`
      : filter === 'failed'
        ? "AND state IN ('conversion_failed', 'commit_failed', 'index_failed')"
        : ''
    const rows = this.#database
      .prepare(
        `SELECT source_files.*, rowid AS cursor_rowid FROM source_files
         WHERE project_id = ? ${filterSql} AND (? IS NULL OR rowid < ?)
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(projectId, cursorRowid, cursorRowid, limit + 1) as SqlProjectSourcePageRow[]
    const pageRows = rows.slice(0, limit)
    return {
      items: pageRows.map((row) => this.#hydrateProjectSourceTask(row)),
      nextCursor: rows.length > limit
        ? encodeProjectSourceCursor((pageRows.at(-1) as SqlProjectSourcePageRow).cursor_rowid)
        : null,
      dataRevision: this.#requireProject(projectId).dataRevision,
      summary: this.getProjectStatusSummary(projectId),
    }
  }

  createSimulationJob(
    input: CreateSimulationJobInput,
    now = Date.now(),
  ): { readonly job: SimulationJobRecord; readonly inserted: boolean } {
    const operationId = validateIdentifier(input.operationId, 'operationId')
    const jobId = validateIdentifier(input.jobId, 'jobId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const targetCount = validateSafePositiveInteger(input.targetCount, 'targetCount')
    if (targetCount > MAX_SIMULATION_TARGET_COUNT) {
      throw new Error(`Simulation targetCount may not exceed ${MAX_SIMULATION_TARGET_COUNT}`)
    }
    const brief = validateSimulationBrief(input.brief)
    const briefJson = JSON.stringify(brief)
    const briefFingerprint = sha256(briefJson)
    const acknowledgedAt = input.largeRunAcknowledgedAt === undefined || input.largeRunAcknowledgedAt === null
      ? null
      : validateTimestamp(input.largeRunAcknowledgedAt, 'largeRunAcknowledgedAt')
    const expectedFence: SimulationProjectFence = {
      projectId: validateIdentifier(input.fence.projectId, 'fence.projectId'),
      knowledgeVersion: validateNonNegativeInteger(input.fence.knowledgeVersion, 'fence.knowledgeVersion'),
      projectDataRevision: validateNonNegativeInteger(input.fence.projectDataRevision, 'fence.projectDataRevision'),
      sourceManifestHash: validateSha256(input.fence.sourceManifestHash, 'fence.sourceManifestHash'),
      sourceCount: validateNonNegativeInteger(input.fence.sourceCount, 'fence.sourceCount'),
    }
    if (expectedFence.projectId !== projectId) throw new Error('Simulation fence belongs to another project')
    const fingerprint = sha256(JSON.stringify({
      projectId,
      jobId,
      fence: expectedFence,
      targetCount,
      briefFingerprint,
      largeRunAcknowledged: acknowledgedAt !== null,
    }))
    return this.#write(() => {
      const existingCheckpoint = this.#getSimulationCheckpoint(operationId)
      if (existingCheckpoint) {
        if (existingCheckpoint.kind !== 'create' || existingCheckpoint.content_fingerprint !== fingerprint) {
          throw new Error('Simulation operation ID already exists with conflicting content')
        }
        const existing = this.getSimulationJob(projectId, existingCheckpoint.job_id)
        if (!existing || existing.jobId !== jobId) throw new Error('Simulation create checkpoint is inconsistent')
        return { job: existing, inserted: false }
      }
      if (this.getSimulationJob(projectId, jobId)) throw new Error('Simulation job ID already exists')
      const currentFence = this.getProjectSimulationFence(projectId)
      if (
        currentFence.knowledgeVersion !== expectedFence.knowledgeVersion ||
        currentFence.projectDataRevision !== expectedFence.projectDataRevision ||
        currentFence.sourceManifestHash !== expectedFence.sourceManifestHash ||
        currentFence.sourceCount !== expectedFence.sourceCount
      ) throw new Error('SIMULATION_KNOWLEDGE_STALE')
      if (currentFence.sourceCount === 0) throw new Error('Simulation project has no usable document evidence')
      const status: SimulationJobStatus = targetCount > 40 && acknowledgedAt === null
        ? 'awaiting_large_run_confirmation'
        : 'draft'
      this.#database
        .prepare(
          `INSERT INTO simulation_jobs(
             job_id, project_id, create_operation_id, knowledge_version, project_data_revision,
             source_manifest_hash, source_count, target_count, brief_json, brief_fingerprint,
             status, large_run_acknowledged_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          projectId,
          operationId,
          currentFence.knowledgeVersion,
          currentFence.projectDataRevision,
          currentFence.sourceManifestHash,
          currentFence.sourceCount,
          targetCount,
          briefJson,
          briefFingerprint,
          status,
          acknowledgedAt,
          now,
          now,
        )
      this.#insertSimulationCheckpoint(operationId, jobId, 'create', fingerprint, 0, now)
      this.#bumpSimulationProjectRevision(projectId)
      return { job: this.getSimulationJob(projectId, jobId) as SimulationJobRecord, inserted: true }
    })
  }

  getSimulationJob(projectIdValue: string, jobIdValue: string): SimulationJobRecord | null {
    this.#assertOpen()
    const projectId = validateIdentifier(projectIdValue, 'projectId')
    const jobId = validateIdentifier(jobIdValue, 'jobId')
    const row = this.#database
      .prepare('SELECT * FROM simulation_jobs WHERE project_id = ? AND job_id = ?')
      .get(projectId, jobId) as SqlSimulationJobRow | undefined
    return row ? simulationJobFromRow(row) : null
  }

  getLatestSimulationJob(projectIdValue: string): SimulationJobRecord | null {
    this.#assertOpen()
    const projectId = validateIdentifier(projectIdValue, 'projectId')
    this.#requireProject(projectId)
    const row = this.#database
      .prepare(
        `SELECT * FROM simulation_jobs WHERE project_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(projectId) as SqlSimulationJobRow | undefined
    return row ? simulationJobFromRow(row) : null
  }

  getSimulationJobPage(input: SimulationPageInput): SimulationJobPage {
    this.#assertOpen()
    const projectId = validateIdentifier(input.projectId, 'projectId')
    this.#requireProject(projectId)
    const limit = Math.max(1, Math.min(MAX_SIMULATION_PAGE_SIZE, input.limit ?? MAX_SIMULATION_PAGE_SIZE))
    const dataRevision = this.#simulationProjectRevision(projectId)
    if (
      input.expectedDataRevision !== undefined &&
      validateNonNegativeInteger(input.expectedDataRevision, 'expectedDataRevision') !== dataRevision
    ) throw new Error('SIMULATION_CURSOR_STALE')
    const scope = `jobs:${projectId}`
    const cursor = input.cursor ? decodeSimulationCursor(input.cursor) : null
    if (
      cursor &&
      (!cursor.scopeDigest.equals(simulationScopeDigest(scope)) || cursor.dataRevision !== dataRevision)
    ) throw new Error('SIMULATION_CURSOR_STALE')
    const rows = cursor
      ? this.#database
          .prepare(
            `SELECT rowid AS cursor_rowid, * FROM simulation_jobs
             WHERE project_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
          )
          .all(projectId, cursor.rowid, limit + 1) as SqlSimulationJobPageRow[]
      : this.#database
          .prepare(
            `SELECT rowid AS cursor_rowid, * FROM simulation_jobs
             WHERE project_id = ? ORDER BY rowid DESC LIMIT ?`,
          )
          .all(projectId, limit + 1) as SqlSimulationJobPageRow[]
    const pageRows = rows.slice(0, limit)
    return {
      projectId,
      items: pageRows.map(simulationJobFromRow),
      nextCursor: rows.length > limit
        ? encodeSimulationCursor((pageRows.at(-1) as SqlSimulationJobPageRow).cursor_rowid, scope, dataRevision)
        : null,
      dataRevision,
    }
  }

  transitionSimulationJob(
    input: TransitionSimulationJobInput,
    now = Date.now(),
  ): { readonly job: SimulationJobRecord; readonly inserted: boolean } {
    const operationId = validateIdentifier(input.operationId, 'operationId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const jobId = validateIdentifier(input.jobId, 'jobId')
    const expectedDataRevision = validateNonNegativeInteger(input.expectedDataRevision, 'expectedDataRevision')
    const expectedGeneration = validateSafePositiveInteger(input.expectedGeneration, 'expectedGeneration')
    const errorCode = validateOptionalErrorCode(input.errorCode)
    const acknowledgedAt = input.largeRunAcknowledgedAt === undefined || input.largeRunAcknowledgedAt === null
      ? null
      : validateTimestamp(input.largeRunAcknowledgedAt, 'largeRunAcknowledgedAt')
    const fingerprint = sha256(JSON.stringify({
      projectId,
      jobId,
      expectedStatus: input.expectedStatus,
      expectedGeneration,
      expectedDataRevision,
      nextStatus: input.nextStatus,
      errorCode,
      largeRunAcknowledged: acknowledgedAt !== null,
    }))
    return this.#write(() => {
      const checkpoint = this.#getSimulationCheckpoint(operationId)
      if (checkpoint) {
        if (
          checkpoint.kind !== 'status' || checkpoint.job_id !== jobId ||
          checkpoint.content_fingerprint !== fingerprint
        ) throw new Error('Simulation operation ID already exists with conflicting content')
        const replay = this.getSimulationJob(projectId, jobId)
        if (!replay) throw new Error('Simulation status checkpoint is inconsistent')
        return { job: replay, inserted: false }
      }
      const job = this.#requireSimulationJob(projectId, jobId)
      if (
        job.status !== input.expectedStatus || job.generation !== expectedGeneration ||
        job.dataRevision !== expectedDataRevision
      ) {
        throw new Error('SIMULATION_CAS_MISMATCH')
      }
      this.#assertSimulationStatusTransition(job, input.nextStatus)
      if (
        input.nextStatus === 'queued' || input.nextStatus === 'running' ||
        input.nextStatus === 'completed' || input.nextStatus === 'completed_with_gaps'
      ) this.#assertSimulationJobFence(job)
      const effectiveAcknowledgedAt = acknowledgedAt ?? job.largeRunAcknowledgedAt
      if (
        job.status === 'awaiting_large_run_confirmation' && input.nextStatus === 'draft' &&
        effectiveAcknowledgedAt === null
      ) throw new Error('SIMULATION_LARGE_RUN_CONFIRMATION_REQUIRED')
      if (
        job.targetCount > 40 &&
        (input.nextStatus === 'queued' || input.nextStatus === 'running') &&
        effectiveAcknowledgedAt === null
      ) throw new Error('SIMULATION_LARGE_RUN_CONFIRMATION_REQUIRED')
      if ((input.nextStatus === 'failed' || input.nextStatus === 'stale') && errorCode === null) {
        throw new Error('A failed or stale simulation job requires an error code')
      }
      if (input.nextStatus === 'completed') {
        if (job.gapCount !== 0 || job.reliableCount !== job.targetCount) {
          throw new Error('A completed simulation job must satisfy its target without gaps')
        }
      }
      if (input.nextStatus === 'completed_with_gaps') {
        if (job.gapCount < 1 || job.reliableCount + job.gapCount !== job.targetCount) {
          throw new Error('A simulation job with gaps must account for its complete target')
        }
      }
      const terminal = input.nextStatus === 'completed' || input.nextStatus === 'completed_with_gaps' ||
        input.nextStatus === 'failed' || input.nextStatus === 'cancelled' || input.nextStatus === 'stale'
      const nextRevision = job.dataRevision + 1
      const nextGeneration =
        (job.status === 'paused' && (input.nextStatus === 'queued' || input.nextStatus === 'running'))
          ? job.generation + 1
          : job.generation
      this.#database
        .prepare(
          `UPDATE simulation_jobs SET status = ?, generation = ?, data_revision = ?, large_run_acknowledged_at = ?,
             error_code = ?, completed_at = ?, updated_at = ? WHERE job_id = ?`,
        )
        .run(
          input.nextStatus,
          nextGeneration,
          nextRevision,
          effectiveAcknowledgedAt,
          input.nextStatus === 'failed' || input.nextStatus === 'stale' ? errorCode : null,
          terminal ? now : null,
          now,
          jobId,
        )
      this.#insertSimulationCheckpoint(operationId, jobId, 'status', fingerprint, nextRevision, now)
      this.#bumpSimulationProjectRevision(projectId)
      return { job: this.#requireSimulationJob(projectId, jobId), inserted: true }
    })
  }

  commitSimulationBatch(
    input: CommitSimulationBatchInput,
    now = Date.now(),
  ): SimulationBatchCommitResult {
    const operationId = validateIdentifier(input.operationId, 'operationId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const jobId = validateIdentifier(input.jobId, 'jobId')
    const expectedGeneration = validateSafePositiveInteger(input.expectedGeneration, 'expectedGeneration')
    const expectedDataRevision = validateNonNegativeInteger(input.expectedDataRevision, 'expectedDataRevision')
    const plannedCount = validateSafePositiveInteger(input.plannedCount, 'plannedCount')
    if (plannedCount > MAX_SIMULATION_BATCH_PLANNED_COUNT) {
      throw new Error(`A simulation batch may account for at most ${MAX_SIMULATION_BATCH_PLANNED_COUNT} targets`)
    }
    const items = input.items.map((item, itemIndex) => {
      const question = validateBoundedText(item.question, `items[${itemIndex}].question`, 4_000)
      const answer = validateBoundedText(item.answer, `items[${itemIndex}].answer`, MAX_QA_ANSWER_CHARACTERS)
      const category = item.category === undefined || item.category === null
        ? null
        : validateBoundedText(item.category, `items[${itemIndex}].category`, 200)
      if (item.citations.length < 1 || item.citations.length > MAX_SIMULATION_CITATIONS) {
        throw new Error(`items[${itemIndex}].citations must contain between 1 and ${MAX_SIMULATION_CITATIONS} entries`)
      }
      const citationKeys = new Set<string>()
      const citations = item.citations.map((citation, citationIndex): SimulationCitationInput => {
        const chunkId = validateIdentifier(citation.chunkId, `items[${itemIndex}].citations[${citationIndex}].chunkId`)
        const documentId = validateIdentifier(
          citation.documentId,
          `items[${itemIndex}].citations[${citationIndex}].documentId`,
        )
        const sourceId = citation.sourceId === undefined || citation.sourceId === null
          ? null
          : validateIdentifier(citation.sourceId, `items[${itemIndex}].citations[${citationIndex}].sourceId`)
        const sourceRevisionId = citation.sourceRevisionId === undefined || citation.sourceRevisionId === null
          ? null
          : validateIdentifier(
            citation.sourceRevisionId,
            `items[${itemIndex}].citations[${citationIndex}].sourceRevisionId`,
          )
        if ((sourceId === null) !== (sourceRevisionId === null)) {
          throw new Error('Simulation citation source and revision must both be present or both be null')
        }
        const contentHash = validateSha256(
          citation.contentHash,
          `items[${itemIndex}].citations[${citationIndex}].contentHash`,
        )
        const excerpt = validateBoundedText(
          citation.excerpt,
          `items[${itemIndex}].citations[${citationIndex}].excerpt`,
          MAX_SIMULATION_CITATION_EXCERPT_CHARACTERS,
        )
        const key = `${chunkId}\0${sourceId ?? 'front'}`
        if (citationKeys.has(key)) throw new Error(`items[${itemIndex}].citations contain duplicates`)
        citationKeys.add(key)
        return { chunkId, documentId, sourceId, sourceRevisionId, contentHash, excerpt }
      })
      return { question, answer, category, citations }
    })
    const gaps = input.gaps.map((gap, index) => {
      const topic = validateBoundedText(gap.topic, `gaps[${index}].topic`, 1_000)
      if (
        gap.reason !== 'NO_RELEVANT_EVIDENCE' && gap.reason !== 'INSUFFICIENT_DETAIL' &&
        gap.reason !== 'CONFLICTING_SOURCES' && gap.reason !== 'UNSUPPORTED_OR_UNCONVERTED_SOURCE' &&
        gap.reason !== 'DUPLICATE_COVERAGE_ONLY' && gap.reason !== 'STALE_SOURCE'
      ) throw new Error(`gaps[${index}].reason is invalid`)
      const missingCount = validateSafePositiveInteger(gap.missingCount, `gaps[${index}].missingCount`)
      const suggestedMaterial = validateBoundedText(
        gap.suggestedMaterial,
        `gaps[${index}].suggestedMaterial`,
        2_000,
      )
      const checkedSourceCount = validateNonNegativeInteger(
        gap.checkedSourceCount,
        `gaps[${index}].checkedSourceCount`,
      )
      return { topic, reason: gap.reason, missingCount, suggestedMaterial, checkedSourceCount }
    })
    const gapCount = gaps.reduce((sum, gap) => sum + gap.missingCount, 0)
    if (!Number.isSafeInteger(gapCount) || items.length + gapCount !== plannedCount) {
      throw new Error('Simulation batch reliable items and evidence gaps must exactly account for plannedCount')
    }
    const normalizedPayload = { projectId, jobId, plannedCount, items, gaps }
    const contentFingerprint = sha256(JSON.stringify(normalizedPayload))
    return this.#write(() => {
      const checkpoint = this.#getSimulationCheckpoint(operationId)
      if (checkpoint) {
        if (
          checkpoint.kind !== 'batch' || checkpoint.job_id !== jobId ||
          checkpoint.content_fingerprint !== contentFingerprint
        ) throw new Error('Simulation operation ID already exists with conflicting content')
        return this.#loadSimulationBatchResult(projectId, jobId, operationId, false)
      }
      const job = this.#requireSimulationJob(projectId, jobId)
      if (
        job.status !== 'running' || job.generation !== expectedGeneration ||
        job.dataRevision !== expectedDataRevision
      ) throw new Error('SIMULATION_CAS_MISMATCH')
      this.#assertSimulationJobFence(job)
      if (job.reliableCount + job.gapCount + plannedCount > job.targetCount) {
        throw new Error('Simulation batch would exceed the requested target')
      }
      if (gaps.some((gap) => gap.checkedSourceCount > job.sourceCount)) {
        throw new Error('Simulation gap checkedSourceCount exceeds the frozen source count')
      }
      const citationTitles = items.map((item) =>
        item.citations.map((citation) => this.#assertSimulationCitation(projectId, citation)))
      const existingItemCount = job.reliableCount
      const existingGapRow = this.#database
        .prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM simulation_gaps WHERE job_id = ?')
        .get(jobId) as { ordinal: number }
      const nextRevision = job.dataRevision + 1
      this.#insertSimulationCheckpoint(operationId, jobId, 'batch', contentFingerprint, nextRevision, now)
      const batchId = stableId('simulation_batch', operationId)
      this.#database
        .prepare(
          `INSERT INTO simulation_batches(
             batch_id, job_id, operation_id, ordinal, planned_count, reliable_count,
             gap_count, content_fingerprint, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          batchId,
          jobId,
          operationId,
          job.nextBatchOrdinal,
          plannedCount,
          items.length,
          gapCount,
          contentFingerprint,
          now,
        )
      const insertItem = this.#database.prepare(
        `INSERT INTO simulation_items(
           item_id, job_id, batch_id, ordinal, question, answer, category,
           review_state, content_fingerprint, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      const insertCitation = this.#database.prepare(
        `INSERT INTO simulation_citations(
           citation_id, item_id, ordinal, chunk_id, document_id, title, source_id,
           source_revision_id, content_hash, excerpt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const [index, item] of items.entries()) {
        const itemCitationTitles = citationTitles[index]
        if (!itemCitationTitles) throw new Error('Simulation citation titles are missing')
        const itemFingerprint = simulationItemContentFingerprint(
          item.question,
          item.answer,
          item.category,
          item.citations,
        )
        const itemId = stableId('simulation_item', `${operationId}:${index}:${itemFingerprint}`)
        insertItem.run(
          itemId,
          jobId,
          batchId,
          existingItemCount + index,
          item.question,
          item.answer,
          item.category,
          itemFingerprint,
          now,
        )
        for (const [citationIndex, citation] of item.citations.entries()) {
          const citationTitle = itemCitationTitles[citationIndex]
          if (!citationTitle) throw new Error('Simulation citation title is missing')
          insertCitation.run(
            stableId('simulation_citation', `${itemId}:${citationIndex}:${citation.chunkId}:${citation.sourceId ?? 'front'}`),
            itemId,
            citationIndex,
            citation.chunkId,
            citation.documentId,
            citationTitle,
            citation.sourceId,
            citation.sourceRevisionId,
            citation.contentHash,
            citation.excerpt,
          )
        }
      }
      const insertGap = this.#database.prepare(
        `INSERT INTO simulation_gaps(
           gap_id, job_id, batch_id, ordinal, topic, reason, missing_count,
           suggested_material, checked_source_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const [index, gap] of gaps.entries()) {
        insertGap.run(
          stableId('simulation_gap', `${operationId}:${index}:${gap.reason}:${sha256(gap.topic)}`),
          jobId,
          batchId,
          existingGapRow.ordinal + index,
          gap.topic,
          gap.reason,
          gap.missingCount,
          gap.suggestedMaterial,
          gap.checkedSourceCount,
          now,
        )
      }
      this.#database
        .prepare(
          `UPDATE simulation_jobs SET reliable_count = reliable_count + ?, gap_count = gap_count + ?,
             next_batch_ordinal = next_batch_ordinal + 1, data_revision = ?, updated_at = ?
           WHERE job_id = ?`,
        )
        .run(items.length, gapCount, nextRevision, now, jobId)
      this.#bumpSimulationProjectRevision(projectId)
      return this.#loadSimulationBatchResult(projectId, jobId, operationId, true)
    })
  }

  getSimulationItemPage(input: SimulationResultPageInput): SimulationItemPage {
    this.#assertOpen()
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const jobId = validateIdentifier(input.jobId, 'jobId')
    const job = this.#requireSimulationJob(projectId, jobId)
    const limit = Math.max(1, Math.min(MAX_SIMULATION_PAGE_SIZE, input.limit ?? MAX_SIMULATION_PAGE_SIZE))
    if (
      input.expectedDataRevision !== undefined &&
      validateNonNegativeInteger(input.expectedDataRevision, 'expectedDataRevision') !== job.dataRevision
    ) throw new Error('SIMULATION_CURSOR_STALE')
    const scope = `items:${projectId}:${jobId}`
    const cursor = input.cursor ? decodeSimulationCursor(input.cursor) : null
    if (
      cursor &&
      (!cursor.scopeDigest.equals(simulationScopeDigest(scope)) || cursor.dataRevision !== job.dataRevision)
    ) throw new Error('SIMULATION_CURSOR_STALE')
    const rows = cursor
      ? this.#database
          .prepare(
            `SELECT rowid AS cursor_rowid, * FROM simulation_items
             WHERE job_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
          )
          .all(jobId, cursor.rowid, limit + 1) as SqlSimulationItemPageRow[]
      : this.#database
          .prepare(
            `SELECT rowid AS cursor_rowid, * FROM simulation_items
             WHERE job_id = ? ORDER BY rowid LIMIT ?`,
          )
          .all(jobId, limit + 1) as SqlSimulationItemPageRow[]
    const pageRows = rows.slice(0, limit)
    return {
      projectId,
      jobId,
      items: pageRows.map((row) => this.#hydrateSimulationItem(row)),
      nextCursor: rows.length > limit
        ? encodeSimulationCursor((pageRows.at(-1) as SqlSimulationItemPageRow).cursor_rowid, scope, job.dataRevision)
        : null,
      dataRevision: job.dataRevision,
    }
  }

  getSimulationGapPage(input: SimulationResultPageInput): SimulationGapPage {
    this.#assertOpen()
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const jobId = validateIdentifier(input.jobId, 'jobId')
    const job = this.#requireSimulationJob(projectId, jobId)
    const limit = Math.max(1, Math.min(MAX_SIMULATION_PAGE_SIZE, input.limit ?? MAX_SIMULATION_PAGE_SIZE))
    if (
      input.expectedDataRevision !== undefined &&
      validateNonNegativeInteger(input.expectedDataRevision, 'expectedDataRevision') !== job.dataRevision
    ) throw new Error('SIMULATION_CURSOR_STALE')
    const scope = `gaps:${projectId}:${jobId}`
    const cursor = input.cursor ? decodeSimulationCursor(input.cursor) : null
    if (
      cursor &&
      (!cursor.scopeDigest.equals(simulationScopeDigest(scope)) || cursor.dataRevision !== job.dataRevision)
    ) throw new Error('SIMULATION_CURSOR_STALE')
    const rows = cursor
      ? this.#database
          .prepare(
            `SELECT rowid AS cursor_rowid, * FROM simulation_gaps
             WHERE job_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
          )
          .all(jobId, cursor.rowid, limit + 1) as SqlSimulationGapPageRow[]
      : this.#database
          .prepare(
            `SELECT rowid AS cursor_rowid, * FROM simulation_gaps
             WHERE job_id = ? ORDER BY rowid LIMIT ?`,
          )
          .all(jobId, limit + 1) as SqlSimulationGapPageRow[]
    const pageRows = rows.slice(0, limit)
    return {
      projectId,
      jobId,
      items: pageRows.map(simulationGapFromRow),
      nextCursor: rows.length > limit
        ? encodeSimulationCursor((pageRows.at(-1) as SqlSimulationGapPageRow).cursor_rowid, scope, job.dataRevision)
        : null,
      dataRevision: job.dataRevision,
    }
  }

  updateSimulationItem(
    input: UpdateSimulationItemInput,
    now = Date.now(),
  ): UpdateSimulationItemResult {
    const operationId = validateIdentifier(input.operationId, 'operationId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const jobId = validateIdentifier(input.jobId, 'jobId')
    const itemId = validateIdentifier(input.itemId, 'itemId')
    const expectedDataRevision = validateNonNegativeInteger(input.expectedDataRevision, 'expectedDataRevision')
    const question = validateBoundedText(input.question, 'question', 4_000)
    const answer = validateBoundedText(input.answer, 'answer', MAX_QA_ANSWER_CHARACTERS)
    const operationFingerprint = sha256(JSON.stringify({ projectId, jobId, itemId, question, answer }))
    return this.#write(() => {
      const checkpoint = this.#getSimulationCheckpoint(operationId)
      if (checkpoint) {
        if (
          checkpoint.kind !== 'item_update' || checkpoint.job_id !== jobId ||
          checkpoint.content_fingerprint !== operationFingerprint
        ) throw new Error('Simulation operation ID already exists with conflicting content')
        return {
          job: this.#requireSimulationJob(projectId, jobId),
          item: this.#requireSimulationItem(jobId, itemId),
          inserted: false,
        }
      }
      const job = this.#requireSimulationJob(projectId, jobId)
      if (job.dataRevision !== expectedDataRevision) throw new Error('SIMULATION_CAS_MISMATCH')
      if (job.status !== 'completed' && job.status !== 'completed_with_gaps') {
        throw new Error('Simulation items may only be edited after generation completes')
      }
      const item = this.#requireSimulationItem(jobId, itemId)
      if (item.reviewState !== 'draft' && item.reviewState !== 'approved' && item.reviewState !== 'rejected') {
        throw new Error('A publishing, published, or stale simulation item cannot be edited')
      }
      this.#assertSimulationJobFence(job)
      const contentFingerprint = simulationItemContentFingerprint(
        question,
        answer,
        item.category,
        item.citations,
      )
      const nextRevision = job.dataRevision + 1
      this.#database
        .prepare(
          `UPDATE simulation_items SET question = ?, answer = ?, review_state = 'draft',
             content_fingerprint = ?, edited_at = ?, reviewed_at = NULL
           WHERE item_id = ?`,
        )
        .run(question, answer, contentFingerprint, now, itemId)
      const approved = this.#database
        .prepare("SELECT COUNT(*) AS count FROM simulation_items WHERE job_id = ? AND review_state = 'approved'")
        .get(jobId) as { count: number }
      this.#database
        .prepare('UPDATE simulation_jobs SET approved_count = ?, data_revision = ?, updated_at = ? WHERE job_id = ?')
        .run(approved.count, nextRevision, now, jobId)
      this.#insertSimulationCheckpoint(operationId, jobId, 'item_update', operationFingerprint, nextRevision, now)
      this.#bumpSimulationProjectRevision(projectId)
      return {
        job: this.#requireSimulationJob(projectId, jobId),
        item: this.#requireSimulationItem(jobId, itemId),
        inserted: true,
      }
    })
  }

  reviewSimulationItems(
    input: ReviewSimulationItemsInput,
    now = Date.now(),
  ): {
    readonly job: SimulationJobRecord
    readonly items: readonly SimulationItemRecord[]
    readonly inserted: boolean
  } {
    const operationId = validateIdentifier(input.operationId, 'operationId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const jobId = validateIdentifier(input.jobId, 'jobId')
    const expectedDataRevision = validateNonNegativeInteger(input.expectedDataRevision, 'expectedDataRevision')
    if (input.decisions.length < 1 || input.decisions.length > MAX_SIMULATION_PUBLICATION_ITEMS) {
      throw new Error(`Simulation review must contain between 1 and ${MAX_SIMULATION_PUBLICATION_ITEMS} decisions`)
    }
    const seen = new Set<string>()
    const decisions = input.decisions.map((decision, index) => {
      const itemId = validateIdentifier(decision.itemId, `decisions[${index}].itemId`)
      if (seen.has(itemId)) throw new Error('Simulation review contains duplicate item IDs')
      seen.add(itemId)
      if (decision.decision !== 'approved' && decision.decision !== 'rejected') {
        throw new Error(`decisions[${index}].decision is invalid`)
      }
      return { itemId, decision: decision.decision }
    })
    const fingerprint = sha256(JSON.stringify({ projectId, jobId, decisions }))
    return this.#write(() => {
      const checkpoint = this.#getSimulationCheckpoint(operationId)
      if (checkpoint) {
        if (
          checkpoint.kind !== 'review' || checkpoint.job_id !== jobId ||
          checkpoint.content_fingerprint !== fingerprint
        ) throw new Error('Simulation operation ID already exists with conflicting content')
        const replayJob = this.#requireSimulationJob(projectId, jobId)
        return {
          job: replayJob,
          items: decisions.map((decision) => this.#requireSimulationItem(jobId, decision.itemId)),
          inserted: false,
        }
      }
      const job = this.#requireSimulationJob(projectId, jobId)
      if (job.dataRevision !== expectedDataRevision) throw new Error('SIMULATION_CAS_MISMATCH')
      if (job.status !== 'completed' && job.status !== 'completed_with_gaps') {
        throw new Error('Simulation items may only be reviewed after generation completes')
      }
      this.#assertSimulationJobFence(job)
      const rows = decisions.map((decision) => {
        const row = this.#database
          .prepare('SELECT * FROM simulation_items WHERE job_id = ? AND item_id = ?')
          .get(jobId, decision.itemId) as SqlSimulationItemRow | undefined
        if (!row) throw new Error('Simulation review item does not belong to the job')
        if (row.review_state === 'publishing' || row.review_state === 'published' || row.review_state === 'stale') {
          throw new Error('A publishing, published, or stale simulation item cannot be reviewed')
        }
        return { decision, row }
      })
      const update = this.#database.prepare(
        'UPDATE simulation_items SET review_state = ?, reviewed_at = ? WHERE item_id = ?',
      )
      for (const { decision } of rows) update.run(decision.decision, now, decision.itemId)
      const approved = this.#database
        .prepare("SELECT COUNT(*) AS count FROM simulation_items WHERE job_id = ? AND review_state = 'approved'")
        .get(jobId) as { count: number }
      const nextRevision = job.dataRevision + 1
      this.#database
        .prepare('UPDATE simulation_jobs SET approved_count = ?, data_revision = ?, updated_at = ? WHERE job_id = ?')
        .run(approved.count, nextRevision, now, jobId)
      this.#insertSimulationCheckpoint(operationId, jobId, 'review', fingerprint, nextRevision, now)
      this.#bumpSimulationProjectRevision(projectId)
      return {
        job: this.#requireSimulationJob(projectId, jobId),
        items: decisions.map((decision) => this.#requireSimulationItem(jobId, decision.itemId)),
        inserted: true,
      }
    })
  }

  prepareSimulationPublication(
    input: PrepareSimulationPublicationInput,
    now = Date.now(),
  ): SimulationPublicationDraftBundle {
    const operationId = validateIdentifier(input.operationId, 'operationId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const jobId = validateIdentifier(input.jobId, 'jobId')
    const expectedDataRevision = validateNonNegativeInteger(input.expectedDataRevision, 'expectedDataRevision')
    if (input.itemIds.length < 1 || input.itemIds.length > MAX_SIMULATION_PUBLICATION_ITEMS) {
      throw new Error(`A simulation publication must contain between 1 and ${MAX_SIMULATION_PUBLICATION_ITEMS} items`)
    }
    const itemIds = input.itemIds.map((itemId, index) => validateIdentifier(itemId, `itemIds[${index}]`))
    if (new Set(itemIds).size !== itemIds.length) throw new Error('Simulation publication item IDs must be unique')
    const fingerprint = sha256(JSON.stringify({ projectId, jobId, itemIds }))
    return this.#write(() => {
      const checkpoint = this.#getSimulationCheckpoint(operationId)
      if (checkpoint) {
        if (
          checkpoint.kind !== 'publication_prepare' || checkpoint.job_id !== jobId ||
          checkpoint.content_fingerprint !== fingerprint
        ) throw new Error('Simulation operation ID already exists with conflicting content')
        const row = this.#database
          .prepare('SELECT * FROM simulation_publications WHERE operation_id = ?')
          .get(operationId) as SqlSimulationPublicationRow | undefined
        if (!row) throw new Error('Simulation publication checkpoint is inconsistent')
        return this.#loadSimulationPublicationDraftBundle(projectId, jobId, row.publication_id, false)
      }
      const job = this.#requireSimulationJob(projectId, jobId)
      if (job.dataRevision !== expectedDataRevision) throw new Error('SIMULATION_CAS_MISMATCH')
      if (job.status !== 'completed' && job.status !== 'completed_with_gaps') {
        throw new Error('Only a completed simulation job may be published')
      }
      this.#assertSimulationJobFence(job)
      const items = itemIds.map((itemId) => {
        const item = this.#requireSimulationItem(jobId, itemId)
        if (item.reviewState !== 'approved') throw new Error('Only approved simulation items may be published')
        return item
      })
      const duplicateQuestions = new Set<string>()
      for (const item of items) {
        const normalizedQuestion = normalizeQuestion(item.question)
        if (duplicateQuestions.has(normalizedQuestion)) {
          throw new Error('Simulation publication contains duplicate normalized questions')
        }
        duplicateQuestions.add(normalizedQuestion)
      }
      const nextRevision = job.dataRevision + 1
      this.#insertSimulationCheckpoint(operationId, jobId, 'publication_prepare', fingerprint, nextRevision, now)
      const publicationId = stableId('simulation_publication', operationId)
      this.#database
        .prepare(
          `INSERT INTO simulation_publications(
             publication_id, job_id, operation_id, status, content_fingerprint,
             created_at, updated_at, completed_at
           ) VALUES (?, ?, ?, 'prepared', ?, ?, ?, NULL)`,
        )
        .run(publicationId, jobId, operationId, fingerprint, now, now)
      const insertLink = this.#database.prepare(
        `INSERT INTO simulation_publication_items(publication_id, item_id, ordinal, preset_qa_id)
         VALUES (?, ?, ?, NULL)`,
      )
      const markPublishing = this.#database.prepare(
        "UPDATE simulation_items SET review_state = 'publishing' WHERE item_id = ?",
      )
      for (const [index, itemId] of itemIds.entries()) {
        insertLink.run(publicationId, itemId, index)
        markPublishing.run(itemId)
      }
      this.#database
        .prepare('UPDATE simulation_jobs SET data_revision = ?, updated_at = ? WHERE job_id = ?')
        .run(nextRevision, now, jobId)
      this.#bumpSimulationProjectRevision(projectId)
      return this.#loadSimulationPublicationDraftBundle(projectId, jobId, publicationId, true)
    })
  }

  completeSimulationPublication(
    input: CompleteSimulationPublicationInput,
    now = Date.now(),
  ): SimulationPublicationBundle {
    const operationId = validateIdentifier(input.operationId, 'operationId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const jobId = validateIdentifier(input.jobId, 'jobId')
    const publicationId = validateIdentifier(input.publicationId, 'publicationId')
    const expectedDataRevision = validateNonNegativeInteger(input.expectedDataRevision, 'expectedDataRevision')
    if (input.mappings.length < 1 || input.mappings.length > MAX_SIMULATION_PUBLICATION_ITEMS) {
      throw new Error('Simulation publication mappings are invalid')
    }
    const mappings = input.mappings.map((mapping, index) => ({
      itemId: validateIdentifier(mapping.itemId, `mappings[${index}].itemId`),
      presetQaId: validateIdentifier(mapping.presetQaId, `mappings[${index}].presetQaId`),
    }))
    if (
      new Set(mappings.map((mapping) => mapping.itemId)).size !== mappings.length ||
      new Set(mappings.map((mapping) => mapping.presetQaId)).size !== mappings.length
    ) throw new Error('Simulation publication mappings must be one-to-one')
    const fingerprint = sha256(JSON.stringify({ projectId, jobId, publicationId, mappings }))
    return this.#write(() => {
      const checkpoint = this.#getSimulationCheckpoint(operationId)
      if (checkpoint) {
        if (
          checkpoint.kind !== 'publication_complete' || checkpoint.job_id !== jobId ||
          checkpoint.content_fingerprint !== fingerprint
        ) throw new Error('Simulation operation ID already exists with conflicting content')
        return this.#loadSimulationPublicationBundle(projectId, jobId, publicationId, false)
      }
      const job = this.#requireSimulationJob(projectId, jobId)
      if (job.dataRevision !== expectedDataRevision) throw new Error('SIMULATION_CAS_MISMATCH')
      // The strict project QA artifact commit immediately preceding this call
      // intentionally increments knowledgeVersion/dataRevision. Document
      // evidence must remain byte-for-byte frozen, but that expected QA-only
      // mutation must not make publication completion impossible.
      const completionFence = this.getProjectSimulationFence(projectId)
      if (
        completionFence.knowledgeVersion < job.knowledgeVersion ||
        completionFence.sourceManifestHash !== job.sourceManifestHash ||
        completionFence.sourceCount !== job.sourceCount
      ) throw new Error('SIMULATION_KNOWLEDGE_STALE')
      const publication = this.#requireSimulationPublication(jobId, publicationId)
      if (publication.status !== 'prepared') throw new Error('Simulation publication is not prepared')
      const links = this.#listSimulationPublicationItemRows(publicationId)
      if (
        links.length !== mappings.length ||
        links.some((link, index) => link.item_id !== mappings[index]?.itemId)
      ) throw new Error('Simulation publication mappings do not match its prepared items')
      for (const mapping of mappings) {
        const item = this.#requireSimulationItem(jobId, mapping.itemId)
        if (item.reviewState !== 'publishing') throw new Error('Simulation item is not reserved for publication')
        const preset = this.#database
          .prepare(
            `SELECT q.* FROM preset_qa q JOIN project_qa_links l ON l.preset_qa_id = q.id
             JOIN source_files s ON s.source_id = l.source_id
             JOIN conversion_artifacts a ON a.artifact_id = l.artifact_id
             WHERE q.id = ? AND l.active = 1 AND s.project_id = ?
               AND s.active_revision_id = a.revision_id LIMIT 1`,
          )
          .get(mapping.presetQaId, projectId) as SqlPresetQaRow | undefined
        if (
          !preset || preset.question !== item.question || preset.answer !== item.answer
        ) throw new Error('Published preset QA does not match the reviewed simulation item')
      }
      const nextRevision = job.dataRevision + 1
      this.#insertSimulationCheckpoint(operationId, jobId, 'publication_complete', fingerprint, nextRevision, now)
      const linkPreset = this.#database.prepare(
        'UPDATE simulation_publication_items SET preset_qa_id = ? WHERE publication_id = ? AND item_id = ?',
      )
      const markPublished = this.#database.prepare(
        "UPDATE simulation_items SET review_state = 'published', published_at = ? WHERE item_id = ?",
      )
      for (const mapping of mappings) {
        linkPreset.run(mapping.presetQaId, publicationId, mapping.itemId)
        markPublished.run(now, mapping.itemId)
      }
      this.#database
        .prepare("UPDATE simulation_publications SET status = 'completed', updated_at = ?, completed_at = ? WHERE publication_id = ?")
        .run(now, now, publicationId)
      const publishedCount = this.#database
        .prepare("SELECT COUNT(*) AS count FROM simulation_items WHERE job_id = ? AND review_state = 'published'")
        .get(jobId) as { count: number }
      this.#database
        .prepare('UPDATE simulation_jobs SET published_count = ?, data_revision = ?, updated_at = ? WHERE job_id = ?')
        .run(publishedCount.count, nextRevision, now, jobId)
      this.#bumpSimulationProjectRevision(projectId)
      return this.#loadSimulationPublicationBundle(projectId, jobId, publicationId, true)
    })
  }

  resolveSimulationPublicationMappings(
    input: ResolveSimulationPublicationMappingsInput,
  ): readonly SimulationPublicationMapping[] {
    this.#assertOpen()
    const projectId = validateIdentifier(input.projectId, 'projectId')
    this.#requireProject(projectId)
    if (input.items.length < 1 || input.items.length > MAX_SIMULATION_PUBLICATION_ITEMS) {
      throw new Error('Simulation publication mapping candidates are invalid')
    }
    const seen = new Set<string>()
    const items = input.items.map((item, index) => {
      const itemId = validateIdentifier(item.itemId, `items[${index}].itemId`)
      if (seen.has(itemId)) throw new Error('Simulation publication mapping candidates contain duplicate item IDs')
      seen.add(itemId)
      return {
        itemId,
        question: validateBoundedText(item.question, `items[${index}].question`, 4_000),
        answer: validateBoundedText(item.answer, `items[${index}].answer`, MAX_QA_ANSWER_CHARACTERS),
      }
    })
    const read = this.#database.transaction((): readonly SimulationPublicationMapping[] => {
      const result: SimulationPublicationMapping[] = []
      for (const item of items) {
        const stored = this.#database
          .prepare(
            `SELECT i.question, i.answer, i.review_state
             FROM simulation_items i JOIN simulation_jobs j ON j.job_id = i.job_id
             WHERE i.item_id = ? AND j.project_id = ?`,
          )
          .get(item.itemId, projectId) as {
            question: string
            answer: string
            review_state: SimulationItemRecord['reviewState']
          } | undefined
        if (
          !stored || stored.review_state !== 'publishing' ||
          stored.question !== item.question || stored.answer !== item.answer
        ) throw new Error('Simulation publication item does not match its reserved project draft')
        const rows = this.#database
          .prepare(
            `SELECT DISTINCT q.id FROM preset_qa q
             JOIN project_qa_links l ON l.preset_qa_id = q.id
             JOIN source_files s ON s.source_id = l.source_id
             JOIN conversion_artifacts a ON a.artifact_id = l.artifact_id
             WHERE s.project_id = ? AND l.active = 1
               AND s.active_revision_id = a.revision_id
               AND q.question = ? AND q.answer = ?
             ORDER BY q.id LIMIT 2`,
          )
          .all(projectId, item.question, item.answer) as Array<{ id: string }>
        if (rows.length !== 1) {
          throw new Error(rows.length === 0
            ? 'Published project preset QA does not exactly match the simulation item'
            : 'Published project preset QA mapping is ambiguous')
        }
        result.push({ itemId: item.itemId, presetQaId: rows[0]?.id as string })
      }
      return result
    })
    return read.deferred()
  }

  cancelSimulationPublication(
    input: CancelSimulationPublicationInput,
    now = Date.now(),
  ): SimulationPublicationBundle {
    const operationId = validateIdentifier(input.operationId, 'operationId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const jobId = validateIdentifier(input.jobId, 'jobId')
    const publicationId = validateIdentifier(input.publicationId, 'publicationId')
    const expectedDataRevision = validateNonNegativeInteger(input.expectedDataRevision, 'expectedDataRevision')
    const fingerprint = sha256(JSON.stringify({ projectId, jobId, publicationId }))
    return this.#write(() => {
      const checkpoint = this.#getSimulationCheckpoint(operationId)
      if (checkpoint) {
        if (
          checkpoint.kind !== 'publication_cancel' || checkpoint.job_id !== jobId ||
          checkpoint.content_fingerprint !== fingerprint
        ) throw new Error('Simulation operation ID already exists with conflicting content')
        return this.#loadSimulationPublicationBundle(projectId, jobId, publicationId, false)
      }
      const job = this.#requireSimulationJob(projectId, jobId)
      if (job.dataRevision !== expectedDataRevision) throw new Error('SIMULATION_CAS_MISMATCH')
      const publication = this.#requireSimulationPublication(jobId, publicationId)
      if (publication.status !== 'prepared') throw new Error('Only a prepared simulation publication may be cancelled')
      const links = this.#listSimulationPublicationItemRows(publicationId)
      this.#database
        .prepare(
          `UPDATE simulation_items SET review_state = 'approved'
           WHERE item_id = ? AND review_state = 'publishing'`,
        )
      const release = this.#database.prepare(
        "UPDATE simulation_items SET review_state = 'approved' WHERE item_id = ? AND review_state = 'publishing'",
      )
      for (const link of links) release.run(link.item_id)
      const nextRevision = job.dataRevision + 1
      this.#insertSimulationCheckpoint(operationId, jobId, 'publication_cancel', fingerprint, nextRevision, now)
      this.#database
        .prepare("UPDATE simulation_publications SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE publication_id = ?")
        .run(now, now, publicationId)
      this.#database
        .prepare('UPDATE simulation_jobs SET data_revision = ?, updated_at = ? WHERE job_id = ?')
        .run(nextRevision, now, jobId)
      this.#bumpSimulationProjectRevision(projectId)
      return this.#loadSimulationPublicationBundle(projectId, jobId, publicationId, true)
    })
  }

  recoverInterruptedSimulationJobs(now = Date.now()): readonly SimulationJobRecord[] {
    return this.#write(() => {
      const rows = this.#database
        .prepare("SELECT * FROM simulation_jobs WHERE status = 'running' ORDER BY created_at, job_id")
        .all() as SqlSimulationJobRow[]
      const recovered: SimulationJobRecord[] = []
      for (const row of rows) {
        const operationId = stableId('simulation_recovery', `${row.job_id}:${row.generation}:${row.data_revision}`)
        const fingerprint = sha256(JSON.stringify({ jobId: row.job_id, generation: row.generation, status: 'paused' }))
        const nextRevision = row.data_revision + 1
        this.#database
          .prepare(
            `UPDATE simulation_jobs SET status = 'paused', data_revision = ?, error_code = 'GENERATION_INTERRUPTED',
               updated_at = ? WHERE job_id = ? AND status = 'running'`,
          )
          .run(nextRevision, now, row.job_id)
        this.#insertSimulationCheckpoint(operationId, row.job_id, 'recovery', fingerprint, nextRevision, now)
        this.#bumpSimulationProjectRevision(row.project_id)
        recovered.push(this.#requireSimulationJob(row.project_id, row.job_id))
      }
      return recovered
    })
  }

  prepareConversionJob(input: PrepareConversionJobInput, now = Date.now()): ConversionJobRecord {
    const operationId = validateIdentifier(input.operationId, 'operationId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const sourceId = validateIdentifier(input.sourceId, 'sourceId')
    const revisionId = validateIdentifier(input.revisionId, 'revisionId')
    const generation = validateSafePositiveInteger(input.generation, 'generation')
    const inputSha256 = validateSha256(input.inputSha256, 'inputSha256')
    const tempRelativePath = validateRelativeProjectPath(input.tempRelativePath, 'tempRelativePath')
    const finalRelativePath = validateRelativeProjectPath(input.finalRelativePath, 'finalRelativePath')
    const converterId = validateBoundedText(input.converterId, 'converterId', 128)
    const converterVersion = validateBoundedText(input.converterVersion, 'converterVersion', 128)
    const artifactSchemaVersion = validateSafePositiveInteger(input.artifactSchemaVersion, 'artifactSchemaVersion')
    const cacheKey = validateBoundedText(input.cacheKey, 'cacheKey', 512)
    return this.#write(() => {
      const existing = this.getConversionJob(operationId)
      if (existing) {
        const identical = existing.projectId === projectId && existing.sourceId === sourceId &&
          existing.revisionId === revisionId && existing.generation === generation &&
          existing.inputSha256 === inputSha256 && existing.tempRelativePath === tempRelativePath &&
          existing.finalRelativePath === finalRelativePath && existing.conversionMode === input.conversionMode &&
          existing.converterId === converterId && existing.converterVersion === converterVersion &&
          existing.artifactSchemaVersion === artifactSchemaVersion && existing.modelId === (input.modelId ?? null) &&
          existing.modelRevision === (input.modelRevision ?? null) &&
          existing.promptConfigHash === (input.promptConfigHash ?? null) && existing.cacheKey === cacheKey
        if (!identical) throw new Error('Conversion operation ID conflicts with different input')
        return existing
      }
      const project = this.#requireProject(projectId)
      const source = this.getProjectSource(sourceId)
      const revision = this.getProjectSourceRevision(revisionId)
      if (!source || !revision || source.projectId !== projectId || revision.sourceId !== sourceId) {
        throw new Error('Conversion job source revision does not belong to its project')
      }
      const outputPrefix = source.trustKind === 'document' ? '转换资料库/资料/' : '转换资料库/预设QA/'
      if (!finalRelativePath.startsWith(outputPrefix) || !tempRelativePath.startsWith(outputPrefix)) {
        throw new Error('Conversion output path violates the fixed converted-library boundary')
      }
      if (project.scanGeneration !== generation || revision.generation !== generation || revision.rawSha256 !== inputSha256) {
        throw new Error('Conversion job belongs to a stale or mismatched generation')
      }
      this.#database
        .prepare(
          `INSERT INTO conversion_jobs(
            operation_id, project_id, source_id, revision_id, generation, state, input_sha256,
            temp_relative_path, final_relative_path, conversion_mode, converter_id, converter_version,
            artifact_schema_version, model_id, model_revision, prompt_config_hash, cache_key,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operationId, projectId, sourceId, revisionId, generation, inputSha256, tempRelativePath,
          finalRelativePath, input.conversionMode, converterId, converterVersion, artifactSchemaVersion,
          input.modelId ?? null, input.modelRevision ?? null, input.promptConfigHash ?? null, cacheKey, now, now,
        )
      this.#database
        .prepare(
          `UPDATE source_revisions SET state = 'prepared', conversion_mode = ?, converter_id = ?,
             converter_version = ?, artifact_schema_version = ?, model_id = ?, model_revision = ?,
             prompt_config_hash = ?, cache_key = ?, error_code = NULL WHERE revision_id = ?`,
        )
        .run(
          input.conversionMode, converterId, converterVersion, artifactSchemaVersion,
          input.modelId ?? null, input.modelRevision ?? null, input.promptConfigHash ?? null, cacheKey, revisionId,
        )
      this.#database
        .prepare("UPDATE source_files SET state = 'converting', error_code = NULL, updated_at = ? WHERE source_id = ?")
        .run(now, sourceId)
      this.#bumpProjectRevision(projectId, now)
      return this.getConversionJob(operationId) as ConversionJobRecord
    })
  }

  getConversionJob(operationId: string): ConversionJobRecord | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM conversion_jobs WHERE operation_id = ?').get(operationId) as
      | SqlConversionJobRow
      | undefined
    return row ? conversionJobFromRow(row) : null
  }

  getConversionArtifact(artifactId: string): ConversionArtifactRecord | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM conversion_artifacts WHERE artifact_id = ?').get(artifactId) as
      | SqlConversionArtifactRow
      | undefined
    return row ? conversionArtifactFromRow(row) : null
  }

  stageConversionArtifact(input: StageConversionArtifactInput, now = Date.now()): ConversionSagaResult {
    const operationId = validateIdentifier(input.operationId, 'operationId')
    const artifactId = validateIdentifier(input.artifactId, 'artifactId')
    const outputSha256 = validateSha256(input.outputSha256, 'outputSha256')
    const warnings = validateWarnings(input.warnings)
    return this.#write(() => {
      const job = this.getConversionJob(operationId)
      if (!job) throw new Error('Conversion job does not exist')
      if (job.state === 'staged' || job.state === 'published_fs' || job.state === 'committed') {
        const artifact = job.artifactId ? this.getConversionArtifact(job.artifactId) : null
        if (
          !artifact || artifact.artifactId !== artifactId || artifact.outputSha256 !== outputSha256 ||
          artifact.contentKind !== input.contentKind || JSON.stringify(artifact.warnings) !== JSON.stringify(warnings)
        ) throw new Error('Staged conversion artifact conflicts with the existing operation')
        return { job, artifact }
      }
      if (job.state !== 'prepared') throw new Error('Only a prepared conversion job may be staged')
      if (this.#requireProject(job.projectId).scanGeneration !== job.generation) {
        throw new Error('Stale conversion generation cannot stage an artifact')
      }
      const source = this.getProjectSource(job.sourceId)
      if (!source || source.trustKind !== input.contentKind) {
        throw new Error('Conversion artifact content kind violates the source trust boundary')
      }
      this.#database
        .prepare(
          `INSERT INTO conversion_artifacts(
            artifact_id, revision_id, relative_output_path, output_sha256, content_kind,
            warnings_json, validation_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?)`,
        )
        .run(artifactId, job.revisionId, job.finalRelativePath, outputSha256, input.contentKind, JSON.stringify(warnings), now, now)
      this.#database
        .prepare(
          `UPDATE conversion_jobs SET artifact_id = ?, output_sha256 = ?, state = 'staged',
             error_code = NULL, updated_at = ? WHERE operation_id = ?`,
        )
        .run(artifactId, outputSha256, now, operationId)
      this.#database.prepare("UPDATE source_revisions SET state = 'staged' WHERE revision_id = ?").run(job.revisionId)
      this.#database
        .prepare("UPDATE source_files SET state = 'artifact_staged', error_code = NULL, updated_at = ? WHERE source_id = ?")
        .run(now, job.sourceId)
      this.#bumpProjectRevision(job.projectId, now)
      return {
        job: this.getConversionJob(operationId) as ConversionJobRecord,
        artifact: this.getConversionArtifact(artifactId) as ConversionArtifactRecord,
      }
    })
  }

  markConversionPublished(operationId: string, outputSha256: string, now = Date.now()): ConversionSagaResult {
    validateIdentifier(operationId, 'operationId')
    const normalizedHash = validateSha256(outputSha256, 'outputSha256')
    return this.#write(() => {
      const job = this.getConversionJob(operationId)
      if (!job || !job.artifactId) throw new Error('Staged conversion job does not exist')
      if (job.outputSha256 !== normalizedHash) throw new Error('Published output hash does not match the staged artifact')
      if (job.state === 'published_fs' || job.state === 'committed') {
        return {
          job,
          artifact: this.getConversionArtifact(job.artifactId) as ConversionArtifactRecord,
        }
      }
      if (job.state !== 'staged') throw new Error('Only a staged conversion job may be published')
      this.#assertConversionInputStillCurrent(job)
      this.#database
        .prepare("UPDATE conversion_jobs SET state = 'published_fs', updated_at = ? WHERE operation_id = ?")
        .run(now, operationId)
      this.#database
        .prepare(
          `UPDATE conversion_artifacts SET validation_state = 'published_fs', published_at = ?, updated_at = ?
           WHERE artifact_id = ?`,
        )
        .run(now, now, job.artifactId)
      this.#database.prepare("UPDATE source_revisions SET state = 'published_fs' WHERE revision_id = ?").run(job.revisionId)
      this.#database
        .prepare("UPDATE source_files SET state = 'published_fs', updated_at = ? WHERE source_id = ?")
        .run(now, job.sourceId)
      this.#bumpProjectRevision(job.projectId, now)
      return {
        job: this.getConversionJob(operationId) as ConversionJobRecord,
        artifact: this.getConversionArtifact(job.artifactId) as ConversionArtifactRecord,
      }
    })
  }

  commitProjectDocumentArtifact(
    input: CommitProjectDocumentArtifactInput,
    now = Date.now(),
  ): { readonly job: ConversionJobRecord; readonly artifact: ConversionArtifactRecord; readonly document: DocumentRecord } {
    validateIdentifier(input.operationId, 'operationId')
    validateIdentifier(input.artifactId, 'artifactId')
    const outputSha256 = validateSha256(input.outputSha256, 'outputSha256')
    const canonicalBodySha256 = validateSha256(input.canonicalBodySha256, 'canonicalBodySha256')
    const normalizedContent = validateNonEmpty(input.document.content, 'document.content')
    if (sha256(normalizedContent) !== canonicalBodySha256) {
      throw new Error('Document body hash does not match its canonical content')
    }
    return this.#write(() => {
      const job = this.#requirePublishedConversion(input.operationId, input.artifactId, 'document')
      const artifact = this.getConversionArtifact(input.artifactId) as ConversionArtifactRecord
      this.#assertPublishedArtifactHashes(job, artifact, outputSha256, canonicalBodySha256)
      if (job.state !== 'committed') this.#assertProjectKnowledgeMutationAllowed(job.projectId)
      this.#setArtifactOutputMetadata(input.artifactId, input, now)
      this.#setArtifactCanonicalBodyHash(input.artifactId, canonicalBodySha256, now)
      if (job.state === 'committed') {
        const link = this.#database
          .prepare('SELECT document_id FROM project_document_links WHERE artifact_id = ? AND active = 1')
          .get(input.artifactId) as { document_id: string } | undefined
        if (!link) throw new Error('Committed document conversion is missing its active link')
        return {
          job,
          artifact: this.getConversionArtifact(input.artifactId) as ConversionArtifactRecord,
          document: this.getDocument(link.document_id) as DocumentRecord,
        }
      }
      const preexistingLegacy = this.#database
        .prepare(
          `SELECT 1 FROM documents d JOIN legacy_document_entries l ON l.document_id = d.id
           WHERE d.content_hash = ? LIMIT 1`,
        )
        .get(canonicalBodySha256)
      const result = this.upsertDocument({
        title: input.document.title,
        kind: input.document.kind,
        content: input.document.content,
        chunks: input.document.chunks,
      }, now)
      if (!preexistingLegacy) {
        this.#database.prepare('DELETE FROM legacy_document_entries WHERE document_id = ?').run(result.document.id)
      }
      this.#database.prepare('UPDATE project_document_links SET active = 0 WHERE source_id = ?').run(job.sourceId)
      this.#database
        .prepare(
          `INSERT INTO project_document_links(source_id, artifact_id, document_id, active, linked_at)
           VALUES (?, ?, ?, 1, ?)`,
        )
        .run(job.sourceId, input.artifactId, result.document.id, now)
      this.#completeProjectArtifact(job, input.artifactId, now)
      return {
        job: this.getConversionJob(input.operationId) as ConversionJobRecord,
        artifact: this.getConversionArtifact(input.artifactId) as ConversionArtifactRecord,
        document: result.document,
      }
    })
  }

  commitProjectQaArtifact(
    input: CommitProjectQaArtifactInput,
    now = Date.now(),
  ): { readonly job: ConversionJobRecord; readonly artifact: ConversionArtifactRecord; readonly items: readonly PresetQaRecord[] } {
    validateIdentifier(input.operationId, 'operationId')
    validateIdentifier(input.artifactId, 'artifactId')
    if (input.items.length === 0) throw new Error('Preset QA artifact must contain at least one item')
    const outputSha256 = validateSha256(input.outputSha256, 'outputSha256')
    const canonicalBodySha256 = validateSha256(input.canonicalBodySha256, 'canonicalBodySha256')
    const canonicalContent = normalizeContent(input.canonicalContent)
    if (sha256(canonicalContent) !== canonicalBodySha256) {
      throw new Error('Preset QA body hash does not match its canonical content')
    }
    return this.#write(() => {
      const job = this.#requirePublishedConversion(input.operationId, input.artifactId, 'preset_qa')
      const artifact = this.getConversionArtifact(input.artifactId) as ConversionArtifactRecord
      this.#assertPublishedArtifactHashes(job, artifact, outputSha256, canonicalBodySha256)
      if (job.state !== 'committed') this.#assertProjectKnowledgeMutationAllowed(job.projectId)
      this.#setArtifactOutputMetadata(input.artifactId, input, now)
      this.#setArtifactCanonicalBodyHash(input.artifactId, canonicalBodySha256, now)
      const prepared = input.items.map((item) => ({
        question: validateNonEmpty(item.question, 'question'),
        answer: validateNonEmpty(item.answer, 'answer'),
      }))
      const parsed = validateAndDedupeQa(parseStructuredQaDocument(canonicalContent, 'markdown').items)
      const normalizedPrepared = validateAndDedupeQa(prepared)
      if (
        parsed.length !== normalizedPrepared.length || parsed.some((item, index) => {
          const expected = normalizedPrepared[index]
          return !expected || normalizeQuestion(item.question) !== normalizeQuestion(expected.question) ||
            normalizeContent(item.answer) !== normalizeContent(expected.answer)
        })
      ) throw new Error('Preset QA items do not match the published canonical artifact')
      if (job.state === 'committed') {
        const rows = this.#database
          .prepare(
            `SELECT q.* FROM preset_qa q JOIN project_qa_links l ON l.preset_qa_id = q.id
             WHERE l.artifact_id = ? AND l.active = 1 ORDER BY q.id`,
          )
          .all(input.artifactId) as SqlPresetQaRow[]
        return {
          job,
          artifact: this.getConversionArtifact(input.artifactId) as ConversionArtifactRecord,
          items: rows.map(presetQaFromRow),
        }
      }
      this.#assertProjectQaCommitHasNoConflicts(job.projectId, job.sourceId, prepared)
      const results = prepared.map((item) => this.#upsertProjectPresetQaInsideTransaction(job.projectId, item, now))
      this.#database.prepare('UPDATE project_qa_links SET active = 0 WHERE source_id = ?').run(job.sourceId)
      const insertLink = this.#database.prepare(
        `INSERT INTO project_qa_links(source_id, artifact_id, preset_qa_id, active, linked_at)
         VALUES (?, ?, ?, 1, ?)`,
      )
      for (const result of results) insertLink.run(job.sourceId, input.artifactId, result.record.id, now)
      this.#completeProjectArtifact(job, input.artifactId, now)
      return {
        job: this.getConversionJob(input.operationId) as ConversionJobRecord,
        artifact: this.getConversionArtifact(input.artifactId) as ConversionArtifactRecord,
        items: results.map((result) => result.record),
      }
    })
  }

  commitManualProjectArtifact(
    input: CommitManualProjectArtifactInput,
    now = Date.now(),
  ): { readonly inserted: boolean; readonly source: ProjectSourceFileRecord } {
    const operationId = validateIdentifier(input.operationId, 'operationId')
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const runId = validateIdentifier(input.runId, 'runId')
    const generation = validateSafePositiveInteger(input.generation, 'generation')
    const displayRelativePath = validateRelativeProjectPath(input.displayRelativePath, 'displayRelativePath')
    const pathKey = validateRelativeProjectPath(input.pathKey, 'pathKey')
    const canonicalContent = normalizeContent(input.canonicalContent)
    const outputSha256 = validateSha256(input.outputSha256, 'outputSha256')
    const canonicalBodySha256 = validateSha256(input.canonicalBodySha256, 'canonicalBodySha256')
    if (sha256(canonicalContent) !== canonicalBodySha256) throw new Error('Manual artifact body hash mismatch')
    return this.#write(() => {
      const project = this.#requireProject(projectId)
      const run = this.getProjectSyncRun(runId)
      if (!run || run.projectId !== projectId || run.generation !== generation || project.scanGeneration !== generation) {
        throw new Error('Manual artifact belongs to a stale sync generation')
      }
      this.#assertProjectKnowledgeMutationAllowed(projectId)
      const existingJob = this.getConversionJob(operationId)
      if (existingJob?.state === 'committed') {
        const source = this.getProjectSource(existingJob.sourceId)
        const artifact = existingJob.artifactId ? this.getConversionArtifact(existingJob.artifactId) : null
        if (
          !source || !artifact || source.projectId !== projectId ||
          source.trustKind !== input.trustKind || source.pathKey !== pathKey ||
          existingJob.inputSha256 !== outputSha256 || existingJob.outputSha256 !== outputSha256 ||
          artifact.outputSha256 !== outputSha256 || artifact.canonicalBodySha256 !== canonicalBodySha256
        ) {
          throw new Error('Manual artifact operation conflicts with an existing commit')
        }
        const desiredState: ProjectSourceState = source.state === 'ready' ? 'ready' : 'embedding_pending'
        const sourceNeedsRepair = source.displayRelativePath !== displayRelativePath ||
          source.sizeBytes !== (input.outputSizeBytes ?? source.sizeBytes) ||
          source.mtimeNs !== (input.outputMtimeNs ?? source.mtimeNs) ||
          source.deviceId !== (input.outputDeviceId ?? source.deviceId) ||
          source.inode !== (input.outputInode ?? source.inode) ||
          source.observedRawSha256 !== outputSha256 || source.lastSeenGeneration !== generation ||
          source.state !== desiredState || source.errorCode !== null || source.missingSinceGeneration !== null ||
          source.tombstonedAt !== null
        this.#database
          .prepare(
          `UPDATE source_files SET display_relative_path = ?, size_bytes = ?, mtime_ns = ?, device_id = ?, inode = ?,
               observed_raw_sha256 = ?, state = ?, error_code = NULL,
               last_seen_generation = ?, missing_since_generation = NULL, tombstoned_at = NULL,
               updated_at = ?
             WHERE source_id = ?`,
          )
          .run(
            displayRelativePath, input.outputSizeBytes ?? source.sizeBytes, input.outputMtimeNs ?? source.mtimeNs,
            input.outputDeviceId ?? source.deviceId, input.outputInode ?? source.inode,
            outputSha256, desiredState, generation, now, source.sourceId,
          )
        const deactivateDocuments = this.#database
          .prepare('UPDATE project_document_links SET active = 0 WHERE source_id = ? AND artifact_id != ? AND active = 1')
          .run(source.sourceId, artifact.artifactId).changes
        const activateDocuments = this.#database
          .prepare('UPDATE project_document_links SET active = 1 WHERE source_id = ? AND artifact_id = ? AND active = 0')
          .run(source.sourceId, artifact.artifactId).changes
        const deactivateQa = this.#database
          .prepare('UPDATE project_qa_links SET active = 0 WHERE source_id = ? AND artifact_id != ? AND active = 1')
          .run(source.sourceId, artifact.artifactId).changes
        const activateQa = this.#database
          .prepare('UPDATE project_qa_links SET active = 1 WHERE source_id = ? AND artifact_id = ? AND active = 0')
          .run(source.sourceId, artifact.artifactId).changes
        const linkChanges = deactivateDocuments + activateDocuments + deactivateQa + activateQa
        if (linkChanges > 0) {
          this.#database
            .prepare(
              `UPDATE projects SET knowledge_version = knowledge_version + 1,
                 data_revision = data_revision + 1, updated_at = ? WHERE id = ?`,
            )
            .run(now, projectId)
          this.#bumpGlobalProjectRevision()
        } else if (sourceNeedsRepair) {
          this.#bumpProjectRevision(projectId, now)
        }
        this.reconcileProjectIndexState(projectId, now)
        return { inserted: false, source: this.getProjectSource(source.sourceId) as ProjectSourceFileRecord }
      }
      if (existingJob) throw new Error('Manual artifact operation is already in progress')
      const sourceId = projectSourceId(projectId, input.trustKind, pathKey)
      const source = this.getProjectSource(sourceId)
      if (source && source.projectId !== projectId) throw new Error('Manual artifact source conflicts with another project')
      if (!source) {
        this.#database
          .prepare(
            `INSERT INTO source_files(
              source_id, project_id, trust_kind, display_relative_path, path_key, size_bytes, mtime_ns,
              observed_raw_sha256, detected_type, conversion_disposition, last_seen_generation, state,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'markdown', 'local', ?, 'needs_conversion', ?, ?)`,
          )
          .run(
            sourceId, projectId, input.trustKind, displayRelativePath, pathKey,
            input.outputSizeBytes ?? Buffer.byteLength(canonicalContent), input.outputMtimeNs ?? String(now * 1_000_000),
            outputSha256, generation, now, now,
          )
      }
      const existingRevision = this.findProjectSourceRevision({ sourceId, generation, rawSha256: outputSha256 })
      const revisionId = existingRevision?.revisionId ?? this.#insertObservedRevision(
        sourceId, outputSha256, input.outputSizeBytes ?? Buffer.byteLength(canonicalContent), 'markdown', generation, now,
      )
      const artifactId = stableId('artifact', `${operationId}:${outputSha256}`)
      const finalRelativePath = displayRelativePath
      const tempRelativePath = `${displayRelativePath}.qaing-staging`
      this.#database
        .prepare(
          `INSERT INTO conversion_jobs(
            operation_id, project_id, source_id, revision_id, artifact_id, generation, state,
            input_sha256, temp_relative_path, final_relative_path, output_sha256, conversion_mode,
            converter_id, converter_version, artifact_schema_version, cache_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, ?, 'published_fs', ?, ?, ?, ?, 'manual',
            'qaing.manual-artifact', '1', 1, ?, ?, ?)`,
        )
        .run(
          operationId, projectId, sourceId, revisionId, generation, outputSha256,
          tempRelativePath, finalRelativePath, outputSha256, `manual:${outputSha256}`, now, now,
        )
      this.#database
        .prepare(
          `INSERT INTO conversion_artifacts(
            artifact_id, revision_id, relative_output_path, output_sha256, canonical_body_sha256, output_size_bytes,
            output_mtime_ns, output_device_id, output_inode, content_kind, warnings_json,
            validation_state, published_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'published_fs', ?, ?, ?)`,
        )
        .run(
          artifactId, revisionId, displayRelativePath, outputSha256, canonicalBodySha256,
          input.outputSizeBytes ?? Buffer.byteLength(canonicalContent), input.outputMtimeNs ?? null,
          input.outputDeviceId ?? null, input.outputInode ?? null, input.trustKind, now, now, now,
        )
      this.#database.prepare('UPDATE conversion_jobs SET artifact_id = ? WHERE operation_id = ?')
        .run(artifactId, operationId)
      this.#database
        .prepare(
          `UPDATE source_revisions SET conversion_mode = 'manual', converter_id = 'qaing.manual-artifact',
             converter_version = '1', artifact_schema_version = 1 WHERE revision_id = ?`,
        )
        .run(revisionId)
      if (input.trustKind === 'document') {
        if (!input.document || input.qaItems) throw new Error('Manual document artifact payload is invalid')
        this.commitProjectDocumentArtifact({
          operationId,
          artifactId,
          outputSha256,
          canonicalBodySha256,
          document: input.document,
          ...(input.outputSizeBytes === undefined ? {} : { outputSizeBytes: input.outputSizeBytes }),
          ...(input.outputMtimeNs === undefined ? {} : { outputMtimeNs: input.outputMtimeNs }),
          ...(input.outputDeviceId === undefined ? {} : { outputDeviceId: input.outputDeviceId }),
          ...(input.outputInode === undefined ? {} : { outputInode: input.outputInode }),
        }, now)
      } else {
        if (!input.qaItems || input.document) throw new Error('Manual preset QA artifact payload is invalid')
        this.commitProjectQaArtifact({
          operationId,
          artifactId,
          canonicalContent,
          outputSha256,
          canonicalBodySha256,
          items: input.qaItems,
          ...(input.outputSizeBytes === undefined ? {} : { outputSizeBytes: input.outputSizeBytes }),
          ...(input.outputMtimeNs === undefined ? {} : { outputMtimeNs: input.outputMtimeNs }),
          ...(input.outputDeviceId === undefined ? {} : { outputDeviceId: input.outputDeviceId }),
          ...(input.outputInode === undefined ? {} : { outputInode: input.outputInode }),
        }, now)
      }
      return { inserted: true, source: this.getProjectSource(sourceId) as ProjectSourceFileRecord }
    })
  }

  failManualProjectArtifact(
    input: FailManualProjectArtifactInput,
    now = Date.now(),
  ): ProjectSourceFileRecord {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const runId = validateIdentifier(input.runId, 'runId')
    const generation = validateSafePositiveInteger(input.generation, 'generation')
    const displayRelativePath = validateRelativeProjectPath(input.displayRelativePath, 'displayRelativePath')
    const pathKey = validateRelativeProjectPath(input.pathKey, 'pathKey')
    const inputSha256 = validateSha256(input.inputSha256, 'inputSha256')
    const errorCode = validateOptionalErrorCode(input.errorCode, 'errorCode')
    if (errorCode === null) throw new Error('A failed manual artifact requires an error code')
    return this.#write(() => {
      const project = this.#requireProject(projectId)
      const run = this.getProjectSyncRun(runId)
      if (!run || run.projectId !== projectId || run.generation !== generation || project.scanGeneration !== generation) {
        throw new Error('Manual artifact failure belongs to a stale sync generation')
      }
      const sourceId = projectSourceId(projectId, input.trustKind, pathKey)
      const source = this.getProjectSource(sourceId)
      if (source && (
        source.projectId !== projectId || source.trustKind !== input.trustKind || source.pathKey !== pathKey
      )) throw new Error('Manual artifact failure conflicts with an existing source')
      const existingRevision = this.findProjectSourceRevision({ sourceId, generation, rawSha256: inputSha256 })
      if (
        source?.displayRelativePath === displayRelativePath && source.observedRawSha256 === inputSha256 &&
        source.state === 'conversion_failed' && source.errorCode === errorCode &&
        existingRevision?.state === 'failed' && existingRevision.errorCode === errorCode &&
        existingRevision.conversionMode === 'manual'
      ) return source
      if (!source) {
        this.#database
          .prepare(
            `INSERT INTO source_files(
              source_id, project_id, trust_kind, display_relative_path, path_key, size_bytes, mtime_ns,
              observed_raw_sha256, detected_type, conversion_disposition, last_seen_generation, state,
              error_code, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'markdown', 'local', ?, 'conversion_failed', ?, ?, ?)`,
          )
          .run(
            sourceId, projectId, input.trustKind, displayRelativePath, pathKey, String(now * 1_000_000),
            inputSha256, generation, errorCode, now, now,
          )
      } else {
        this.#database
          .prepare(
            `UPDATE source_files SET display_relative_path = ?, observed_raw_sha256 = ?, detected_type = 'markdown',
               conversion_disposition = 'local', last_seen_generation = ?, state = 'conversion_failed',
               error_code = ?, missing_since_generation = NULL, tombstoned_at = NULL, updated_at = ?
             WHERE source_id = ?`,
          )
          .run(displayRelativePath, inputSha256, generation, errorCode, now, sourceId)
      }
      let revision = existingRevision
      if (!revision) {
        const revisionId = this.#insertObservedRevision(sourceId, inputSha256, 0, 'markdown', generation, now)
        revision = this.getProjectSourceRevision(revisionId)
      }
      this.#database
        .prepare(
          `UPDATE source_revisions SET state = 'failed', conversion_mode = 'manual',
             converter_id = 'qaing.manual-artifact', converter_version = '1', artifact_schema_version = 1,
             error_code = ? WHERE revision_id = ?`,
        )
        .run(errorCode, (revision as ProjectSourceRevisionRecord).revisionId)
      this.#bumpProjectRevision(projectId, now)
      return this.getProjectSource(sourceId) as ProjectSourceFileRecord
    })
  }

  failConversionJob(operationId: string, errorCode: string, now = Date.now()): ConversionJobRecord {
    return this.#terminalizeConversionJob(operationId, 'failed', errorCode, now)
  }

  cancelConversionJob(operationId: string, now = Date.now()): ConversionJobRecord {
    return this.#terminalizeConversionJob(operationId, 'cancelled', null, now)
  }

  retryConversionJob(operationId: string, now = Date.now()): ConversionJobRecord {
    validateIdentifier(operationId, 'operationId')
    return this.#write(() => {
      const job = this.getConversionJob(operationId)
      if (!job || (job.state !== 'failed' && job.state !== 'cancelled')) {
        throw new Error('Only a failed or cancelled conversion job may be retried')
      }
      const source = this.getProjectSource(job.sourceId)
      const revision = this.getProjectSourceRevision(job.revisionId)
      const project = this.#requireProject(job.projectId)
      if (
        !source || !revision || project.scanGeneration !== job.generation ||
        source.observedRawSha256 !== job.inputSha256 || revision.rawSha256 !== job.inputSha256
      ) throw new Error('Conversion input changed and cannot reuse this operation')
      this.#database
        .prepare(
          `UPDATE conversion_jobs SET artifact_id = NULL, state = 'prepared', output_sha256 = NULL,
             attempt = attempt + 1, error_code = NULL, updated_at = ? WHERE operation_id = ?`,
        )
        .run(now, operationId)
      if (job.artifactId) {
        this.#database.prepare('DELETE FROM conversion_artifacts WHERE artifact_id = ?').run(job.artifactId)
      }
      this.#database
        .prepare("UPDATE source_revisions SET state = 'prepared', error_code = NULL WHERE revision_id = ?")
        .run(job.revisionId)
      this.#database
        .prepare("UPDATE source_files SET state = 'converting', error_code = NULL, updated_at = ? WHERE source_id = ?")
        .run(now, job.sourceId)
      this.#bumpProjectRevision(job.projectId, now)
      return this.getConversionJob(operationId) as ConversionJobRecord
    })
  }

  markProjectRevisionIndexed(
    input: { readonly projectId: string; readonly sourceId: string; readonly revisionId: string },
    now = Date.now(),
  ): ProjectSourceFileRecord {
    return this.#write(() => {
      const source = this.getProjectSource(input.sourceId)
      if (!source || source.projectId !== input.projectId || source.activeRevisionId !== input.revisionId) {
        throw new Error('Indexed revision is not active for this project source')
      }
      if (source.state === 'ready') return source
      if (source.state !== 'embedding_pending') throw new Error('Only an embedding-pending source may become ready')
      this.#database.prepare("UPDATE source_files SET state = 'ready', updated_at = ? WHERE source_id = ?")
        .run(now, input.sourceId)
      this.#bumpProjectRevision(input.projectId, now)
      return this.getProjectSource(input.sourceId) as ProjectSourceFileRecord
    })
  }

  reconcileProjectIndexState(projectId: string, now = Date.now()): ProjectIndexReconcileResult {
    const normalizedProjectId = validateIdentifier(projectId, 'projectId')
    const changedSourceIds: string[] = []
    return this.#write(() => {
      this.#requireProject(normalizedProjectId)
      const sources = this.#database
        .prepare(
          `SELECT source_id, state FROM source_files
           WHERE project_id = ? AND active_revision_id IS NOT NULL
             AND state IN ('embedding_pending', 'ready', 'index_failed')
           ORDER BY source_id`,
        )
        .all(normalizedProjectId) as Array<{ source_id: string; state: ProjectSourceState }>
      const ownerCounts = this.#database.prepare(
        `WITH active_owners(has_embedding, job_status) AS (
           SELECT CASE WHEN c.embedding IS NOT NULL AND c.embedding_normalized = 1 THEN 1 ELSE 0 END,
             (SELECT j.status FROM index_jobs j
              WHERE j.owner_type = 'chunk' AND j.owner_id = c.id
                AND j.operation = 'upsert' AND j.content_hash = c.content_hash
              ORDER BY j.updated_at DESC, j.rowid DESC LIMIT 1)
           FROM project_document_links l JOIN chunks c ON c.document_id = l.document_id
           WHERE l.source_id = ? AND l.active = 1
           UNION ALL
           SELECT CASE WHEN q.embedding IS NOT NULL AND q.embedding_normalized = 1 THEN 1 ELSE 0 END,
             (SELECT j.status FROM index_jobs j
              WHERE j.owner_type = 'preset_qa' AND j.owner_id = q.id
                AND j.operation = 'upsert' AND j.content_hash = q.content_hash
              ORDER BY j.updated_at DESC, j.rowid DESC LIMIT 1)
           FROM project_qa_links l JOIN preset_qa q ON q.id = l.preset_qa_id
           WHERE l.source_id = ? AND l.active = 1
         )
         SELECT COUNT(*) AS total,
           SUM(CASE WHEN has_embedding = 1 AND job_status = 'ready' THEN 1 ELSE 0 END) AS ready,
           SUM(CASE WHEN job_status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM active_owners`,
      )
      const update = this.#database.prepare(
        'UPDATE source_files SET state = ?, error_code = ?, updated_at = ? WHERE source_id = ?',
      )
      for (const source of sources) {
        const counts = ownerCounts.get(source.source_id, source.source_id) as {
          total: number
          ready: number | null
          failed: number | null
        }
        if (counts.total === 0) continue
        const desired: ProjectSourceState = (counts.failed ?? 0) > 0
          ? 'index_failed'
          : (counts.ready ?? 0) === counts.total
            ? 'ready'
            : 'embedding_pending'
        if (source.state === desired) continue
        update.run(desired, desired === 'index_failed' ? 'EMBEDDING_INDEX_FAILED' : null, now, source.source_id)
        changedSourceIds.push(source.source_id)
      }
      if (changedSourceIds.length > 0) this.#bumpProjectRevision(normalizedProjectId, now)
      return {
        changedSourceIds,
        dataRevision: this.#requireProject(normalizedProjectId).dataRevision,
      }
    })
  }

  listProjectRecoveryWork(input: {
    readonly projectId?: string
    readonly limit?: number
  } = {}): readonly ConversionJobRecord[] {
    this.#assertOpen()
    const limit = Math.min(MAX_PROJECT_RECOVERY_ITEMS, Math.max(1, input.limit ?? MAX_PROJECT_RECOVERY_ITEMS))
    const rows = input.projectId
      ? this.#database
          .prepare(
            `SELECT * FROM conversion_jobs WHERE project_id = ? AND state IN ('prepared', 'staged', 'published_fs')
             ORDER BY updated_at, operation_id LIMIT ?`,
          )
          .all(input.projectId, limit) as SqlConversionJobRow[]
      : this.#database
          .prepare(
            `SELECT * FROM conversion_jobs WHERE state IN ('prepared', 'staged', 'published_fs')
             ORDER BY updated_at, operation_id LIMIT ?`,
          )
          .all(limit) as SqlConversionJobRow[]
    return rows.map(conversionJobFromRow)
  }

  recoverInterruptedProjectRuns(now = Date.now()): readonly ProjectSyncRunRecord[] {
    return this.#write(() => {
      const rows = this.#database
        .prepare("SELECT * FROM sync_runs WHERE state IN ('scanning', 'processing') ORDER BY started_at, run_id")
        .all() as SqlProjectSyncRunRow[]
      if (rows.length === 0) return []
      const finish = this.#database.prepare(
        `UPDATE sync_runs SET state = 'failed', error_code = 'SYNC_INTERRUPTED', completed_at = ?, updated_at = ?
         WHERE run_id = ?`,
      )
      const touched = new Set<string>()
      for (const row of rows) {
        finish.run(now, now, row.run_id)
        touched.add(row.project_id)
      }
      for (const projectId of touched) this.#bumpProjectRevision(projectId, now)
      return rows.map((row) => this.getProjectSyncRun(row.run_id) as ProjectSyncRunRecord)
    })
  }

  listProjectDocumentLinks(projectId?: string): readonly ProjectDocumentLinkRecord[] {
    this.#assertOpen()
    const rows = projectId
      ? this.#database
          .prepare(
            `SELECT l.source_id, l.artifact_id, l.document_id, l.active, l.linked_at
             FROM project_document_links l JOIN source_files s ON s.source_id = l.source_id
             WHERE s.project_id = ? ORDER BY l.source_id, l.artifact_id, l.document_id`,
          )
          .all(projectId)
      : this.#database
          .prepare(
            `SELECT source_id, artifact_id, document_id, active, linked_at
             FROM project_document_links ORDER BY source_id, artifact_id, document_id`,
          )
          .all()
    return (rows as Array<{
      source_id: string; artifact_id: string; document_id: string; active: number; linked_at: number
    }>).map((row) => ({
      sourceId: row.source_id,
      artifactId: row.artifact_id,
      documentId: row.document_id,
      active: row.active === 1,
      linkedAt: row.linked_at,
    }))
  }

  commitProjectFrontDocument(
    input: CommitProjectFrontDocumentInput,
    now = Date.now(),
  ): DocumentUpsertResult {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const sessionId = validateBoundedText(input.sessionId, 'sessionId', 256)
    const draftId = validateBoundedText(input.draftId, 'draftId', 256)
    const title = validateBoundedText(input.document.title, 'document.title', 300)
    const content = validateNonEmpty(input.document.content, 'document.content')
    const chunks = validateChunks(input.document.chunks)
    const expectedSourceUri = `qaing://front/${sessionId}`
    if (input.document.kind !== 'front_transcript' || input.document.sourceUri !== expectedSourceUri) {
      throw new Error('Project front documents require front_transcript kind and the frozen session URI')
    }
    const contentHash = sha256(content)
    return this.#write(() => {
      this.#requireProject(projectId)
      const session = this.getSession(sessionId)
      if (!session || session.mode !== 'front' || session.projectId !== projectId) {
        throw new Error('Front session does not belong to the project')
      }
      const draft = this.getFrontDraft(draftId)
      if (
        !draft || draft.sessionId !== sessionId ||
        (draft.status !== 'structured' && draft.status !== 'complete') ||
        draft.structuredMarkdown !== content
      ) throw new Error('Structured front draft does not match the committed document')

      const existingLink = this.#database
        .prepare('SELECT * FROM project_front_document_links WHERE session_id = ?')
        .get(sessionId) as {
          project_id: string
          session_id: string
          draft_id: string
          document_id: string
          document_content_hash: string
          linked_at: number
          updated_at: number
        } | undefined
      if (existingLink) {
        if (
          existingLink.project_id !== projectId || existingLink.draft_id !== draftId ||
          existingLink.document_content_hash !== contentHash
        ) throw new Error('Front session is already committed with different content or project ownership')
        const document = this.getDocument(existingLink.document_id)
        if (!document || document.contentHash !== contentHash) {
          throw new Error('Committed front document link is inconsistent')
        }
        const storedChunks = this.listChunks(document.id)
        if (
          storedChunks.length !== chunks.length ||
          storedChunks.some((chunk, index) => (
            chunk.content !== chunks[index]?.content || chunk.tokenCount !== chunks[index]?.tokenCount
          ))
        ) throw new Error('Front session retry uses a different chunking contract')
        return { document, inserted: false, contentChanged: false, removedChunkIds: [] }
      }

      // This front session is the producer of the new canonical document, so
      // it is the sole exception to the general no-active-session commit gate.
      // End it in the same IMMEDIATE transaction before publishing the link;
      // any later failure rolls both changes back. A second active session for
      // the project still blocks the commit.
      this.#assertProjectKnowledgeMutationAllowed(projectId, sessionId)
      if (session.endedAt === null) {
        this.#database
          .prepare("UPDATE sessions SET status = 'complete', ended_at = ? WHERE id = ? AND ended_at IS NULL")
          .run(now, sessionId)
      }

      const preexistingLegacy = this.#database
        .prepare(
          `SELECT 1 FROM documents d JOIN legacy_document_entries l ON l.document_id = d.id
           WHERE d.content_hash = ? OR d.source_uri = ? LIMIT 1`,
        )
        .get(contentHash, expectedSourceUri)
      const result = this.upsertDocument({ title, kind: 'front_transcript', content, chunks, sourceUri: expectedSourceUri }, now)
      if (!preexistingLegacy) {
        this.#database.prepare('DELETE FROM legacy_document_entries WHERE document_id = ?').run(result.document.id)
      }
      this.#database
        .prepare(
          `INSERT INTO project_front_document_links(
             session_id, project_id, draft_id, document_id, document_content_hash, linked_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, projectId, draftId, result.document.id, contentHash, now, now)
      this.#database
        .prepare(
          `UPDATE projects SET knowledge_version = knowledge_version + 1,
             data_revision = data_revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(now, projectId)
      this.#bumpGlobalProjectRevision()
      return result
    })
  }

  listProjectFrontDocumentLinks(projectIdValue?: string): readonly ProjectFrontDocumentLinkRecord[] {
    this.#assertOpen()
    const projectId = projectIdValue === undefined ? null : validateIdentifier(projectIdValue, 'projectId')
    const rows = (projectId === null
      ? this.#database.prepare('SELECT * FROM project_front_document_links ORDER BY project_id, linked_at, session_id').all()
      : this.#database
          .prepare('SELECT * FROM project_front_document_links WHERE project_id = ? ORDER BY linked_at, session_id')
          .all(projectId)) as Array<{
      project_id: string
      session_id: string
      draft_id: string
      document_id: string
      document_content_hash: string
      linked_at: number
      updated_at: number
    }>
    return rows.map((row) => ({
      projectId: row.project_id,
      sessionId: row.session_id,
      draftId: row.draft_id,
      documentId: row.document_id,
      documentContentHash: row.document_content_hash,
      linkedAt: row.linked_at,
      updatedAt: row.updated_at,
    }))
  }

  /** Internal scanner/planner snapshot; bounded by the scanner's 2000-file contract. */
  listProjectManifestEntries(projectId: string): readonly ProjectManifestEntryRecord[] {
    this.#assertOpen()
    this.#requireProject(projectId)
    const rows = this.#database
      .prepare(
        `SELECT s.*, r.raw_sha256 AS active_raw_sha256,
           a.output_sha256 AS active_canonical_sha256,
           a.relative_output_path AS output_relative_path,
           a.output_size_bytes, a.output_mtime_ns, a.output_device_id, a.output_inode
         FROM source_files s
         LEFT JOIN source_revisions r ON r.revision_id = s.active_revision_id
         LEFT JOIN conversion_artifacts a ON a.artifact_id = CASE
           WHEN s.trust_kind = 'document' THEN (
             SELECT l.artifact_id FROM project_document_links l
             WHERE l.source_id = s.source_id AND l.active = 1 LIMIT 1
           )
           ELSE (
             SELECT l.artifact_id FROM project_qa_links l
             WHERE l.source_id = s.source_id AND l.active = 1 ORDER BY l.artifact_id LIMIT 1
           )
         END AND a.validation_state IN ('committed', 'modified')
         WHERE s.project_id = ? ORDER BY s.trust_kind, s.path_key, s.source_id LIMIT 2001`,
      )
      .all(projectId) as Array<SqlProjectSourceFileRow & {
      active_raw_sha256: string | null
      active_canonical_sha256: string | null
      output_relative_path: string | null
      output_size_bytes: number | null
      output_mtime_ns: string | null
      output_device_id: string | null
      output_inode: string | null
    }>
    if (rows.length > 2_000) throw new Error('Project manifest exceeds its 2000-file contract')
    return rows.map((row) => ({
      sourceId: row.source_id,
      projectId: row.project_id,
      relativePath: row.display_relative_path,
      pathKey: row.path_key,
      trustKind: row.trust_kind,
      sizeBytes: row.size_bytes,
      mtimeNs: row.mtime_ns,
      deviceId: row.device_id,
      inode: row.inode,
      rawSha256: row.observed_raw_sha256,
      detectedType: row.detected_type,
      conversionDisposition: row.conversion_disposition,
      errorCode: row.error_code,
      state: row.state,
      activeRawSha256: row.active_raw_sha256,
      activeCanonicalSha256: row.active_canonical_sha256,
      outputRelativePath: row.output_relative_path,
      outputSizeBytes: row.output_size_bytes,
      outputMtimeNs: row.output_mtime_ns,
      outputDeviceId: row.output_device_id,
      outputInode: row.output_inode,
      missingSinceGeneration: row.missing_since_generation,
      lastSeenGeneration: row.last_seen_generation,
    }))
  }

  listProjectQaLinks(projectId?: string): readonly ProjectQaLinkRecord[] {
    this.#assertOpen()
    const rows = projectId
      ? this.#database
          .prepare(
            `SELECT l.source_id, l.artifact_id, l.preset_qa_id, l.active, l.linked_at
             FROM project_qa_links l JOIN source_files s ON s.source_id = l.source_id
             WHERE s.project_id = ? ORDER BY l.source_id, l.artifact_id, l.preset_qa_id`,
          )
          .all(projectId)
      : this.#database
          .prepare(
            `SELECT source_id, artifact_id, preset_qa_id, active, linked_at
             FROM project_qa_links ORDER BY source_id, artifact_id, preset_qa_id`,
          )
          .all()
    return (rows as Array<{
      source_id: string; artifact_id: string; preset_qa_id: string; active: number; linked_at: number
    }>).map((row) => ({
      sourceId: row.source_id,
      artifactId: row.artifact_id,
      presetQaId: row.preset_qa_id,
      active: row.active === 1,
      linkedAt: row.linked_at,
    }))
  }

  upsertDocument(input: DocumentImportInput, now = Date.now()): DocumentUpsertResult {
    const title = validateNonEmpty(input.title, 'title')
    const content = validateNonEmpty(input.content, 'content')
    const chunks = validateChunks(input.chunks)
    const contentHash = sha256(content)
    const sourceUri = input.sourceUri?.trim() || null

    return this.#write(() => {
      const existingByHash = this.#database
        .prepare('SELECT * FROM documents WHERE content_hash = ?')
        .get(contentHash) as SqlDocumentRow | undefined
      const existingBySource = sourceUri
        ? (this.#database.prepare('SELECT * FROM documents WHERE source_uri = ?').get(sourceUri) as
            | SqlDocumentRow
            | undefined)
        : undefined

      if (
        existingByHash &&
        existingBySource &&
        existingByHash.id === existingBySource.id &&
        existingByHash.content_hash === contentHash
      ) {
        this.#database
          .prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ?')
          .run(title, now, existingByHash.id)
        this.#markLegacyDocument(existingByHash.id)
        return {
          document: this.getDocument(existingByHash.id) as DocumentRecord,
          inserted: false,
          contentChanged: false,
          removedChunkIds: [],
        }
      }

      if (existingByHash && !existingBySource) {
        this.#database
          .prepare('UPDATE documents SET title = ?, source_uri = COALESCE(source_uri, ?), updated_at = ? WHERE id = ?')
          .run(title, sourceUri, now, existingByHash.id)
        this.#markLegacyDocument(existingByHash.id)
        return {
          document: this.getDocument(existingByHash.id) as DocumentRecord,
          inserted: false,
          contentChanged: false,
          removedChunkIds: [],
        }
      }

      if (existingByHash && existingBySource && existingByHash.id !== existingBySource.id) {
        throw new Error('The imported content already belongs to a different source')
      }

      const id = existingBySource?.id ?? stableId('doc', sourceUri ?? contentHash)
      const inserted = !existingBySource
      const removedChunkIds = existingBySource
        ? (
            this.#database.prepare('SELECT id FROM chunks WHERE document_id = ? ORDER BY ordinal').all(id) as Array<{
              id: string
            }>
          ).map((row) => row.id)
        : []
      if (existingBySource) {
        this.#database
          .prepare(
            `UPDATE documents
             SET title = ?, kind = ?, content = ?, content_hash = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(title, input.kind, content, contentHash, now, id)
        this.#database.prepare('DELETE FROM chunks WHERE document_id = ?').run(id)
      } else {
        this.#database
          .prepare(
            `INSERT INTO documents(id, title, kind, source_uri, content, content_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, title, input.kind, sourceUri, content, contentHash, now, now)
      }

      const insertChunk = this.#database.prepare(
        `INSERT INTO chunks(id, document_id, ordinal, content, content_hash, token_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const [ordinal, chunk] of chunks.entries()) {
        const chunkHash = sha256(chunk.content)
        const chunkId = stableId('chunk', `${id}:${ordinal}:${chunkHash}`)
        insertChunk.run(chunkId, id, ordinal, chunk.content, chunkHash, chunk.tokenCount)
        this.#enqueueIndexJob('chunk', chunkId, 'upsert', chunkHash, now)
      }

      this.#markLegacyDocument(id)

      return {
        document: this.getDocument(id) as DocumentRecord,
        inserted,
        contentChanged: true,
        removedChunkIds,
      }
    })
  }

  /** All documents either commit together in one IMMEDIATE transaction or none do. */
  upsertDocumentsBatch(
    inputs: readonly DocumentImportInput[],
    now = Date.now(),
  ): readonly DocumentUpsertResult[] {
    if (inputs.length === 0) throw new Error('Document import batch must not be empty')
    // Validate the entire batch before opening the write transaction. The
    // nested calls reuse #write's single-writer transaction by design.
    for (const input of inputs) {
      validateNonEmpty(input.title, 'title')
      validateNonEmpty(input.content, 'content')
      validateChunks(input.chunks)
    }
    return this.#write(() => inputs.map((input) => this.upsertDocument(input, now)))
  }

  getDocument(id: string): DocumentRecord | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM documents WHERE id = ?').get(id) as SqlDocumentRow | undefined
    return row ? documentFromRow(row) : null
  }

  listDocuments(): readonly DocumentRecord[] {
    this.#assertOpen()
    return (this.#database.prepare('SELECT * FROM documents ORDER BY created_at, id').all() as SqlDocumentRow[]).map(
      documentFromRow,
    )
  }

  listChunks(documentId?: string): readonly ChunkRecord[] {
    this.#assertOpen()
    const rows = documentId
      ? (this.#database
          .prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY ordinal')
          .all(documentId) as SqlChunkRow[])
      : (this.#database.prepare('SELECT * FROM chunks ORDER BY document_id, ordinal').all() as SqlChunkRow[])
    return rows.map(chunkFromRow)
  }

  deleteDocument(id: string): readonly string[] {
    return this.#write(() => {
      const chunkIds = (
        this.#database.prepare('SELECT id FROM chunks WHERE document_id = ? ORDER BY ordinal').all(id) as Array<{
          id: string
        }>
      ).map((row) => row.id)
      this.#database.prepare('DELETE FROM legacy_document_entries WHERE document_id = ?').run(id)
      const projectLink = this.#database
        .prepare(
          `SELECT 1 FROM project_document_links WHERE document_id = ?
           UNION ALL SELECT 1 FROM project_front_document_links WHERE document_id = ? LIMIT 1`,
        )
        .get(id, id)
      if (projectLink) return []
      this.#database.prepare('DELETE FROM documents WHERE id = ?').run(id)
      return chunkIds
    })
  }

  upsertPresetQa(input: PresetQaInput, now = Date.now()): PresetQaUpsertResult {
    const question = validateNonEmpty(input.question, 'question')
    const answer = validateNonEmpty(input.answer, 'answer')
    const normalized = normalizeQuestion(question)
    const contentHash = sha256(`${normalized}\n${answer}`)

    return this.#write(() => {
      const existing = this.#database
        .prepare(
          `SELECT q.* FROM preset_qa q JOIN legacy_qa_entries l ON l.preset_qa_id = q.id
           WHERE q.normalized_question = ? ORDER BY q.id LIMIT 1`,
        )
        .get(normalized) as SqlPresetQaRow | undefined
      if (existing?.content_hash === contentHash) {
        this.#markLegacyPresetQa(existing.id)
        return { record: presetQaFromRow(existing), inserted: false, contentChanged: false }
      }

      const id = existing?.id ?? stableId('qa', normalized)
      if (existing) {
        this.#database
          .prepare(
            `UPDATE preset_qa SET question = ?, answer = ?, content_hash = ?,
               embedding = NULL, embedding_model_id = NULL, embedding_model_revision = NULL,
               embedding_dimension = NULL, embedding_normalized = 0, embedded_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(question, answer, contentHash, now, id)
        this.#database.prepare("DELETE FROM index_jobs WHERE owner_type = 'preset_qa' AND owner_id = ?").run(id)
      } else {
        this.#database
          .prepare(
            `INSERT INTO preset_qa(
              id, question, normalized_question, answer, content_hash, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, question, normalized, answer, contentHash, now, now)
      }
      this.#markLegacyPresetQa(id)
      this.#enqueueIndexJob('preset_qa', id, 'upsert', contentHash, now)
      return {
        record: this.getPresetQa(id) as PresetQaRecord,
        inserted: !existing,
        contentChanged: true,
      }
    })
  }

  upsertPresetQaBatch(inputs: readonly PresetQaInput[], now = Date.now()): readonly PresetQaUpsertResult[] {
    return this.#write(() => inputs.map((input) => this.#upsertPresetQaInsideTransaction(input, now)))
  }

  /** Rechecks reviewed-answer conflicts and commits the batch under one IMMEDIATE write lock. */
  upsertPresetQaBatchIfNoConflicts(
    inputs: readonly PresetQaInput[],
    now = Date.now(),
  ): readonly PresetQaUpsertResult[] {
    if (inputs.length === 0) throw new Error('Preset QA batch must not be empty')
    return this.#write(() => {
      this.#assertPresetQaBatchHasNoConflicts(inputs)
      return inputs.map((input) => this.#upsertPresetQaInsideTransaction(input, now))
    })
  }

  assertPresetQaBatchHasNoConflicts(inputs: readonly PresetQaInput[]): void {
    this.#assertOpen()
    this.#assertPresetQaBatchHasNoConflicts(inputs)
  }

  #assertPresetQaBatchHasNoConflicts(inputs: readonly PresetQaInput[]): void {
    const findExisting = this.#database
      .prepare(
        `SELECT q.content_hash FROM preset_qa q JOIN legacy_qa_entries l ON l.preset_qa_id = q.id
         WHERE q.normalized_question = ? ORDER BY q.id LIMIT 1`,
      )
    for (const input of inputs) {
      const question = validateNonEmpty(input.question, 'question')
      const answer = validateNonEmpty(input.answer, 'answer')
      const normalized = normalizeQuestion(question)
      const existing = findExisting.get(normalized) as { readonly content_hash: string } | undefined
      if (existing && existing.content_hash !== sha256(`${normalized}\n${answer}`)) {
        throw new Error(`QA import conflicts with an existing answer for question "${question}"`)
      }
    }
  }

  #upsertPresetQaInsideTransaction(input: PresetQaInput, now: number): PresetQaUpsertResult {
    const question = validateNonEmpty(input.question, 'question')
    const answer = validateNonEmpty(input.answer, 'answer')
    const normalized = normalizeQuestion(question)
    const contentHash = sha256(`${normalized}\n${answer}`)
    const existing = this.#database
      .prepare(
        `SELECT q.* FROM preset_qa q JOIN legacy_qa_entries l ON l.preset_qa_id = q.id
         WHERE q.normalized_question = ? ORDER BY q.id LIMIT 1`,
      )
      .get(normalized) as SqlPresetQaRow | undefined
    if (existing?.content_hash === contentHash) {
      this.#markLegacyPresetQa(existing.id)
      return { record: presetQaFromRow(existing), inserted: false, contentChanged: false }
    }
    const id = existing?.id ?? stableId('qa', normalized)
    if (existing) {
      this.#database
        .prepare(
          `UPDATE preset_qa SET question = ?, answer = ?, content_hash = ?,
             embedding = NULL, embedding_model_id = NULL, embedding_model_revision = NULL,
             embedding_dimension = NULL, embedding_normalized = 0, embedded_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(question, answer, contentHash, now, id)
      this.#database.prepare("DELETE FROM index_jobs WHERE owner_type = 'preset_qa' AND owner_id = ?").run(id)
    } else {
      this.#database
        .prepare(
          `INSERT INTO preset_qa(id, question, normalized_question, answer, content_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, question, normalized, answer, contentHash, now, now)
    }
    this.#markLegacyPresetQa(id)
    this.#enqueueIndexJob('preset_qa', id, 'upsert', contentHash, now)
    return {
      record: this.getPresetQa(id) as PresetQaRecord,
      inserted: !existing,
      contentChanged: true,
    }
  }

  getPresetQa(id: string): PresetQaRecord | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM preset_qa WHERE id = ?').get(id) as
      | SqlPresetQaRow
      | undefined
    return row ? presetQaFromRow(row) : null
  }

  listPresetQa(): readonly PresetQaRecord[] {
    this.#assertOpen()
    return (this.#database.prepare('SELECT * FROM preset_qa ORDER BY created_at, id').all() as SqlPresetQaRow[]).map(
      presetQaFromRow,
    )
  }

  deletePresetQa(id: string): boolean {
    return this.#write(() => {
      this.#database.prepare('DELETE FROM legacy_qa_entries WHERE preset_qa_id = ?').run(id)
      const projectLink = this.#database.prepare('SELECT 1 FROM project_qa_links WHERE preset_qa_id = ? LIMIT 1').get(id)
      if (projectLink) return false
      return this.#database.prepare('DELETE FROM preset_qa WHERE id = ?').run(id).changes === 1
    })
  }

  findExactPresetQa(question: string, limit = 5): readonly PresetQaRecord[] {
    this.#assertOpen()
    const normalized = normalizeQuestion(question).replace(/[\s?？。.]+$/gu, '').trim()
    if (!normalized) return []
    const activeProjectId = this.getActiveProjectId()
    const rows = activeProjectId
      ? this.#database
          .prepare(
            `SELECT q.* FROM preset_qa q
             WHERE rtrim(q.normalized_question, ' ?？。.') = ? AND EXISTS (
               SELECT 1 FROM project_qa_links l JOIN source_files s ON s.source_id = l.source_id
               WHERE l.preset_qa_id = q.id AND l.active = 1 AND s.project_id = ?
             ) ORDER BY q.updated_at DESC, q.id LIMIT ?`,
          )
          .all(normalized, activeProjectId, Math.max(1, limit)) as SqlPresetQaRow[]
      : this.#database
          .prepare(
            `SELECT q.* FROM preset_qa q JOIN legacy_qa_entries l ON l.preset_qa_id = q.id
             WHERE rtrim(q.normalized_question, ' ?？。.') = ?
             ORDER BY q.updated_at DESC, q.id LIMIT ?`,
          )
          .all(normalized, Math.max(1, limit)) as SqlPresetQaRow[]
    return rows.map(presetQaFromRow)
  }

  searchKeywords(query: string, limit = 20): readonly KeywordHit[] {
    const boundedLimit = Math.max(1, Math.min(100, limit))
    const qaRows = this.searchPresetQaKeywords(query, boundedLimit)
    const chunkRows = this.searchDocumentKeywords(query, boundedLimit)
    const hits: KeywordHit[] = []
    for (let index = 0; hits.length < boundedLimit && (index < qaRows.length || index < chunkRows.length); index += 1) {
      const qa = qaRows[index]
      const chunk = chunkRows[index]
      if (qa) hits.push({ ...qa, rank: hits.length + 1 })
      if (chunk && hits.length < boundedLimit) hits.push({ ...chunk, rank: hits.length + 1 })
    }
    return hits
  }

  /**
   * Searches only reviewed preset questions. Answers are intentionally excluded
   * so answer-only keyword overlap cannot qualify a record for direct return.
   */
  searchPresetQaKeywords(query: string, limit = 20): readonly KeywordHit[] {
    this.#assertOpen()
    const normalized = normalizeContent(query)
    if (!normalized) return []
    const boundedLimit = Math.max(1, Math.min(100, limit))
    const ftsQuery = makeFtsQuery(normalized)
    const activeProjectId = this.getActiveProjectId()
    const scopeSql = activeProjectId
      ? `EXISTS (
          SELECT 1 FROM project_qa_links l JOIN source_files s ON s.source_id = l.source_id
          WHERE l.preset_qa_id = q.id AND l.active = 1 AND s.project_id = ?
        )`
      : 'EXISTS (SELECT 1 FROM legacy_qa_entries l WHERE l.preset_qa_id = q.id)'
    const scopeParams = activeProjectId ? [activeProjectId] : []
    if (!ftsQuery) {
      const pattern = `%${normalized.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
      const rows = this.#database
        .prepare(
          `SELECT q.id AS owner_id, q.question AS title, q.answer AS excerpt
           FROM preset_qa q WHERE q.question LIKE ? ESCAPE '\\' AND ${scopeSql}
           ORDER BY q.updated_at DESC, q.id LIMIT ?`,
        )
        .all(pattern, ...scopeParams, boundedLimit) as Array<{ owner_id: string; title: string; excerpt: string }>
      return rows.map((row, index) => ({
        ownerType: 'preset_qa' as const,
        ownerId: row.owner_id,
        documentId: `preset:${row.owner_id}`,
        title: row.title,
        excerpt: row.excerpt,
        rank: index + 1,
      }))
    }
    const rows = this.#database
      .prepare(
        `SELECT q.id AS owner_id, q.question AS title, q.answer AS excerpt
         FROM preset_qa_fts
         JOIN preset_qa q ON q.rowid = preset_qa_fts.rowid
         WHERE preset_qa_fts MATCH ? AND ${scopeSql}
         ORDER BY bm25(preset_qa_fts), q.id
         LIMIT ?`,
      )
      .all(`{question} : (${ftsQuery})`, ...scopeParams, boundedLimit) as Array<{
      owner_id: string
      title: string
      excerpt: string
    }>
    return rows.map((row, index) => ({
      ownerType: 'preset_qa',
      ownerId: row.owner_id,
      documentId: `preset:${row.owner_id}`,
      title: row.title,
      excerpt: row.excerpt,
      rank: index + 1,
    }))
  }

  searchDocumentKeywords(query: string, limit = 20): readonly KeywordHit[] {
    this.#assertOpen()
    const normalized = normalizeContent(query)
    if (!normalized) return []
    const boundedLimit = Math.max(1, Math.min(100, limit))
    const ftsQuery = makeFtsQuery(normalized)
    const activeProjectId = this.getActiveProjectId()
    const scopeSql = activeProjectId
      ? `(EXISTS (
           SELECT 1 FROM project_document_links l JOIN source_files s ON s.source_id = l.source_id
           WHERE l.document_id = d.id AND l.active = 1 AND s.project_id = ?
         ) OR EXISTS (
           SELECT 1 FROM project_front_document_links f
           WHERE f.document_id = d.id AND f.project_id = ?
         ))`
      : 'EXISTS (SELECT 1 FROM legacy_document_entries l WHERE l.document_id = d.id)'
    const scopeParams = activeProjectId ? [activeProjectId, activeProjectId] : []
    if (!ftsQuery) {
      const pattern = `%${normalized.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
      const rows = this.#database
        .prepare(
           `SELECT c.id AS owner_id, c.document_id, d.title, c.content AS excerpt
           FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.content LIKE ? ESCAPE '\\' AND ${scopeSql}
           ORDER BY d.updated_at DESC, c.ordinal LIMIT ?`,
        )
        .all(pattern, ...scopeParams, boundedLimit) as Array<{
          owner_id: string
          document_id: string
          title: string
          excerpt: string
        }>
      return rows.map((row, index) => ({
        ownerType: 'chunk' as const,
        ownerId: row.owner_id,
        documentId: row.document_id,
        title: row.title,
        excerpt: row.excerpt,
        rank: index + 1,
      }))
    }
    const rows = this.#database
      .prepare(
        `SELECT c.id AS owner_id, c.document_id, d.title, c.content AS excerpt
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN documents d ON d.id = c.document_id
         WHERE chunks_fts MATCH ? AND ${scopeSql}
         ORDER BY bm25(chunks_fts), c.id
         LIMIT ?`,
      )
      .all(ftsQuery, ...scopeParams, boundedLimit) as Array<{
        owner_id: string
        document_id: string
        title: string
        excerpt: string
      }>
    return rows.map((row, index) => ({
      ownerType: 'chunk',
      ownerId: row.owner_id,
      documentId: row.document_id,
      title: row.title,
      excerpt: row.excerpt,
      rank: index + 1,
    }))
  }

  /**
   * Returns the only vector owner IDs that may participate in the current
   * retrieval scope. With an active project this is project links only; with
   * no active project it is the explicit legacy catalog only.
   */
  getRetrievalOwnerIds(ownerType: IndexOwnerType): ReadonlySet<string> {
    this.#assertOpen()
    const activeProjectId = this.getActiveProjectId()
    if (ownerType === 'preset_qa') {
      const rows = activeProjectId
        ? this.#database
            .prepare(
              `SELECT DISTINCT l.preset_qa_id AS owner_id FROM project_qa_links l
               JOIN source_files s ON s.source_id = l.source_id
               WHERE s.project_id = ? AND l.active = 1 ORDER BY l.preset_qa_id`,
            )
            .all(activeProjectId) as Array<{ owner_id: string }>
        : this.#database
            .prepare('SELECT preset_qa_id AS owner_id FROM legacy_qa_entries ORDER BY preset_qa_id')
            .all() as Array<{ owner_id: string }>
      return new Set(rows.map((row) => row.owner_id))
    }
    const rows = activeProjectId
      ? this.#database
          .prepare(
            `SELECT c.id AS owner_id FROM chunks c WHERE EXISTS (
               SELECT 1 FROM project_document_links l JOIN source_files s ON s.source_id = l.source_id
               WHERE l.document_id = c.document_id AND l.active = 1 AND s.project_id = ?
             ) OR EXISTS (
               SELECT 1 FROM project_front_document_links f
               WHERE f.document_id = c.document_id AND f.project_id = ?
             ) ORDER BY c.id`,
          )
          .all(activeProjectId, activeProjectId) as Array<{ owner_id: string }>
      : this.#database
          .prepare(
            `SELECT c.id AS owner_id FROM chunks c JOIN legacy_document_entries l ON l.document_id = c.document_id
             ORDER BY c.id`,
          )
          .all() as Array<{ owner_id: string }>
    return new Set(rows.map((row) => row.owner_id))
  }

  storeEmbedding(write: EmbeddingWrite, now = Date.now()): void {
    this.storeEmbeddings([write], now)
  }

  storeEmbeddings(
    writes: readonly EmbeddingWrite[],
    now = Date.now(),
    maximumVectors = MAX_EXACT_VECTORS,
  ): void {
    if (!Number.isSafeInteger(maximumVectors) || maximumVectors < 1 || maximumVectors > MAX_EXACT_VECTORS) {
      throw new Error(`maximumVectors must be between 1 and ${MAX_EXACT_VECTORS}`)
    }
    for (const write of writes) assertNormalizedVector(write.vector, write.metadata)
    this.#write(() => {
      const seen = new Set<string>()
      let additions = 0
      for (const write of writes) {
        const key = `${write.ownerType}:${write.ownerId}`
        if (seen.has(key)) throw new Error('Embedding batch contains the same owner more than once')
        seen.add(key)
        const row = write.ownerType === 'chunk'
          ? this.#database
              .prepare(
                `SELECT c.embedding IS NOT NULL AS has_embedding, (
                   EXISTS (SELECT 1 FROM legacy_document_entries ld WHERE ld.document_id = c.document_id)
                   OR EXISTS (
                     SELECT 1 FROM project_document_links pl
                     WHERE pl.document_id = c.document_id AND pl.active = 1
                   )
                   OR EXISTS (
                     SELECT 1 FROM project_front_document_links pf
                     WHERE pf.document_id = c.document_id
                   )
                 ) AS eligible
                 FROM chunks c WHERE c.id = ? AND c.content_hash = ?`,
              )
              .get(write.ownerId, write.contentHash) as { has_embedding: number; eligible: number } | undefined
          : this.#database
              .prepare(
                `SELECT q.embedding IS NOT NULL AS has_embedding, (
                   EXISTS (SELECT 1 FROM legacy_qa_entries lq WHERE lq.preset_qa_id = q.id)
                   OR EXISTS (
                     SELECT 1 FROM project_qa_links pl
                     WHERE pl.preset_qa_id = q.id AND pl.active = 1
                   )
                 ) AS eligible
                 FROM preset_qa q WHERE q.id = ? AND q.content_hash = ?`,
              )
              .get(write.ownerId, write.contentHash) as { has_embedding: number; eligible: number } | undefined
        if (!row) throw new Error('Refusing to store a stale or missing embedding')
        // A revision can become inactive while its isolated worker is running.
        // Keeping that BLOB is useful for later reactivation, but it must not
        // consume the active exact-index capacity.
        if (row.has_embedding === 0 && row.eligible === 1) additions += 1
      }
      if (this.countStoredVectors() + additions > maximumVectors) throw new VectorCapacityError(maximumVectors)
      for (const write of writes) this.#storeEmbeddingInsideTransaction(write, now)
    })
  }

  #storeEmbeddingInsideTransaction(write: EmbeddingWrite, now: number): void {
    const table = write.ownerType === 'chunk' ? 'chunks' : 'preset_qa'
    const result = this.#database
      .prepare(
        `UPDATE ${table}
         SET embedding = ?, embedding_model_id = ?, embedding_model_revision = ?,
             embedding_dimension = ?, embedding_normalized = 1, embedded_at = ?
         WHERE id = ? AND content_hash = ?`,
      )
      .run(
        encodeVector(write.vector),
        write.metadata.modelId,
        write.metadata.modelRevision,
        write.metadata.dimension,
        now,
        write.ownerId,
        write.contentHash,
      )
    if (result.changes !== 1) throw new Error('Refusing to store a stale or missing embedding')
    this.#database
      .prepare(
        `UPDATE index_jobs SET status = 'ready', last_error_code = NULL, updated_at = ?,
           last_model_id = ?, last_model_revision = ?, last_embedding_dimension = ?
         WHERE owner_type = ? AND owner_id = ? AND content_hash = ?`,
      )
      .run(
        now,
        write.metadata.modelId,
        write.metadata.modelRevision,
        write.metadata.dimension,
        write.ownerType,
        write.ownerId,
        write.contentHash,
      )
  }

  loadStoredVectors(metadata?: EmbeddingMetadata): readonly StoredVector[] {
    this.#assertOpen()
    const params: unknown[] = []
    const filter = metadata
      ? ` AND embedding_model_id = ? AND embedding_model_revision = ?
          AND embedding_dimension = ? AND embedding_normalized = 1`
      : ' AND embedding_normalized = 1'
    if (metadata) params.push(metadata.modelId, metadata.modelRevision, metadata.dimension)

    const chunks = this.#database
      .prepare(
        `SELECT c.*, d.title FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE c.embedding IS NOT NULL${filter} AND (
           EXISTS (SELECT 1 FROM legacy_document_entries ld WHERE ld.document_id = c.document_id)
           OR EXISTS (
             SELECT 1 FROM project_document_links pl
             WHERE pl.document_id = c.document_id AND pl.active = 1
           )
           OR EXISTS (
             SELECT 1 FROM project_front_document_links pf
             WHERE pf.document_id = c.document_id
           )
         ) ORDER BY c.document_id, c.ordinal`,
      )
      .all(...params) as Array<SqlChunkRow & { title: string }>
    const qas = this.#database
      .prepare(
        `SELECT * FROM preset_qa WHERE embedding IS NOT NULL${filter} AND (
           EXISTS (SELECT 1 FROM legacy_qa_entries lq WHERE lq.preset_qa_id = preset_qa.id)
           OR EXISTS (
             SELECT 1 FROM project_qa_links pl
             WHERE pl.preset_qa_id = preset_qa.id AND pl.active = 1
           )
         ) ORDER BY id`,
      )
      .all(...params) as SqlPresetQaRow[]

    return [
      ...chunks.map((row) => ({
        ownerType: 'chunk' as const,
        ownerId: row.id,
        documentId: row.document_id,
        title: row.title,
        excerpt: row.content,
        contentHash: row.content_hash,
        vector: decodeVector(row.embedding, row.embedding_dimension) as Float32Array,
        metadata: {
          modelId: row.embedding_model_id as string,
          modelRevision: row.embedding_model_revision as string,
          dimension: row.embedding_dimension as number,
          normalized: true,
        },
      })),
      ...qas.map((row) => ({
        ownerType: 'preset_qa' as const,
        ownerId: row.id,
        documentId: `preset:${row.id}`,
        title: row.question,
        excerpt: row.answer,
        contentHash: row.content_hash,
        vector: decodeVector(row.embedding, row.embedding_dimension) as Float32Array,
        metadata: {
          modelId: row.embedding_model_id as string,
          modelRevision: row.embedding_model_revision as string,
          dimension: row.embedding_dimension as number,
          normalized: true,
        },
      })),
    ]
  }

  countStoredVectors(metadata?: EmbeddingMetadata): number {
    this.#assertOpen()
    const filter = metadata
      ? ` AND embedding_model_id = ? AND embedding_model_revision = ?
          AND embedding_dimension = ? AND embedding_normalized = 1`
      : ' AND embedding_normalized = 1'
    const params = metadata ? [metadata.modelId, metadata.modelRevision, metadata.dimension] : []
    const chunks = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM chunks c WHERE embedding IS NOT NULL${filter} AND (
           EXISTS (SELECT 1 FROM legacy_document_entries ld WHERE ld.document_id = c.document_id)
           OR EXISTS (
             SELECT 1 FROM project_document_links pl
             WHERE pl.document_id = c.document_id AND pl.active = 1
           )
           OR EXISTS (
             SELECT 1 FROM project_front_document_links pf
             WHERE pf.document_id = c.document_id
           )
         )`,
      )
      .get(...params) as { count: number }
    const qas = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM preset_qa q WHERE embedding IS NOT NULL${filter} AND (
           EXISTS (SELECT 1 FROM legacy_qa_entries lq WHERE lq.preset_qa_id = q.id)
           OR EXISTS (
             SELECT 1 FROM project_qa_links pl
             WHERE pl.preset_qa_id = q.id AND pl.active = 1
           )
         )`,
      )
      .get(...params) as { count: number }
    return chunks.count + qas.count
  }

  listUnembeddedOwners(metadata: EmbeddingMetadata, limit = 100): readonly StoredVectorSource[] {
    this.#assertOpen()
    const chunks = this.#database
      .prepare(
        `SELECT c.id AS owner_id, c.document_id, d.title, c.content AS text, c.content AS excerpt,
                c.content_hash, c.embedding IS NOT NULL AS has_embedding
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE (c.embedding IS NULL OR c.embedding_model_id != ? OR c.embedding_model_revision != ?
           OR c.embedding_dimension != ?)
           AND (
             EXISTS (SELECT 1 FROM legacy_document_entries ld WHERE ld.document_id = c.document_id)
             OR EXISTS (
               SELECT 1 FROM project_document_links pl
               WHERE pl.document_id = c.document_id AND pl.active = 1
             )
             OR EXISTS (
               SELECT 1 FROM project_front_document_links pf
               WHERE pf.document_id = c.document_id
             )
           )
           AND EXISTS (
             SELECT 1 FROM index_jobs j
             WHERE j.owner_type = 'chunk' AND j.owner_id = c.id AND j.content_hash = c.content_hash
               AND j.status IN ('pending', 'processing')
           )
         ORDER BY d.created_at, c.ordinal LIMIT ?`,
      )
      .all(metadata.modelId, metadata.modelRevision, metadata.dimension, limit) as StoredVectorSourceRow[]
    const remaining = Math.max(0, limit - chunks.length)
    const qas = this.#database
      .prepare(
        `SELECT id AS owner_id, question AS title, question AS text, answer AS excerpt, content_hash,
                embedding IS NOT NULL AS has_embedding
         FROM preset_qa
         WHERE (embedding IS NULL OR embedding_model_id != ? OR embedding_model_revision != ?
           OR embedding_dimension != ?)
           AND (
             EXISTS (SELECT 1 FROM legacy_qa_entries lq WHERE lq.preset_qa_id = preset_qa.id)
             OR EXISTS (
               SELECT 1 FROM project_qa_links pl
               WHERE pl.preset_qa_id = preset_qa.id AND pl.active = 1
             )
           )
           AND EXISTS (
             SELECT 1 FROM index_jobs j
             WHERE j.owner_type = 'preset_qa' AND j.owner_id = preset_qa.id
               AND j.content_hash = preset_qa.content_hash AND j.status IN ('pending', 'processing')
           )
         ORDER BY created_at, id LIMIT ?`,
      )
      .all(metadata.modelId, metadata.modelRevision, metadata.dimension, remaining) as Array<{
      owner_id: string
      title: string
      text: string
      excerpt: string
      content_hash: string
      has_embedding: number
    }>
    return [
      ...chunks.map((row) => ({
        ownerType: 'chunk' as const,
        ownerId: row.owner_id,
        documentId: row.document_id,
        title: row.title,
        text: row.text,
        excerpt: row.excerpt,
        contentHash: row.content_hash,
        hasEmbedding: row.has_embedding === 1,
      })),
      ...qas.map((row) => ({
        ownerType: 'preset_qa' as const,
        ownerId: row.owner_id,
        documentId: `preset:${row.owner_id}`,
        title: row.title,
        text: row.text,
        excerpt: row.excerpt,
        contentHash: row.content_hash,
        hasEmbedding: row.has_embedding === 1,
      })),
    ]
  }

  prepareEmbeddingJobs(metadata: EmbeddingMetadata, now = Date.now()): void {
    this.#write(() => {
      this.#database
        .prepare(
          `UPDATE index_jobs SET status = 'pending', available_at = ?, updated_at = ?
           WHERE owner_type = 'chunk' AND status = 'ready' AND EXISTS (
             SELECT 1 FROM chunks c WHERE c.id = index_jobs.owner_id AND c.content_hash = index_jobs.content_hash
               AND (c.embedding IS NULL OR c.embedding_model_id != ? OR c.embedding_model_revision != ?
                 OR c.embedding_dimension != ?)
               AND (
                 EXISTS (SELECT 1 FROM legacy_document_entries ld WHERE ld.document_id = c.document_id)
                 OR EXISTS (
                   SELECT 1 FROM project_document_links pl
                   WHERE pl.document_id = c.document_id AND pl.active = 1
                 )
                 OR EXISTS (
                   SELECT 1 FROM project_front_document_links pf
                   WHERE pf.document_id = c.document_id
                 )
               )
           )`,
        )
        .run(now, now, metadata.modelId, metadata.modelRevision, metadata.dimension)
      this.#database
        .prepare(
          `UPDATE index_jobs SET status = 'pending', last_error_code = NULL, available_at = ?, updated_at = ?
           WHERE status = 'failed' AND (
             last_model_id IS NULL OR last_model_id != ? OR last_model_revision IS NULL
             OR last_model_revision != ? OR last_embedding_dimension IS NULL OR last_embedding_dimension != ?
           ) AND (
             (owner_type = 'chunk' AND EXISTS (
               SELECT 1 FROM chunks c WHERE c.id = index_jobs.owner_id AND (
                 EXISTS (SELECT 1 FROM legacy_document_entries ld WHERE ld.document_id = c.document_id)
                 OR EXISTS (
                   SELECT 1 FROM project_document_links pl
                   WHERE pl.document_id = c.document_id AND pl.active = 1
                 )
                 OR EXISTS (
                   SELECT 1 FROM project_front_document_links pf
                   WHERE pf.document_id = c.document_id
                 )
               )
             )) OR (owner_type = 'preset_qa' AND EXISTS (
               SELECT 1 FROM preset_qa q WHERE q.id = index_jobs.owner_id AND (
                 EXISTS (SELECT 1 FROM legacy_qa_entries lq WHERE lq.preset_qa_id = q.id)
                 OR EXISTS (
                   SELECT 1 FROM project_qa_links pl
                   WHERE pl.preset_qa_id = q.id AND pl.active = 1
                 )
               )
             ))
           )`,
        )
        .run(now, now, metadata.modelId, metadata.modelRevision, metadata.dimension)
      this.#database
        .prepare(
          `UPDATE index_jobs SET status = 'pending', available_at = ?, updated_at = ?
           WHERE owner_type = 'preset_qa' AND status = 'ready' AND EXISTS (
             SELECT 1 FROM preset_qa q WHERE q.id = index_jobs.owner_id AND q.content_hash = index_jobs.content_hash
               AND (q.embedding IS NULL OR q.embedding_model_id != ? OR q.embedding_model_revision != ?
                 OR q.embedding_dimension != ?)
               AND (
                 EXISTS (SELECT 1 FROM legacy_qa_entries lq WHERE lq.preset_qa_id = q.id)
                 OR EXISTS (
                   SELECT 1 FROM project_qa_links pl
                   WHERE pl.preset_qa_id = q.id AND pl.active = 1
                 )
               )
           )`,
        )
        .run(now, now, metadata.modelId, metadata.modelRevision, metadata.dimension)
    })
  }

  recoverInterruptedIndexJobs(now = Date.now()): number {
    return this.#write(
      () =>
        this.#database
          .prepare(
            `UPDATE index_jobs SET status = 'pending', last_error_code = 'INTERRUPTED', available_at = ?, updated_at = ?
             WHERE status = 'processing'`,
          )
          .run(now, now).changes,
    )
  }

  failOwnerIndexing(
    ownerType: IndexOwnerType,
    ownerId: string,
    contentHash: string,
    errorCode: string,
    metadata: EmbeddingMetadata,
    now = Date.now(),
  ): boolean {
    const safeCode = errorCode.replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 80) || 'UNKNOWN'
    return this.#write(
      () =>
        this.#database
          .prepare(
            `UPDATE index_jobs SET status = 'failed', last_error_code = ?, updated_at = ?, available_at = ?,
               last_model_id = ?, last_model_revision = ?, last_embedding_dimension = ?
             WHERE owner_type = ? AND owner_id = ? AND content_hash = ?`,
          )
          .run(
            safeCode,
            now,
            Number.MAX_SAFE_INTEGER,
            metadata.modelId,
            metadata.modelRevision,
            metadata.dimension,
            ownerType,
            ownerId,
            contentHash,
          ).changes === 1,
    )
  }

  retryFailedIndexJobs(now = Date.now()): number {
    return this.#write(
      () =>
        this.#database
          .prepare(
            `UPDATE index_jobs SET status = 'pending', last_error_code = NULL, available_at = ?, updated_at = ?
             WHERE status = 'failed'`,
          )
          .run(now, now).changes,
    )
  }

  createSession(input: {
    readonly id: string
    readonly projectId?: string | null
    readonly mode: SessionMode
    readonly audioSource: AudioSource
    readonly status?: string
    readonly startedAt?: number
  }): SessionRecord {
    const startedAt = input.startedAt ?? Date.now()
    const projectId = input.projectId === undefined || input.projectId === null
      ? null
      : validateIdentifier(input.projectId, 'projectId')
    if (input.mode === 'qa' && projectId === null) throw new Error('New QA sessions require a projectId')
    return this.#write(() => {
      if (projectId !== null) this.#requireProject(projectId)
      this.#database
        .prepare(
          `INSERT INTO sessions(id, mode, audio_source, status, started_at, project_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.mode, input.audioSource, input.status ?? 'active', startedAt, projectId)
      return this.getSession(input.id) as SessionRecord
    })
  }

  createSessionForActiveProject(input: {
    readonly id: string
    readonly mode: SessionMode
    readonly audioSource: AudioSource
    readonly status?: string
    readonly startedAt?: number
  }): SessionRecord {
    const startedAt = input.startedAt ?? Date.now()
    return this.#write(() => {
      const projectId = this.getActiveProjectId()
      if (projectId === null) throw new Error('New capture sessions require an active project')
      if (projectId !== null) this.#requireProject(projectId)
      this.#database
        .prepare(
          `INSERT INTO sessions(id, mode, audio_source, status, started_at, project_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.mode, input.audioSource, input.status ?? 'active', startedAt, projectId)
      return this.getSession(input.id) as SessionRecord
    })
  }

  getSession(id: string): SessionRecord | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SqlSessionRow | undefined
    return row ? sessionFromRow(row) : null
  }

  endSession(id: string, status = 'complete', endedAt = Date.now()): boolean {
    return this.#write(
      () =>
        this.#database.prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?').run(status, endedAt, id)
          .changes === 1,
    )
  }

  /** Persists the full latest raw transcript without requiring a tokenizer or model. */
  upsertFrontDraft(
    input: {
      readonly id: string
      readonly sessionId: string
      readonly transcript: string
      readonly status?: 'capturing' | 'raw_ready' | 'failed'
    },
    now = Date.now(),
  ): FrontDraftRecord {
    const id = input.id.trim()
    const sessionId = input.sessionId.trim()
    if (!id || !sessionId) throw new Error('Front draft ID and session ID are required')
    const transcript = normalizeContent(input.transcript)
    const contentHash = sha256(transcript)
    const status = input.status ?? 'capturing'
    if (status !== 'capturing' && !transcript) throw new Error('A finalized front draft transcript must not be empty')
    return this.#write(() => {
      this.#database
        .prepare(
          `INSERT INTO front_drafts(
             id, session_id, transcript, content_hash, structured_markdown, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             session_id = excluded.session_id,
             transcript = excluded.transcript,
             content_hash = excluded.content_hash,
             structured_markdown = CASE
               WHEN front_drafts.content_hash = excluded.content_hash THEN front_drafts.structured_markdown
               ELSE NULL
             END,
             status = CASE
               WHEN front_drafts.content_hash = excluded.content_hash
                 AND front_drafts.status IN ('structured', 'complete') THEN front_drafts.status
               ELSE excluded.status
             END,
             updated_at = excluded.updated_at`,
        )
        .run(id, sessionId, transcript, contentHash, status, now, now)
      return this.getFrontDraft(id) as FrontDraftRecord
    })
  }

  getFrontDraft(id: string): FrontDraftRecord | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM front_drafts WHERE id = ?').get(id) as
      | SqlFrontDraftRow
      | undefined
    return row ? frontDraftFromRow(row) : null
  }

  getFrontDraftBySession(sessionId: string): FrontDraftRecord | null {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT * FROM front_drafts WHERE session_id = ?').get(sessionId) as
      | SqlFrontDraftRow
      | undefined
    return row ? frontDraftFromRow(row) : null
  }

  listRecoverableFrontDrafts(): readonly FrontDraftRecord[] {
    this.#assertOpen()
    return (
      this.#database
        .prepare("SELECT * FROM front_drafts WHERE status != 'complete' ORDER BY updated_at, id")
        .all() as SqlFrontDraftRow[]
    ).map(frontDraftFromRow)
  }

  markFrontDraftStructuring(id: string, expectedContentHash: string, now = Date.now()): FrontDraftRecord {
    return this.#write(() => {
      const result = this.#database
        .prepare(
          `UPDATE front_drafts SET status = 'structuring', updated_at = ?
           WHERE id = ? AND content_hash = ? AND status IN ('raw_ready', 'failed', 'structuring')`,
        )
        .run(now, id, expectedContentHash)
      if (result.changes !== 1) this.#throwFrontDraftConflict(id, expectedContentHash, 'structuring')
      return this.getFrontDraft(id) as FrontDraftRecord
    })
  }

  markFrontDraftStructured(
    id: string,
    expectedContentHash: string,
    structuredMarkdown: string,
    now = Date.now(),
  ): FrontDraftRecord {
    const markdown = validateNonEmpty(structuredMarkdown, 'structuredMarkdown')
    return this.#write(() => {
      const result = this.#database
        .prepare(
          `UPDATE front_drafts SET structured_markdown = ?, status = 'structured', updated_at = ?
           WHERE id = ? AND content_hash = ? AND status IN ('raw_ready', 'structuring', 'failed', 'structured')`,
        )
        .run(markdown, now, id, expectedContentHash)
      if (result.changes !== 1) this.#throwFrontDraftConflict(id, expectedContentHash, 'structured')
      return this.getFrontDraft(id) as FrontDraftRecord
    })
  }

  completeFrontDraft(id: string, now = Date.now()): FrontDraftRecord {
    return this.#write(() => {
      const current = this.getFrontDraft(id)
      if (!current) throw new Error('Front draft does not exist')
      if (current.status === 'complete') return current
      const result = this.#database
        .prepare(
          `UPDATE front_drafts SET status = 'complete', updated_at = ?
           WHERE id = ? AND status = 'structured' AND structured_markdown IS NOT NULL`,
        )
        .run(now, id)
      if (result.changes !== 1) throw new Error('Front draft must be structured before completion')
      return this.getFrontDraft(id) as FrontDraftRecord
    })
  }

  markFrontDraftFailed(id: string, expectedContentHash: string, now = Date.now()): FrontDraftRecord {
    return this.#write(() => {
      const result = this.#database
        .prepare(
          `UPDATE front_drafts SET status = 'failed', updated_at = ?
           WHERE id = ? AND content_hash = ? AND status != 'complete'`,
        )
        .run(now, id, expectedContentHash)
      if (result.changes !== 1) this.#throwFrontDraftConflict(id, expectedContentHash, 'failed')
      return this.getFrontDraft(id) as FrontDraftRecord
    })
  }

  #throwFrontDraftConflict(id: string, expectedContentHash: string, target: FrontDraftStatus): never {
    const current = this.getFrontDraft(id)
    if (!current) throw new Error('Front draft does not exist')
    if (current.contentHash !== expectedContentHash) {
      throw new Error('Refusing to update a stale front draft transcript')
    }
    throw new Error(`Front draft cannot transition from ${current.status} to ${target}`)
  }

  appendTurn(input: {
    readonly id: string
    readonly projectId?: string
    readonly sessionId: string
    readonly question: string
    readonly answer: string
    readonly sourceIds?: readonly string[]
    readonly createdAt?: number
  }): TurnRecord {
    const session = this.getSession(input.sessionId)
    if (!session) throw new Error('Turn session does not exist')
    const projectId = input.projectId === undefined
      ? session.projectId
      : validateIdentifier(input.projectId, 'projectId')
    const question = validateNonEmpty(input.question, 'question')
    const answer = validateBoundedText(input.answer, 'answer', MAX_QA_ANSWER_CHARACTERS)
    const sourceIds = [...(input.sourceIds ?? [])]
    return this.#write(() => {
      const existingRow = this.#database.prepare('SELECT * FROM turns WHERE id = ?').get(input.id) as
        | SqlTurnRow
        | undefined
      if (existingRow) {
        const existing = turnFromRow(existingRow)
        const identical =
          existing.projectId === projectId &&
          existing.sessionId === input.sessionId &&
          existing.question === question &&
          existing.answer === answer &&
          existing.sourceIds.length === sourceIds.length &&
          existing.sourceIds.every((sourceId, index) => sourceId === sourceIds[index])
        if (!identical) throw new Error('Turn ID already exists with conflicting content')
        return existing
      }
      if (!session || session.projectId !== projectId) throw new Error('Turn project does not match its session')
      const next = this.#database
        .prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM turns WHERE session_id = ?')
        .get(input.sessionId) as { ordinal: number }
      this.#database
        .prepare(
          `INSERT INTO turns(id, session_id, ordinal, question, answer, source_ids_json, created_at, project_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.sessionId,
          next.ordinal,
          question,
          answer,
          JSON.stringify(sourceIds),
          input.createdAt ?? Date.now(),
          projectId,
        )
      return turnFromRow(this.#database.prepare('SELECT * FROM turns WHERE id = ?').get(input.id) as SqlTurnRow)
    })
  }

  getRecentTurns(sessionId: string, limit = 5): readonly TurnRecord[] {
    this.#assertOpen()
    const rows = this.#database
      .prepare(
        `SELECT * FROM (
           SELECT * FROM turns WHERE session_id = ? ORDER BY ordinal DESC LIMIT ?
         ) ORDER BY ordinal`,
      )
      .all(sessionId, Math.max(1, Math.min(5, limit))) as SqlTurnRow[]
    return rows.map(turnFromRow)
  }

  getRecentProjectTurns(projectIdValue: string, sessionId: string, limit = 5): readonly TurnRecord[] {
    const projectId = validateIdentifier(projectIdValue, 'projectId')
    const session = this.getSession(sessionId)
    if (!session || session.projectId !== projectId) throw new Error('QA session does not belong to the project')
    const turns = this.getRecentTurns(sessionId, limit)
    if (turns.some((turn) => turn.projectId !== projectId)) {
      throw new Error('QA session contains mixed-project turns')
    }
    return turns
  }

  qaWorkspaceDataRevision(projectIdValue: string): number {
    this.#assertOpen()
    const projectId = validateIdentifier(projectIdValue, 'projectId')
    this.#requireProject(projectId)
    const row = this.#database
      .prepare('SELECT data_revision FROM qa_workspace_project_state WHERE project_id = ?')
      .get(projectId) as { data_revision: number } | undefined
    if (!row) throw new Error('QA workspace project state does not exist')
    return row.data_revision
  }

  legacyQaWorkspaceDataRevision(): number {
    this.#assertOpen()
    const row = this.#database
      .prepare('SELECT data_revision FROM qa_workspace_state WHERE singleton = 1')
      .get() as { data_revision: number }
    return row.data_revision
  }

  ensureQaRound(input: EnsureQaRoundInput): QaWorkspaceRound {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const roundId = validateBoundedText(input.roundId, 'roundId', MAX_QA_ROUND_ID_CHARACTERS)
    const sessionId = validateBoundedText(input.sessionId, 'sessionId', 256)
    const question = validateBoundedText(input.question, 'question', 4_000)
    const startedAt = validateTimestamp(input.startedAt ?? Date.now(), 'startedAt')
    return this.#write(() => {
      const existing = this.#getQaRoundRow(roundId)
      if (existing) {
        if (existing.session_id !== sessionId || existing.project_id !== projectId) {
          throw new Error('QA round ID already belongs to another session or project')
        }
        if (existing.question_preview !== question) {
          if (existing.status !== 'active') throw new Error('Cannot update the question preview of a locked or closed QA round')
          this.#database.prepare('UPDATE qa_rounds SET question_preview = ? WHERE id = ?').run(question, roundId)
          const updated = this.#getQaRoundRow(roundId) as SqlQaRoundRow
          assertWorkspaceRoundFitsPage(this.#hydrateQaRound(updated), this.qaWorkspaceDataRevision(projectId) + 1)
          this.#bumpWorkspaceRevision(projectId)
          return this.#hydrateQaRound(updated)
        }
        return this.#hydrateQaRound(existing)
      }
      const session = this.getSession(sessionId)
      if (!session || session.mode !== 'qa' || session.projectId !== projectId) {
        throw new Error('QA rounds require an existing QA session in the same project')
      }
      const next = this.#database
        .prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM qa_rounds WHERE session_id = ?')
        .get(sessionId) as { ordinal: number }
      this.#database
        .prepare(
          `INSERT INTO qa_rounds(
             id, session_id, ordinal, status, question_preview, started_at, completed_at,
             selected_answer_version_id, project_id
           ) VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, ?)`,
        )
        .run(roundId, sessionId, next.ordinal, question, startedAt, projectId)
      const inserted = this.#getQaRoundRow(roundId) as SqlQaRoundRow
      assertWorkspaceRoundFitsPage(this.#hydrateQaRound(inserted), this.qaWorkspaceDataRevision(projectId) + 1)
      this.#bumpWorkspaceRevision(projectId)
      return this.#hydrateQaRound(inserted)
    })
  }

  getQaRound(roundId: string): QaWorkspaceRound | null {
    this.#assertOpen()
    const row = this.#getQaRoundRow(roundId)
    return row ? this.#hydrateQaRound(row) : null
  }

  saveQaAnswerVersion(input: SaveQaAnswerVersionInput): SaveQaAnswerVersionResult {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const operationId = validateBoundedText(input.operationId, 'operationId', 256)
    const roundId = validateBoundedText(input.roundId, 'roundId', MAX_QA_ROUND_ID_CHARACTERS)
    const sessionId = validateBoundedText(input.sessionId, 'sessionId', 256)
    if (input.stage !== 'candidate' && input.stage !== 'final' && input.stage !== 'candidate_fallback') {
      throw new Error('stage is invalid')
    }
    const questionRevision = validateNonNegativeInteger(input.questionRevision, 'questionRevision')
    const questionSnapshot = validateBoundedText(input.questionSnapshot, 'questionSnapshot', 4_000)
    const questionIdentity = validateBoundedText(input.questionIdentity, 'questionIdentity', 512)
    const answer = validateBoundedText(input.answer, 'answer', MAX_QA_ANSWER_CHARACTERS)
    if (
      input.retrievalRoute !== 'preset_qa_exact' &&
      input.retrievalRoute !== 'preset_qa_semantic' &&
      input.retrievalRoute !== 'source_document'
    ) throw new Error('retrievalRoute is invalid')
    const sources = validateSourceReferences(input.sources)
    if (sources.length === 0) throw new Error('A complete QA answer version requires at least one source')
    const expectedKind = input.retrievalRoute === 'source_document' ? 'source_document' : 'preset_qa'
    if (sources.some((source) => source.kind !== expectedKind)) {
      throw new Error('Answer sources do not match the retrieval route')
    }
    if (expectedKind === 'preset_qa' && sources.length !== 1) {
      throw new Error('A preset QA answer version must reference exactly one preset answer')
    }
    const elapsedMs = validateNonNegativeInteger(input.elapsedMs, 'elapsedMs')
    const createdAt = validateTimestamp(input.createdAt, 'createdAt')
    const sourcesJson = JSON.stringify(sources)
    const contentFingerprint = answerVersionFingerprint({
      stage: input.stage,
      questionRevision,
      questionSnapshot,
      questionIdentity,
      answer,
      retrievalRoute: input.retrievalRoute,
      sources,
    })

    return this.#write(() => {
      const round = this.#getQaRoundRow(roundId)
      if (!round || round.session_id !== sessionId || round.project_id !== projectId) {
        throw new Error('QA round does not belong to the session and project')
      }
      const existingOperation = this.#database
        .prepare('SELECT * FROM qa_answer_versions WHERE operation_id = ?')
        .get(operationId) as SqlQaAnswerVersionRow | undefined
      if (existingOperation) {
        const identical =
          existingOperation.project_id === projectId &&
          existingOperation.round_id === roundId &&
          existingOperation.content_fingerprint === contentFingerprint
        if (!identical) throw new Error('QA answer operation ID already exists with conflicting content')
        const version = answerVersionFromRow(existingOperation)
        return { version, versionId: version.id, inserted: false, dataRevision: this.qaWorkspaceDataRevision(projectId) }
      }
      if (expectedKind === 'preset_qa') {
        const preset = this.getPresetQa(sources[0]?.id ?? '')
        if (
          !preset ||
          sources[0]?.documentId !== `preset:${preset.id}` ||
          normalizeContent(preset.answer) !== answer
        ) {
          throw new Error('A preset QA answer must match its reviewed source answer')
        }
      } else {
        const findChunk = this.#database.prepare('SELECT document_id FROM chunks WHERE id = ?')
        for (const source of sources) {
          const chunk = findChunk.get(source.id) as { document_id: string } | undefined
          if (!chunk || chunk.document_id !== source.documentId) {
            throw new Error('A source-document answer must reference existing document chunks')
          }
        }
      }
      const duplicate = this.#database
        .prepare('SELECT * FROM qa_answer_versions WHERE round_id = ? AND content_fingerprint = ?')
        .get(roundId, contentFingerprint) as SqlQaAnswerVersionRow | undefined
      if (duplicate) {
        const version = answerVersionFromRow(duplicate)
        return { version, versionId: version.id, inserted: false, dataRevision: this.qaWorkspaceDataRevision(projectId) }
      }
      if (round.status !== 'active' && round.status !== 'answer_locked') {
        throw new Error('Cannot save an answer version to a closed QA round')
      }
      if (round.status === 'answer_locked') {
        throw new Error('Cannot save another answer after the QA round is answer-locked')
      }
      const counts = this.#database
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN stage = 'candidate' THEN 1 ELSE 0 END) AS candidates,
                  MAX(question_revision) AS maximum_revision
           FROM qa_answer_versions WHERE round_id = ?`,
        )
        .get(roundId) as { total: number; candidates: number | null; maximum_revision: number | null }
      if (counts.total >= MAX_QA_ANSWER_VERSIONS) throw new Error('QA round answer-version capacity exceeded')
      if (input.stage === 'candidate' && (counts.candidates ?? 0) >= MAX_QA_CANDIDATE_VERSIONS) {
        throw new Error('QA round candidate-version capacity exceeded')
      }
      if (input.stage !== 'candidate' && (counts.maximum_revision ?? questionRevision) > questionRevision) {
        throw new Error('Cannot lock a stale QA question revision')
      }
      const previous = this.#database
        .prepare('SELECT answer FROM qa_answer_versions WHERE round_id = ? ORDER BY ordinal DESC LIMIT 1')
        .get(roundId) as { answer: string } | undefined
      const isSuperseded = counts.maximum_revision !== null && counts.maximum_revision > questionRevision
      this.#database
        .prepare(
          `UPDATE qa_answer_versions SET is_superseded = 1
           WHERE round_id = ? AND is_selected = 0 AND question_revision <= ?`,
        )
        .run(roundId, questionRevision)
      const versionId = stableId('answer_version', operationId)
      this.#database
        .prepare(
          `INSERT INTO qa_answer_versions(
             id, operation_id, round_id, ordinal, stage, question_revision, question_snapshot,
             question_identity, answer, retrieval_route, sources_json, elapsed_ms, created_at,
             is_selected, is_superseded, answer_unchanged, content_fingerprint, project_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          operationId,
          roundId,
          counts.total,
          input.stage,
          questionRevision,
          questionSnapshot,
          questionIdentity,
          answer,
          input.retrievalRoute,
          sourcesJson,
          elapsedMs,
          createdAt,
          isSuperseded ? 1 : 0,
          previous && normalizeContent(previous.answer) === answer ? 1 : 0,
          contentFingerprint,
          projectId,
        )
      if (!isSuperseded) {
        const nextStatus = input.stage === 'candidate' ? round.status : 'answer_locked'
        this.#database
          .prepare('UPDATE qa_rounds SET question_preview = ?, status = ? WHERE id = ?')
          .run(questionSnapshot, nextStatus, roundId)
      }
      const updatedRound = this.#getQaRoundRow(roundId) as SqlQaRoundRow
      assertWorkspaceRoundFitsPage(this.#hydrateQaRound(updatedRound), this.qaWorkspaceDataRevision(projectId) + 1)
      const dataRevision = this.#bumpWorkspaceRevision(projectId)
      const version = answerVersionFromRow(
        this.#database.prepare('SELECT * FROM qa_answer_versions WHERE id = ?').get(versionId) as SqlQaAnswerVersionRow,
      )
      return { version, versionId, inserted: true, dataRevision }
    })
  }

  commitQaRound(input: CommitQaRoundInput): CommitQaRoundResult {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const roundId = validateBoundedText(input.roundId, 'roundId', MAX_QA_ROUND_ID_CHARACTERS)
    const selectedAnswerVersionId = validateBoundedText(
      input.selectedAnswerVersionId,
      'selectedAnswerVersionId',
      256,
    )
    const turnId = validateBoundedText(input.turn.id, 'turn.id', 256)
    const sessionId = validateBoundedText(input.turn.sessionId, 'turn.sessionId', 256)
    const question = validateBoundedText(input.turn.question, 'turn.question', 4_000)
    const answer = validateBoundedText(input.turn.answer, 'turn.answer', MAX_QA_ANSWER_CHARACTERS)
    if (input.turn.answerOrigin !== 'final' && input.turn.answerOrigin !== 'candidate_fallback') {
      throw new Error('turn.answerOrigin is invalid')
    }
    const sourceIds = [...(input.turn.sourceIds ?? [])].map((sourceId, index) =>
      validateBoundedText(sourceId, `turn.sourceIds[${index}]`, 256),
    )
    if (sourceIds.length > MAX_QA_SOURCE_REFERENCES || new Set(sourceIds).size !== sourceIds.length) {
      throw new Error('turn.sourceIds are invalid')
    }
    const createdAt = validateTimestamp(input.turn.createdAt ?? Date.now(), 'turn.createdAt')
    return this.#write(() => {
      const round = this.#getQaRoundRow(roundId)
      if (!round || round.session_id !== sessionId || round.project_id !== projectId) {
        throw new Error('QA round does not belong to the turn session and project')
      }
      const selected = this.#database
        .prepare('SELECT * FROM qa_answer_versions WHERE id = ? AND round_id = ?')
        .get(selectedAnswerVersionId, roundId) as SqlQaAnswerVersionRow | undefined
      if (!selected) throw new Error('Selected QA answer version does not belong to the round')
      const selectedSources = parseSourceReferences(selected.sources_json).map((source) => source.id)
      if (
        normalizeQuestion(selected.question_snapshot) !== normalizeQuestion(question) ||
        normalizeContent(selected.answer) !== answer ||
        selectedSources.length !== sourceIds.length ||
        selectedSources.some((sourceId, index) => sourceId !== sourceIds[index])
      ) throw new Error('Turn content does not match the selected QA answer version')
      if (input.turn.answerOrigin === 'final' && selected.stage !== 'final') {
        throw new Error('A final turn must select a final answer version')
      }
      if (input.turn.answerOrigin === 'candidate_fallback' && selected.stage === 'final') {
        throw new Error('A candidate fallback turn cannot select a final answer version')
      }
      const existingTurn = this.#database.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as
        | SqlTurnRow
        | undefined
      if (round.status === 'completed') {
        if (
          round.selected_answer_version_id !== selectedAnswerVersionId ||
          !existingTurn ||
          !this.#turnMatchesCommit(existingTurn, { roundId, sessionId, question, answer, sourceIds,
            answerOrigin: input.turn.answerOrigin, selectedAnswerVersionId, projectId })
        ) throw new Error('QA round is already committed with conflicting content')
        return {
          round: this.#hydrateQaRound(round),
          turn: turnFromRow(existingTurn),
          dataRevision: this.qaWorkspaceDataRevision(projectId),
        }
      }
      if (round.status !== 'active' && round.status !== 'answer_locked') {
        throw new Error('Cannot commit a closed QA round')
      }
      if (existingTurn) throw new Error('Turn ID already exists with conflicting content')
      const next = this.#database
        .prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM turns WHERE session_id = ?')
        .get(sessionId) as { ordinal: number }
      this.#database
        .prepare(
          `INSERT INTO turns(
             id, session_id, ordinal, question, answer, source_ids_json, round_id, answer_origin,
             selected_answer_version_id, created_at, project_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turnId,
          sessionId,
          next.ordinal,
          question,
          answer,
          JSON.stringify(sourceIds),
          roundId,
          input.turn.answerOrigin,
          selectedAnswerVersionId,
          createdAt,
          projectId,
        )
      this.#database
        .prepare(
          `UPDATE qa_answer_versions SET
             is_selected = CASE WHEN id = ? THEN 1 ELSE 0 END,
             is_superseded = CASE WHEN id = ? THEN 0 ELSE 1 END
           WHERE round_id = ?`,
        )
        .run(selectedAnswerVersionId, selectedAnswerVersionId, roundId)
      this.#database
        .prepare(
          `UPDATE qa_rounds SET status = 'completed', completed_at = ?,
             selected_answer_version_id = ?, question_preview = ? WHERE id = ?`,
        )
        .run(createdAt, selectedAnswerVersionId, question, roundId)
      const updatedRound = this.#getQaRoundRow(roundId) as SqlQaRoundRow
      assertWorkspaceRoundFitsPage(this.#hydrateQaRound(updatedRound), this.qaWorkspaceDataRevision(projectId) + 1)
      const dataRevision = this.#bumpWorkspaceRevision(projectId)
      return {
        round: this.#hydrateQaRound(updatedRound),
        turn: turnFromRow(this.#database.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as SqlTurnRow),
        dataRevision,
      }
    })
  }

  closeQaRound(input: CloseQaRoundInput): CloseQaRoundResult {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const roundId = validateBoundedText(input.roundId, 'roundId', MAX_QA_ROUND_ID_CHARACTERS)
    const { status } = input
    if (status !== 'skipped' && status !== 'cancelled' && status !== 'interrupted' && status !== 'failed') {
      throw new Error('QA round close status is invalid')
    }
    const completedAt = validateTimestamp(input.completedAt ?? Date.now(), 'completedAt')
    return this.#write(() => {
      const round = this.#getQaRoundRow(roundId)
      if (!round) throw new Error('QA round does not exist')
      if (round.project_id !== projectId) throw new Error('QA round does not belong to the project')
      if (round.status === status) {
        return { round: this.#hydrateQaRound(round), dataRevision: this.qaWorkspaceDataRevision(projectId) }
      }
      if (round.status !== 'active' && round.status !== 'answer_locked') {
        throw new Error('QA round is already closed with another status')
      }
      this.#database
        .prepare('UPDATE qa_answer_versions SET is_selected = 0, is_superseded = 1 WHERE round_id = ?')
        .run(roundId)
      this.#database
        .prepare(
          `UPDATE qa_rounds SET status = ?, completed_at = ?, selected_answer_version_id = NULL
           WHERE id = ?`,
        )
        .run(status, completedAt, roundId)
      const dataRevision = this.#bumpWorkspaceRevision(projectId)
      return { round: this.#hydrateQaRound(this.#getQaRoundRow(roundId) as SqlQaRoundRow), dataRevision }
    })
  }

  getQaWorkspacePage(input: QaWorkspacePageInput): QaWorkspacePage {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    this.#requireProject(projectId)
    return this.#readQaWorkspacePage(projectId, input)
  }

  getLegacyQaWorkspacePage(input: LegacyQaWorkspacePageInput = {}): QaWorkspacePage {
    return this.#readQaWorkspacePage(null, input)
  }

  beginQaWorkspaceExport(projectIdValue: string): QaWorkspaceExportSnapshot {
    const projectId = validateIdentifier(projectIdValue, 'projectId')
    return { projectId, snapshotRevision: this.qaWorkspaceDataRevision(projectId) }
  }

  getQaWorkspaceExportPage(input: QaWorkspaceExportPageInput): QaWorkspacePage {
    const snapshotRevision = validateNonNegativeInteger(input.snapshotRevision, 'snapshotRevision')
    return this.getQaWorkspacePage({
      projectId: input.projectId,
      expectedDataRevision: snapshotRevision,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
  }

  #readQaWorkspacePage(
    projectId: string | null,
    input: LegacyQaWorkspacePageInput,
  ): QaWorkspacePage {
    this.#assertOpen()
    const read = this.#database.transaction((): QaWorkspacePage => {
    const limit = Math.max(1, Math.min(MAX_QA_WORKSPACE_PAGE_SIZE, input.limit ?? MAX_QA_WORKSPACE_PAGE_SIZE))
    const dataRevision = projectId === null
      ? this.legacyQaWorkspaceDataRevision()
      : this.qaWorkspaceDataRevision(projectId)
    if (
      input.expectedDataRevision !== undefined &&
      validateNonNegativeInteger(input.expectedDataRevision, 'expectedDataRevision') !== dataRevision
    ) throw new Error('QA_WORKSPACE_CURSOR_STALE')
    const cursor = input.cursor ? decodeWorkspaceCursor(input.cursor) : null
    if (
      cursor &&
      (!cursor.scopeDigest.equals(workspaceScopeDigest(projectId)) || cursor.dataRevision !== dataRevision)
    ) throw new Error('QA_WORKSPACE_CURSOR_STALE')
    const totalRounds = validateNonNegativeInteger(
      projectId === null
        ? (this.#database.prepare('SELECT COUNT(*) AS count FROM qa_rounds WHERE project_id IS NULL')
            .get() as { count: number }).count
        : (this.#database.prepare('SELECT COUNT(*) AS count FROM qa_rounds WHERE project_id = ?')
            .get(projectId) as { count: number }).count,
      'totalRounds',
    )
    const rows = projectId === null
      ? cursor
        ? (this.#database
            .prepare(
              `SELECT rowid AS cursor_rowid, * FROM qa_rounds
               WHERE project_id IS NULL AND (started_at < ? OR (started_at = ? AND rowid < ?))
               ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            )
            .all(cursor.startedAt, cursor.startedAt, cursor.rowid, limit + 1) as SqlQaRoundPageRow[])
        : (this.#database
            .prepare(
              `SELECT rowid AS cursor_rowid, * FROM qa_rounds
               WHERE project_id IS NULL ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            )
            .all(limit + 1) as SqlQaRoundPageRow[])
      : cursor
        ? (this.#database
            .prepare(
              `SELECT rowid AS cursor_rowid, * FROM qa_rounds
               WHERE project_id = ? AND (started_at < ? OR (started_at = ? AND rowid < ?))
               ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            )
            .all(projectId, cursor.startedAt, cursor.startedAt, cursor.rowid, limit + 1) as SqlQaRoundPageRow[])
        : (this.#database
            .prepare(
              `SELECT rowid AS cursor_rowid, * FROM qa_rounds
               WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            )
            .all(projectId, limit + 1) as SqlQaRoundPageRow[])
    const items: QaWorkspaceRound[] = []
    let lastIncluded: SqlQaRoundPageRow | null = null
    for (const [index, row] of rows.slice(0, limit).entries()) {
      const round = this.#hydrateQaRound(row)
      const hasMoreAfter = index + 1 < rows.length
      const proposed: QaWorkspacePage = {
        projectId,
        totalRounds,
        items: [...items, round],
        nextCursor: hasMoreAfter ? encodeWorkspaceCursor(row, projectId, dataRevision) : null,
        dataRevision,
      }
      if (workspacePageByteLength(proposed) > MAX_QA_WORKSPACE_PAGE_BYTES) {
        if (items.length === 0) throw new Error('QA round exceeds the workspace page byte budget')
        break
      }
      items.push(round)
      lastIncluded = row
    }
    const hasMore = lastIncluded !== null && items.length < rows.length
    const page: QaWorkspacePage = {
      projectId,
      totalRounds,
      items,
      nextCursor: hasMore && lastIncluded !== null
        ? encodeWorkspaceCursor(lastIncluded, projectId, dataRevision)
        : null,
      dataRevision,
    }
    if (workspacePageByteLength(page) > MAX_QA_WORKSPACE_PAGE_BYTES) {
      throw new Error('QA workspace page exceeds its byte budget')
    }
    return page
    })
    return read.deferred()
  }

  deleteQaWorkspaceRound(input: {
    readonly projectId: string
    readonly roundId: string
  }): DeleteQaWorkspaceRoundResult {
    const projectId = validateIdentifier(input.projectId, 'projectId')
    const roundId = validateBoundedText(input.roundId, 'roundId', MAX_QA_ROUND_ID_CHARACTERS)
    return this.#write(() => {
      this.#requireProject(projectId)
      const activeSession = this.#database
        .prepare('SELECT 1 FROM sessions WHERE project_id = ? AND ended_at IS NULL LIMIT 1').get(projectId)
      if (activeSession) throw new Error('Cannot delete QA history while a project session is active')
      const round = this.#getQaRoundRow(roundId)
      if (!round) return { deleted: false, dataRevision: this.qaWorkspaceDataRevision(projectId) }
      if (round.project_id !== projectId) throw new Error('QA round does not belong to the project')
      if (round.status === 'active' || round.status === 'answer_locked') {
        throw new Error('Cannot delete an open QA round')
      }
      this.#database.prepare('DELETE FROM turns WHERE round_id = ? AND project_id = ?').run(roundId, projectId)
      const deleted = this.#database.prepare('DELETE FROM qa_rounds WHERE id = ? AND project_id = ?')
        .run(roundId, projectId).changes === 1
      return { deleted, dataRevision: deleted
        ? this.#bumpWorkspaceRevision(projectId)
        : this.qaWorkspaceDataRevision(projectId) }
    })
  }

  clearQaWorkspaceProject(projectIdValue: string): ClearQaWorkspaceProjectResult {
    const projectId = validateIdentifier(projectIdValue, 'projectId')
    return this.#write(() => {
      this.#requireProject(projectId)
      const activeSession = this.#database
        .prepare('SELECT 1 FROM sessions WHERE project_id = ? AND ended_at IS NULL LIMIT 1').get(projectId)
      if (activeSession) throw new Error('Cannot clear QA history while a project session is active')
      const open = this.#database
        .prepare("SELECT 1 FROM qa_rounds WHERE project_id = ? AND status IN ('active', 'answer_locked') LIMIT 1")
        .get(projectId)
      if (open) throw new Error('Cannot clear a project while it contains an open QA round')
      const deletedTurns = this.#database.prepare('DELETE FROM turns WHERE project_id = ?').run(projectId).changes
      const deletedRounds = this.#database.prepare('DELETE FROM qa_rounds WHERE project_id = ?').run(projectId).changes
      const changed = deletedTurns > 0 || deletedRounds > 0
      return {
        deletedRounds,
        deletedTurns,
        dataRevision: changed ? this.#bumpWorkspaceRevision(projectId) : this.qaWorkspaceDataRevision(projectId),
      }
    })
  }

  assignLegacyQaSessionToProject(input: {
    readonly sessionId: string
    readonly projectId: string
  }): AssignLegacyQaSessionResult {
    const sessionId = validateBoundedText(input.sessionId, 'sessionId', 256)
    const projectId = validateIdentifier(input.projectId, 'projectId')
    return this.#write(() => {
      this.#requireProject(projectId)
      const session = this.getSession(sessionId)
      if (!session || session.mode !== 'qa') throw new Error('Legacy QA session does not exist')
      if (session.projectId !== null) throw new Error('QA session is already assigned to a project')
      const invalidRound = this.#database
        .prepare('SELECT 1 FROM qa_rounds WHERE session_id = ? AND project_id IS NOT NULL LIMIT 1').get(sessionId)
      const invalidTurn = this.#database
        .prepare('SELECT 1 FROM turns WHERE session_id = ? AND project_id IS NOT NULL LIMIT 1').get(sessionId)
      const invalidVersion = this.#database
        .prepare(
          `SELECT 1 FROM qa_answer_versions v JOIN qa_rounds r ON r.id = v.round_id
           WHERE r.session_id = ? AND v.project_id IS NOT NULL LIMIT 1`,
        ).get(sessionId)
      if (invalidRound || invalidTurn || invalidVersion) throw new Error('Legacy QA session has mixed project ownership')
      const rounds = (this.#database.prepare('SELECT COUNT(*) AS count FROM qa_rounds WHERE session_id = ?')
        .get(sessionId) as { count: number }).count
      const turns = (this.#database.prepare('SELECT COUNT(*) AS count FROM turns WHERE session_id = ?')
        .get(sessionId) as { count: number }).count
      const versions = (this.#database.prepare(
        `SELECT COUNT(*) AS count FROM qa_answer_versions v JOIN qa_rounds r ON r.id = v.round_id
         WHERE r.session_id = ?`,
      ).get(sessionId) as { count: number }).count
      this.#database.prepare('UPDATE sessions SET project_id = ? WHERE id = ? AND project_id IS NULL')
        .run(projectId, sessionId)
      this.#database.prepare('UPDATE qa_rounds SET project_id = ? WHERE session_id = ? AND project_id IS NULL')
        .run(projectId, sessionId)
      this.#database.prepare(
        `UPDATE qa_answer_versions SET project_id = ?
         WHERE project_id IS NULL AND round_id IN (SELECT id FROM qa_rounds WHERE session_id = ?)`,
      ).run(projectId, sessionId)
      this.#database.prepare('UPDATE turns SET project_id = ? WHERE session_id = ? AND project_id IS NULL')
        .run(projectId, sessionId)
      this.#bumpLegacyWorkspaceRevision()
      const dataRevision = this.#bumpWorkspaceRevision(projectId)
      return { rounds, turns, versions, dataRevision }
    })
  }

  claimIndexJobs(limit = 50, now = Date.now()): readonly IndexJobRecord[] {
    return this.#write(() => {
      const rows = this.#database
        .prepare(
          `SELECT * FROM index_jobs
           WHERE status IN ('pending', 'failed') AND available_at <= ?
           ORDER BY created_at, id LIMIT ?`,
        )
        .all(now, Math.max(1, limit)) as SqlIndexJobRow[]
      const mark = this.#database.prepare(
        `UPDATE index_jobs SET status = 'processing', attempt_count = attempt_count + 1,
           last_error_code = NULL, updated_at = ? WHERE id = ?`,
      )
      for (const row of rows) mark.run(now, row.id)
      return rows.map((row) =>
        indexJobFromRow({ ...row, status: 'processing', attempt_count: row.attempt_count + 1, updated_at: now }),
      )
    })
  }

  failIndexJob(id: string, errorCode: string, availableAt: number, now = Date.now()): boolean {
    const safeCode = errorCode.replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 80) || 'UNKNOWN'
    return this.#write(
      () =>
        this.#database
          .prepare(
            `UPDATE index_jobs SET status = 'failed', last_error_code = ?, available_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(safeCode, availableAt, now, id).changes === 1,
    )
  }

  listIndexJobs(): readonly IndexJobRecord[] {
    this.#assertOpen()
    return (this.#database.prepare('SELECT * FROM index_jobs ORDER BY created_at, id').all() as SqlIndexJobRow[]).map(
      indexJobFromRow,
    )
  }

  #getQaRoundRow(roundId: string): SqlQaRoundRow | null {
    const row = this.#database.prepare('SELECT * FROM qa_rounds WHERE id = ?').get(roundId) as
      | SqlQaRoundRow
      | undefined
    return row ?? null
  }

  #hydrateQaRound(row: SqlQaRoundRow): QaWorkspaceRound {
    const versions = (
      this.#database
        .prepare('SELECT * FROM qa_answer_versions WHERE round_id = ? ORDER BY ordinal LIMIT ?')
        .all(row.id, MAX_QA_ANSWER_VERSIONS) as SqlQaAnswerVersionRow[]
    ).map(answerVersionFromRow)
    return roundFromRow(row, versions)
  }

  #bumpWorkspaceRevision(projectId: string): number {
    this.#database
      .prepare('UPDATE qa_workspace_project_state SET data_revision = data_revision + 1 WHERE project_id = ?')
      .run(projectId)
    return this.qaWorkspaceDataRevision(projectId)
  }

  #bumpLegacyWorkspaceRevision(): number {
    this.#database
      .prepare('UPDATE qa_workspace_state SET data_revision = data_revision + 1 WHERE singleton = 1')
      .run()
    return this.legacyQaWorkspaceDataRevision()
  }

  #turnMatchesCommit(
    row: SqlTurnRow,
    expected: {
      readonly roundId: string
      readonly projectId: string
      readonly sessionId: string
      readonly question: string
      readonly answer: string
      readonly sourceIds: readonly string[]
      readonly answerOrigin: AnswerOrigin
      readonly selectedAnswerVersionId: string
    },
  ): boolean {
    const current = turnFromRow(row)
    return current.projectId === expected.projectId &&
      current.roundId === expected.roundId &&
      current.sessionId === expected.sessionId &&
      current.question === expected.question &&
      current.answer === expected.answer &&
      current.answerOrigin === expected.answerOrigin &&
      current.selectedAnswerVersionId === expected.selectedAnswerVersionId &&
      current.sourceIds.length === expected.sourceIds.length &&
      current.sourceIds.every((sourceId, index) => sourceId === expected.sourceIds[index])
  }

  #recoverOpenQaRounds(now: number): void {
    const recover = this.#database.transaction(() => {
      const open = this.#database
        .prepare("SELECT id, project_id FROM qa_rounds WHERE status IN ('active', 'answer_locked')")
        .all() as Array<{ id: string; project_id: string | null }>
      const activeSessions = (this.#database
        .prepare('SELECT COUNT(*) AS count FROM sessions WHERE ended_at IS NULL')
        .get() as { count: number }).count
      if (open.length === 0 && activeSessions === 0) return
      // A process restart makes every previously open capture session terminal,
      // including sessions that crashed before producing a meaningful round.
      // Otherwise the project-switch/delete transaction fences would remain
      // permanently locked by an orphan row.
      this.#database
        .prepare("UPDATE sessions SET status = 'interrupted', ended_at = ? WHERE ended_at IS NULL")
        .run(now)
      if (open.length === 0) return
      const markVersions = this.#database
        .prepare('UPDATE qa_answer_versions SET is_selected = 0, is_superseded = 1 WHERE round_id = ?')
      for (const row of open) markVersions.run(row.id)
      this.#database
        .prepare(
          `UPDATE qa_rounds SET status = 'interrupted', completed_at = ?, selected_answer_version_id = NULL
           WHERE status IN ('active', 'answer_locked')`,
        )
        .run(now)
      const projects = new Set(open.map((row) => row.project_id))
      for (const projectId of projects) {
        if (projectId === null) this.#bumpLegacyWorkspaceRevision()
        else this.#bumpWorkspaceRevision(projectId)
      }
    })
    recover.immediate()
  }

  #requireProject(projectId: string): ProjectRecord {
    const project = this.getProject(projectId)
    if (!project) throw new Error('Project does not exist')
    return project
  }

  #markLegacyDocument(documentId: string): void {
    this.#database.prepare('INSERT OR IGNORE INTO legacy_document_entries(document_id) VALUES (?)').run(documentId)
  }

  #markLegacyPresetQa(presetQaId: string): void {
    this.#database.prepare('INSERT OR IGNORE INTO legacy_qa_entries(preset_qa_id) VALUES (?)').run(presetQaId)
  }

  #hydrateProjectSourceTask(row: SqlProjectSourceFileRow): ProjectSourceTaskRecord {
    const revision = this.#database
      .prepare(
        `SELECT conversion_mode FROM source_revisions WHERE source_id = ? AND conversion_mode IS NOT NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(row.source_id) as { conversion_mode: ProjectSourceTaskRecord['currentConversionMode'] } | undefined
    const run = this.#database
      .prepare(
        `SELECT run_id FROM sync_runs WHERE project_id = ? AND generation = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(row.project_id, row.last_seen_generation) as { run_id: string } | undefined
    return {
      ...projectSourceFromRow(row),
      latestRunId: run?.run_id ?? null,
      currentConversionMode: revision?.conversion_mode ?? null,
      lastGoodAvailable: row.last_good_revision_id !== null,
    }
  }

  #bumpGlobalProjectRevision(): number {
    this.#database
      .prepare('UPDATE project_state SET data_revision = data_revision + 1 WHERE singleton = 1')
      .run()
    return this.projectDataRevision()
  }

  #mergeProjectSyncCounts(
    current: ProjectSyncCounts,
    updates?: Partial<ProjectSyncCounts>,
  ): ProjectSyncCounts {
    if (!updates) return current
    const merged = { ...current }
    for (const key of Object.keys(EMPTY_PROJECT_SYNC_COUNTS) as Array<keyof ProjectSyncCounts>) {
      const value = updates[key]
      if (value === undefined) continue
      merged[key] = validateNonNegativeInteger(value, `finalCounts.${key}`)
    }
    return merged
  }

  #bumpProjectRevision(projectId: string, now: number): void {
    this.#database
      .prepare('UPDATE projects SET data_revision = data_revision + 1, updated_at = ? WHERE id = ?')
      .run(now, projectId)
    this.#bumpGlobalProjectRevision()
  }

  #validateProjectObservations(
    observations: readonly ProjectScanObservation[],
  ): ReadonlyArray<{
    readonly trustKind: ProjectSourceFileRecord['trustKind']
    readonly displayRelativePath: string
    readonly pathKey: string
    readonly categoryHint: ProjectSourceFileRecord['categoryHint']
    readonly sizeBytes: number
    readonly mtimeNs: string
    readonly deviceId: string | null
    readonly inode: string | null
    readonly rawSha256: string | null
    readonly detectedType: string
    readonly conversionDisposition: ProjectSourceFileRecord['conversionDisposition']
    readonly blockedReason: string | null
  }> {
    if (observations.length > 2_000) throw new Error('Project scan contains more than 2000 files')
    const keys = new Set<string>()
    let totalBytes = 0
    return observations.map((observation) => {
      const displayRelativePath = validateRelativeProjectPath(observation.displayRelativePath, 'displayRelativePath')
      const pathKey = validateRelativeProjectPath(observation.pathKey, 'pathKey')
      const key = `${observation.trustKind}:${pathKey}`
      if (keys.has(key)) throw new Error('Project scan contains a duplicate path key')
      keys.add(key)
      const sizeBytes = validateNonNegativeInteger(observation.sizeBytes, 'sizeBytes')
      totalBytes += sizeBytes
      if (!Number.isSafeInteger(totalBytes) || totalBytes > 2 * 1024 * 1024 * 1024) {
        throw new Error('Project scan exceeds its 2 GiB probe budget')
      }
      const blockedReason = validateOptionalErrorCode(observation.blockedReason, 'blockedReason')
      const rawSha256 = observation.rawSha256 === undefined || observation.rawSha256 === null
        ? null
        : validateSha256(observation.rawSha256, 'rawSha256')
      const conversionDisposition = observation.conversionDisposition ?? (blockedReason ? 'unsupported' : 'local')
      if (conversionDisposition === 'local' && (rawSha256 === null || blockedReason !== null)) {
        throw new Error('A local scan observation requires a content hash and no blocking reason')
      }
      if (conversionDisposition !== 'local' && blockedReason === null) {
        throw new Error('A non-local scan observation requires a blocking reason')
      }
      return {
        trustKind: observation.trustKind,
        displayRelativePath,
        pathKey,
        categoryHint: observation.categoryHint ?? null,
        sizeBytes,
        mtimeNs: validateMtimeNs(observation.mtimeNs),
        deviceId: observation.deviceId?.trim() || null,
        inode: observation.inode?.trim() || null,
        rawSha256,
        detectedType: validateBoundedText(observation.detectedType, 'detectedType', 128),
        conversionDisposition,
        blockedReason,
      }
    })
  }

  #insertObservedRevision(
    sourceId: string,
    rawSha256: string,
    sizeBytes: number,
    detectedType: string,
    generation: number,
    now: number,
  ): string {
    const revisionId = stableId('revision', `${sourceId}:${rawSha256}:${generation}`)
    this.#database
      .prepare(
        `INSERT INTO source_revisions(
          revision_id, source_id, raw_sha256, size_bytes, detected_type, generation, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'observed', ?)`,
      )
      .run(revisionId, sourceId, rawSha256, sizeBytes, detectedType, generation, now)
    return revisionId
  }

  #updateBlockedSource(
    source: SqlProjectSourceFileRow,
    observation: {
      readonly displayRelativePath: string
      readonly sizeBytes: number
      readonly mtimeNs: string
      readonly deviceId: string | null
      readonly inode: string | null
      readonly rawSha256: string | null
      readonly detectedType: string
      readonly conversionDisposition: ProjectSourceFileRecord['conversionDisposition']
      readonly categoryHint: ProjectSourceFileRecord['categoryHint']
      readonly blockedReason: string | null
    },
    generation: number,
    now: number,
  ): void {
    this.#database
      .prepare(
        `UPDATE source_files SET display_relative_path = ?, size_bytes = ?, mtime_ns = ?, device_id = ?,
           inode = ?, detected_type = ?, conversion_disposition = ?, category_hint = ?, observed_raw_sha256 = ?,
           last_seen_generation = ?, state = 'blocked', error_code = ?, missing_since_generation = NULL,
           tombstoned_at = NULL, updated_at = ? WHERE source_id = ?`,
      )
      .run(
        observation.displayRelativePath, observation.sizeBytes, observation.mtimeNs, observation.deviceId,
        observation.inode, observation.detectedType, observation.conversionDisposition,
        observation.categoryHint, observation.rawSha256, generation,
        observation.blockedReason, now, source.source_id,
      )
  }

  #recordChangedSource(
    source: SqlProjectSourceFileRow,
    observation: {
      readonly displayRelativePath: string
      readonly sizeBytes: number
      readonly mtimeNs: string
      readonly deviceId: string | null
      readonly inode: string | null
      readonly rawSha256: string | null
      readonly detectedType: string
      readonly conversionDisposition: ProjectSourceFileRecord['conversionDisposition']
      readonly categoryHint: ProjectSourceFileRecord['categoryHint']
    },
    generation: number,
    now: number,
  ): string {
    if (observation.rawSha256 === null) throw new Error('Changed source is missing its content hash')
    const revisionId = this.#insertObservedRevision(
      source.source_id, observation.rawSha256, observation.sizeBytes, observation.detectedType, generation, now,
    )
    this.#database
      .prepare(
        `UPDATE source_files SET display_relative_path = ?, size_bytes = ?, mtime_ns = ?, device_id = ?,
           inode = ?, observed_raw_sha256 = ?, detected_type = ?, conversion_disposition = ?, category_hint = ?, last_seen_generation = ?,
           state = 'needs_conversion', error_code = NULL, missing_since_generation = NULL,
           tombstoned_at = NULL, updated_at = ? WHERE source_id = ?`,
      )
      .run(
        observation.displayRelativePath, observation.sizeBytes, observation.mtimeNs, observation.deviceId,
        observation.inode, observation.rawSha256, observation.detectedType, observation.conversionDisposition,
        observation.categoryHint,
        generation, now, source.source_id,
      )
    return revisionId
  }

  #requirePublishedConversion(
    operationId: string,
    artifactId: string,
    contentKind: ConversionArtifactRecord['contentKind'],
  ): ConversionJobRecord {
    const job = this.getConversionJob(operationId)
    const artifact = this.getConversionArtifact(artifactId)
    if (!job || !artifact || job.artifactId !== artifactId || artifact.revisionId !== job.revisionId) {
      throw new Error('Conversion artifact does not belong to its operation')
    }
    if (artifact.contentKind !== contentKind) throw new Error('Conversion artifact has the wrong content kind')
    if (job.state !== 'published_fs' && job.state !== 'committed') {
      throw new Error('Only a published conversion artifact may be committed')
    }
    if (job.state === 'published_fs') this.#assertConversionInputStillCurrent(job)
    return job
  }

  #assertConversionInputStillCurrent(job: ConversionJobRecord): void {
    const project = this.#requireProject(job.projectId)
    if (project.scanGeneration === job.generation) return
    const source = this.getProjectSource(job.sourceId)
    const activeRevision = source?.activeRevisionId
      ? this.getProjectSourceRevision(source.activeRevisionId)
      : null
    if (
      !source || source.observedRawSha256 !== job.inputSha256 ||
      (activeRevision !== null && activeRevision.generation > job.generation)
    ) throw new Error('Stale conversion generation no longer matches the current source input')
  }

  #assertPublishedArtifactHashes(
    job: ConversionJobRecord,
    artifact: ConversionArtifactRecord,
    outputSha256: string,
    canonicalBodySha256: string,
  ): void {
    if (job.outputSha256 !== outputSha256 || artifact.outputSha256 !== outputSha256) {
      throw new Error('Published output hash does not match the conversion artifact')
    }
    if (artifact.canonicalBodySha256 !== null && artifact.canonicalBodySha256 !== canonicalBodySha256) {
      throw new Error('Canonical body hash conflicts with the committed artifact')
    }
  }

  #setArtifactCanonicalBodyHash(artifactId: string, canonicalBodySha256: string, now: number): void {
    this.#database
      .prepare(
        `UPDATE conversion_artifacts SET canonical_body_sha256 = COALESCE(canonical_body_sha256, ?), updated_at = ?
         WHERE artifact_id = ?`,
      )
      .run(canonicalBodySha256, now, artifactId)
  }

  #completeProjectArtifact(job: ConversionJobRecord, artifactId: string, now: number): void {
    this.#database
      .prepare("UPDATE source_revisions SET state = 'committed', activated_at = ?, error_code = NULL WHERE revision_id = ?")
      .run(now, job.revisionId)
    this.#database
      .prepare(
        `UPDATE source_revisions SET state = 'superseded'
         WHERE source_id = ? AND revision_id != ? AND state = 'committed'`,
      )
      .run(job.sourceId, job.revisionId)
    this.#database
      .prepare(
        `UPDATE source_files SET active_revision_id = ?, last_good_revision_id = ?, state = 'embedding_pending',
           error_code = NULL, updated_at = ? WHERE source_id = ?`,
      )
      .run(job.revisionId, job.revisionId, now, job.sourceId)
    this.#database
      .prepare(
        `UPDATE conversion_artifacts SET validation_state = 'committed', committed_at = ?, updated_at = ?
         WHERE artifact_id = ?`,
      )
      .run(now, now, artifactId)
    this.#database
      .prepare("UPDATE conversion_jobs SET state = 'committed', error_code = NULL, updated_at = ? WHERE operation_id = ?")
      .run(now, job.operationId)
    this.#database
      .prepare(
        `UPDATE projects SET knowledge_version = knowledge_version + 1,
           data_revision = data_revision + 1, updated_at = ? WHERE id = ?`,
      )
      .run(now, job.projectId)
    this.#bumpGlobalProjectRevision()
  }

  #setArtifactOutputMetadata(
    artifactId: string,
    input: {
      readonly outputSizeBytes?: number
      readonly outputMtimeNs?: string
      readonly outputDeviceId?: string
      readonly outputInode?: string
    },
    now: number,
  ): void {
    if (
      input.outputSizeBytes === undefined && input.outputMtimeNs === undefined &&
      input.outputDeviceId === undefined && input.outputInode === undefined
    ) return
    const size = input.outputSizeBytes === undefined ? null : validateNonNegativeInteger(input.outputSizeBytes, 'outputSizeBytes')
    const mtime = input.outputMtimeNs === undefined ? null : validateMtimeNs(input.outputMtimeNs)
    this.#database
      .prepare(
        `UPDATE conversion_artifacts SET output_size_bytes = ?, output_mtime_ns = ?, output_device_id = ?,
           output_inode = ?, updated_at = ? WHERE artifact_id = ?`,
      )
      .run(size, mtime, input.outputDeviceId?.trim() || null, input.outputInode?.trim() || null, now, artifactId)
  }

  #terminalizeConversionJob(
    operationId: string,
    state: Extract<ConversionJobState, 'failed' | 'cancelled'>,
    errorCode: string | null,
    now: number,
  ): ConversionJobRecord {
    validateIdentifier(operationId, 'operationId')
    const normalizedError = validateOptionalErrorCode(errorCode)
    if (state === 'failed' && normalizedError === null) throw new Error('A failed conversion requires an error code')
    return this.#write(() => {
      const job = this.getConversionJob(operationId)
      if (!job) throw new Error('Conversion job does not exist')
      if (job.state === state && job.errorCode === normalizedError) return job
      if (job.state === 'failed' || job.state === 'cancelled') {
        throw new Error('Conversion job is already terminal')
      }
      if (job.state === 'committed') throw new Error('A committed conversion job cannot become terminal failure')
      this.#database
        .prepare('UPDATE conversion_jobs SET state = ?, error_code = ?, updated_at = ? WHERE operation_id = ?')
        .run(state, normalizedError, now, operationId)
      this.#database
        .prepare("UPDATE source_revisions SET state = 'failed', error_code = ? WHERE revision_id = ?")
        .run(normalizedError, job.revisionId)
      if (job.artifactId) {
        this.#database
          .prepare("UPDATE conversion_artifacts SET validation_state = 'failed', updated_at = ? WHERE artifact_id = ?")
          .run(now, job.artifactId)
      }
      this.#database
        .prepare(
          `UPDATE source_files SET state = ?, error_code = ?, updated_at = ? WHERE source_id = ?`,
        )
        .run(state === 'failed' ? 'conversion_failed' : 'needs_conversion', normalizedError, now, job.sourceId)
      this.#bumpProjectRevision(job.projectId, now)
      return this.getConversionJob(operationId) as ConversionJobRecord
    })
  }

  #assertProjectQaCommitHasNoConflicts(
    projectId: string,
    sourceId: string,
    inputs: readonly PresetQaInput[],
  ): void {
    const findActive = this.#database.prepare(
      `SELECT q.answer, l.source_id FROM preset_qa q
       JOIN project_qa_links l ON l.preset_qa_id = q.id AND l.active = 1
       JOIN source_files s ON s.source_id = l.source_id
       WHERE s.project_id = ? AND q.normalized_question = ?`,
    )
    for (const input of inputs) {
      const normalized = normalizeQuestion(input.question)
      const rows = findActive.all(projectId, normalized) as Array<{ answer: string; source_id: string }>
      if (rows.some((row) => row.source_id !== sourceId && row.answer !== input.answer)) {
        throw new Error('Preset QA artifact conflicts with another active project source')
      }
    }
  }

  /**
   * Knowledge publication and session start share the same SQLite writer and
   * therefore serialize under BEGIN IMMEDIATE.  Keeping this check inside the
   * publication transaction closes the facade preflight TOCTOU window.
   *
   * A structured-front publication may name its own producing session.  That
   * session is ended in the same transaction before the knowledge link is
   * published; every other live session for the project still blocks it.
   */
  #assertProjectKnowledgeMutationAllowed(projectId: string, producingSessionId?: string): void {
    const activeSession = producingSessionId === undefined
      ? this.#database
          .prepare('SELECT id FROM sessions WHERE project_id = ? AND ended_at IS NULL LIMIT 1')
          .get(projectId)
      : this.#database
          .prepare('SELECT id FROM sessions WHERE project_id = ? AND ended_at IS NULL AND id != ? LIMIT 1')
          .get(projectId, producingSessionId)
    if (activeSession) throw new Error('PROJECT_SESSION_ACTIVE')
  }

  #upsertProjectPresetQaInsideTransaction(
    projectId: string,
    input: PresetQaInput,
    now: number,
  ): PresetQaUpsertResult {
    const question = validateNonEmpty(input.question, 'question')
    const answer = validateNonEmpty(input.answer, 'answer')
    const normalized = normalizeQuestion(question)
    const contentHash = sha256(`${normalized}\n${answer}`)
    const existing = this.#database
      .prepare('SELECT q.* FROM preset_qa q WHERE q.normalized_question = ? AND q.answer = ? ORDER BY q.id LIMIT 1')
      .get(normalized, answer) as SqlPresetQaRow | undefined
    if (existing) return { record: presetQaFromRow(existing), inserted: false, contentChanged: false }
    const id = stableId('qa', `${projectId}:${normalized}:${contentHash}`)
    this.#database
      .prepare(
        `INSERT INTO preset_qa(id, question, normalized_question, answer, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, question, normalized, answer, contentHash, now, now)
    this.#enqueueIndexJob('preset_qa', id, 'upsert', contentHash, now)
    return { record: this.getPresetQa(id) as PresetQaRecord, inserted: true, contentChanged: true }
  }

  #enqueueIndexJob(
    ownerType: IndexOwnerType,
    ownerId: string,
    operation: 'upsert' | 'delete',
    contentHash: string,
    now: number,
  ): void {
    const id = stableId('job', `${ownerType}:${ownerId}:${operation}:${contentHash}`)
    this.#database
      .prepare(
        `INSERT INTO index_jobs(
          id, owner_type, owner_id, operation, content_hash, status, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(owner_type, owner_id, operation, content_hash)
        DO UPDATE SET status = CASE WHEN index_jobs.status = 'ready' THEN 'ready' ELSE 'pending' END,
          available_at = excluded.available_at, updated_at = excluded.updated_at`,
      )
      .run(id, ownerType, ownerId, operation, contentHash, now, now, now)
  }

  #simulationProjectRevision(projectId: string): number {
    this.#assertOpen()
    const row = this.#database
      .prepare('SELECT data_revision FROM simulation_project_state WHERE project_id = ?')
      .get(projectId) as { data_revision: number } | undefined
    if (!row) throw new Error('Simulation project state does not exist')
    return validateNonNegativeInteger(row.data_revision, 'simulationProjectDataRevision')
  }

  #bumpSimulationProjectRevision(projectId: string): number {
    this.#database
      .prepare('UPDATE simulation_project_state SET data_revision = data_revision + 1 WHERE project_id = ?')
      .run(projectId)
    return this.#simulationProjectRevision(projectId)
  }

  #getSimulationCheckpoint(operationId: string): SqlSimulationCheckpointRow | null {
    this.#assertOpen()
    return (this.#database.prepare('SELECT * FROM simulation_checkpoints WHERE operation_id = ?').get(operationId) as
      | SqlSimulationCheckpointRow
      | undefined) ?? null
  }

  #insertSimulationCheckpoint(
    operationId: string,
    jobId: string,
    kind: SqlSimulationCheckpointRow['kind'],
    contentFingerprint: string,
    resultDataRevision: number,
    createdAt: number,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO simulation_checkpoints(
           operation_id, job_id, kind, content_fingerprint, result_data_revision, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(operationId, jobId, kind, contentFingerprint, resultDataRevision, createdAt)
  }

  #requireSimulationJob(projectId: string, jobId: string): SimulationJobRecord {
    const job = this.getSimulationJob(projectId, jobId)
    if (!job) throw new Error('Simulation job does not belong to the project')
    return job
  }

  #assertSimulationJobFence(job: SimulationJobRecord): void {
    const fence = this.getProjectSimulationFence(job.projectId)
    if (
      fence.knowledgeVersion !== job.knowledgeVersion ||
      fence.sourceManifestHash !== job.sourceManifestHash ||
      fence.sourceCount !== job.sourceCount
    ) throw new Error('SIMULATION_KNOWLEDGE_STALE')
  }

  #assertSimulationStatusTransition(job: SimulationJobRecord, nextStatus: SimulationJobStatus): void {
    const allowed: Readonly<Record<SimulationJobStatus, readonly SimulationJobStatus[]>> = {
      draft: ['queued', 'cancelled', 'stale'],
      awaiting_large_run_confirmation: ['draft', 'cancelled', 'stale'],
      queued: ['running', 'paused', 'cancelled', 'failed', 'stale'],
      running: ['paused', 'completed', 'completed_with_gaps', 'cancelled', 'failed', 'stale'],
      paused: ['queued', 'running', 'cancelled', 'failed', 'stale'],
      completed: [],
      completed_with_gaps: [],
      failed: [],
      cancelled: [],
      stale: [],
    }
    if (!allowed[job.status].includes(nextStatus)) {
      throw new Error(`Simulation status cannot transition from ${job.status} to ${nextStatus}`)
    }
  }

  #hydrateSimulationItem(row: SqlSimulationItemRow): SimulationItemRecord {
    const citationRows = this.#database
      .prepare('SELECT * FROM simulation_citations WHERE item_id = ? ORDER BY ordinal')
      .all(row.item_id) as SqlSimulationCitationRow[]
    return simulationItemFromRow(row, citationRows.map(simulationCitationFromRow))
  }

  #requireSimulationItem(jobId: string, itemId: string): SimulationItemRecord {
    const row = this.#database
      .prepare('SELECT * FROM simulation_items WHERE job_id = ? AND item_id = ?')
      .get(jobId, itemId) as SqlSimulationItemRow | undefined
    if (!row) throw new Error('Simulation item does not belong to the job')
    return this.#hydrateSimulationItem(row)
  }

  #assertSimulationCitation(projectId: string, citation: SimulationCitationInput): string {
    const chunk = this.#database
      .prepare(
        `SELECT c.document_id, c.content, c.content_hash, d.title
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE c.id = ? AND c.document_id = ?`,
      )
      .get(citation.chunkId, citation.documentId) as {
        document_id: string
        content: string
        content_hash: string
        title: string
      } | undefined
    if (
      !chunk || chunk.content_hash !== citation.contentHash ||
      !normalizeContent(chunk.content).includes(normalizeContent(citation.excerpt))
    ) throw new Error('Simulation citation does not match its canonical chunk')
    if (citation.sourceId === undefined || citation.sourceId === null) {
      if (citation.sourceRevisionId !== undefined && citation.sourceRevisionId !== null) {
        throw new Error('Front simulation citations cannot have a source revision')
      }
      const front = this.#database
        .prepare(
          `SELECT 1 FROM project_front_document_links
           WHERE project_id = ? AND document_id = ? LIMIT 1`,
        )
        .get(projectId, citation.documentId)
      if (!front) throw new Error('Simulation citation is not an active project front document')
      return chunk.title
    }
    if (citation.sourceRevisionId === undefined || citation.sourceRevisionId === null) {
      throw new Error('Project simulation citations require a source revision')
    }
    const source = this.#database
      .prepare(
        `SELECT 1 FROM project_document_links l JOIN source_files s ON s.source_id = l.source_id
         WHERE s.project_id = ? AND l.source_id = ? AND s.active_revision_id = ?
           AND l.document_id = ? AND l.active = 1 LIMIT 1`,
      )
      .get(projectId, citation.sourceId, citation.sourceRevisionId, citation.documentId)
    if (!source) throw new Error('Simulation citation is not an active project source revision')
    return chunk.title
  }

  #loadSimulationBatchResult(
    projectId: string,
    jobId: string,
    operationId: string,
    inserted: boolean,
  ): SimulationBatchCommitResult {
    const row = this.#database
      .prepare('SELECT * FROM simulation_batches WHERE operation_id = ? AND job_id = ?')
      .get(operationId, jobId) as SqlSimulationBatchRow | undefined
    if (!row) throw new Error('Simulation batch checkpoint is inconsistent')
    const itemRows = this.#database
      .prepare('SELECT * FROM simulation_items WHERE batch_id = ? ORDER BY ordinal')
      .all(row.batch_id) as SqlSimulationItemRow[]
    const gapRows = this.#database
      .prepare('SELECT * FROM simulation_gaps WHERE batch_id = ? ORDER BY ordinal')
      .all(row.batch_id) as SqlSimulationGapRow[]
    return {
      batch: simulationBatchFromRow(row),
      job: this.#requireSimulationJob(projectId, jobId),
      items: itemRows.map((item) => this.#hydrateSimulationItem(item)),
      gaps: gapRows.map(simulationGapFromRow),
      inserted,
    }
  }

  #listSimulationPublicationItemRows(publicationId: string): ReadonlyArray<{
    readonly item_id: string
    readonly preset_qa_id: string | null
  }> {
    return this.#database
      .prepare(
        `SELECT item_id, preset_qa_id FROM simulation_publication_items
         WHERE publication_id = ? ORDER BY ordinal`,
      )
      .all(publicationId) as Array<{ item_id: string; preset_qa_id: string | null }>
  }

  #requireSimulationPublication(jobId: string, publicationId: string): SimulationPublicationRecord {
    const row = this.#database
      .prepare('SELECT * FROM simulation_publications WHERE job_id = ? AND publication_id = ?')
      .get(jobId, publicationId) as SqlSimulationPublicationRow | undefined
    if (!row) throw new Error('Simulation publication does not belong to the job')
    const links = this.#listSimulationPublicationItemRows(publicationId)
    return simulationPublicationFromRow(
      row,
      links.map((link) => link.item_id),
      links.flatMap((link) => link.preset_qa_id === null ? [] : [link.preset_qa_id]),
    )
  }

  #loadSimulationPublicationBundle(
    projectId: string,
    jobId: string,
    publicationId: string,
    inserted: boolean,
  ): SimulationPublicationBundle {
    const publication = this.#requireSimulationPublication(jobId, publicationId)
    return {
      publication,
      job: this.#requireSimulationJob(projectId, jobId),
      items: publication.itemIds.map((itemId) => this.#requireSimulationItem(jobId, itemId)),
      inserted,
    }
  }

  #loadSimulationPublicationDraftBundle(
    projectId: string,
    jobId: string,
    publicationId: string,
    inserted: boolean,
  ): SimulationPublicationDraftBundle {
    const bundle = this.#loadSimulationPublicationBundle(projectId, jobId, publicationId, inserted)
    const canonicalMarkdown = bundle.items
      .map((item) => `## 问题：${item.question}\n\n### 答案\n\n${item.answer}`)
      .join('\n\n')
    const parsed = validateAndDedupeQa(parseStructuredQaDocument(canonicalMarkdown, 'markdown').items)
    if (
      parsed.length !== bundle.items.length || parsed.some((item, index) => {
        const expected = bundle.items[index]
        return !expected || normalizeQuestion(item.question) !== normalizeQuestion(expected.question) ||
          normalizeContent(item.answer) !== normalizeContent(expected.answer)
      })
    ) throw new Error('Prepared simulation publication does not satisfy the strict QA grammar')
    return {
      ...bundle,
      canonicalMarkdown,
      canonicalBodySha256: sha256(normalizeContent(canonicalMarkdown)),
    }
  }

  #write<T>(operation: () => T): T {
    this.#assertOpen()
    if (this.#writing) return operation()
    this.#writing = true
    try {
      return this.#database.transaction(operation).immediate()
    } finally {
      this.#writing = false
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('DataStore is closed')
  }
}

interface StoredVectorSourceRow {
  owner_id: string
  document_id: string
  title: string
  text: string
  excerpt: string
  content_hash: string
  has_embedding: number
}

export interface StoredVectorSource {
  readonly ownerType: IndexOwnerType
  readonly ownerId: string
  readonly documentId: string
  readonly title: string
  readonly text: string
  readonly excerpt: string
  readonly contentHash: string
  readonly hasEmbedding: boolean
}
