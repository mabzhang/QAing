import { createHash } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { relativePathKey } from './filesystem'
import {
  PROJECT_INPUT_DOCUMENTS_DIRECTORY,
  PROJECT_INPUT_QA_DIRECTORY,
  PROJECT_OUTPUT_DIRECTORY,
  PROJECT_OUTPUT_DOCUMENTS_DIRECTORY,
  PROJECT_OUTPUT_QA_DIRECTORY,
} from './layout'
import { PROJECT_CONVERTER_ID, PROJECT_CONVERTER_VERSION } from './types'
import type {
  PlannedConversion,
  PlannedRename,
  ProjectIncrementalPlan,
  ProjectManifestEntry,
  ProjectSourceObservation,
  ProjectTrustKind,
  LocalProjectSourceObservation,
} from './types'

function digest(...values: readonly string[]): string {
  const hash = createHash('sha256')
  for (const value of values) hash.update(value).update('\0')
  return hash.digest('hex')
}

export function projectSourceId(projectId: string, trustKind: ProjectTrustKind, pathKey: string): string {
  return `source_${digest(projectId, trustKind, pathKey).slice(0, 24)}`
}

function inputRelativePath(observation: ProjectSourceObservation): string {
  const prefix = observation.trustKind === 'document'
    ? `${PROJECT_INPUT_DOCUMENTS_DIRECTORY}/`
    : `${PROJECT_INPUT_QA_DIRECTORY}/`
  if (!observation.relativePath.startsWith(prefix)) throw new TypeError('Observation is outside its fixed input root')
  return observation.relativePath.slice(prefix.length)
}

export function outputRelativePath(sourceId: string, observation: ProjectSourceObservation): string {
  const inputRelative = inputRelativePath(observation)
  const parent = dirname(inputRelative).replaceAll('\\', '/')
  const leaf = `${basename(inputRelative)}--${sourceId.replace(/^source_/u, '').slice(0, 8)}.md`
  const outputRoot = observation.trustKind === 'document'
    ? PROJECT_OUTPUT_DOCUMENTS_DIRECTORY
    : PROJECT_OUTPUT_QA_DIRECTORY
  return [PROJECT_OUTPUT_DIRECTORY, outputRoot, parent === '.' ? '' : parent, leaf]
    .filter(Boolean)
    .join('/')
}

function operationId(
  projectId: string,
  sourceId: string,
  observation: ProjectSourceObservation,
  generation: number,
): string {
  return `conversion_${digest(
    projectId,
    sourceId,
    observation.rawSha256 ?? '',
    PROJECT_CONVERTER_ID,
    PROJECT_CONVERTER_VERSION,
    String(generation),
  ).slice(0, 32)}`
}

function conversion(
  projectId: string,
  generation: number,
  sourceId: string,
  observation: LocalProjectSourceObservation,
  existing: ProjectManifestEntry | null,
): PlannedConversion {
  return {
    sourceId,
    observation,
    outputRelativePath: outputRelativePath(sourceId, observation),
    expectedExistingOutputSha256: existing?.activeCanonicalSha256 ?? null,
    operationId: operationId(projectId, sourceId, observation, generation),
  }
}

function localObservation(observation: ProjectSourceObservation): LocalProjectSourceObservation | null {
  if (observation.disposition !== 'local' || observation.rawSha256 === null ||
      (observation.detectedType !== 'text' && observation.detectedType !== 'markdown' &&
        observation.detectedType !== 'json' && observation.detectedType !== 'csv' && observation.detectedType !== 'tsv')) {
    return null
  }
  const detectedType: LocalProjectSourceObservation['detectedType'] = observation.detectedType
  return { ...observation, detectedType, disposition: 'local', rawSha256: observation.rawSha256, errorCode: null }
}

function sameContent(entry: ProjectManifestEntry, observation: ProjectSourceObservation): boolean {
  return entry.trustKind === observation.trustKind && entry.activeRawSha256 !== null &&
    entry.activeRawSha256 === observation.rawSha256
}

function uniqueCandidate(
  entries: readonly ProjectManifestEntry[],
  observation: ProjectSourceObservation,
  predicate: (entry: ProjectManifestEntry, observation: ProjectSourceObservation) => boolean,
): ProjectManifestEntry | null | 'ambiguous' {
  const matches = entries.filter((entry) => predicate(entry, observation))
  if (matches.length === 0) return null
  if (matches.length > 1) return 'ambiguous'
  return matches[0] ?? null
}

function isActive(entry: ProjectManifestEntry): boolean {
  return entry.state !== 'tombstoned'
}

function hasMatchingLastGood(entry: ProjectManifestEntry, observation: LocalProjectSourceObservation): boolean {
  return entry.activeRawSha256 === observation.rawSha256 && entry.activeCanonicalSha256 !== null &&
    entry.outputRelativePath !== null && entry.state !== 'generated_output_modified'
}

export function planProjectIncrement(
  projectId: string,
  generation: number,
  observations: readonly ProjectSourceObservation[],
  manifest: readonly ProjectManifestEntry[],
): ProjectIncrementalPlan {
  const activeManifest = manifest.filter(isActive)
  const manifestByPath = new Map(activeManifest.map((entry) => [`${entry.trustKind}:${entry.pathKey}`, entry]))
  const observedKeys = new Set(observations.map((entry) => `${entry.trustKind}:${entry.pathKey}`))
  const missingEntries = activeManifest.filter((entry) => !observedKeys.has(`${entry.trustKind}:${entry.pathKey}`))
  const claimedMissing = new Set<string>()
  const unchangedSourceIds: string[] = []
  const conversions: PlannedConversion[] = []
  const renames: PlannedRename[] = []
  const unsupported: ProjectSourceObservation[] = []
  const ambiguousRelativePaths: string[] = []

  for (const observation of observations) {
    const exact = manifestByPath.get(`${observation.trustKind}:${observation.pathKey}`) ?? null
    const local = localObservation(observation)
    if (exact) {
      if (!local) {
        unsupported.push(observation)
      } else if (hasMatchingLastGood(exact, local)) {
        unchangedSourceIds.push(exact.sourceId)
      } else {
        conversions.push(conversion(projectId, generation, exact.sourceId, local, exact))
      }
      continue
    }

    const availableMissing = missingEntries.filter((entry) => !claimedMissing.has(entry.sourceId))
    // A device/inode match is only a scan hint: the file may have been edited
    // during the rename. Preserve source identity only for a unique content
    // hash match so the planner, SQLite manifest and crash replay all agree.
    const renamed = uniqueCandidate(availableMissing, observation, sameContent)
    if (renamed === 'ambiguous') {
      ambiguousRelativePaths.push(observation.relativePath)
      continue
    }
    if (renamed) {
      claimedMissing.add(renamed.sourceId)
      renames.push({ sourceId: renamed.sourceId, fromRelativePath: renamed.relativePath, observation })
      if (!local) unsupported.push(observation)
      else if (hasMatchingLastGood(renamed, local)) {
        unchangedSourceIds.push(renamed.sourceId)
      } else {
        conversions.push(conversion(projectId, generation, renamed.sourceId, local, renamed))
      }
      continue
    }

    if (local) {
      const sourceId = projectSourceId(projectId, observation.trustKind, observation.pathKey)
      conversions.push(conversion(projectId, generation, sourceId, local, null))
    } else {
      unsupported.push(observation)
    }
  }

  const stillMissing = missingEntries.filter((entry) => !claimedMissing.has(entry.sourceId))
  const missingGraceSourceIds: string[] = []
  const tombstoneSourceIds: string[] = []
  for (const entry of stillMissing) {
    if (entry.missingSinceGeneration !== null && entry.missingSinceGeneration < generation) {
      tombstoneSourceIds.push(entry.sourceId)
    } else {
      missingGraceSourceIds.push(entry.sourceId)
    }
  }

  return {
    unchangedSourceIds: [...new Set(unchangedSourceIds)].sort(),
    conversions: conversions.sort((left, right) => left.observation.pathKey.localeCompare(right.observation.pathKey)),
    renames: renames.sort((left, right) => left.observation.pathKey.localeCompare(right.observation.pathKey)),
    unsupported: unsupported.sort((left, right) => left.pathKey.localeCompare(right.pathKey)),
    missingGraceSourceIds: missingGraceSourceIds.sort(),
    tombstoneSourceIds: tombstoneSourceIds.sort(),
    ambiguousRelativePaths: ambiguousRelativePaths.sort((left, right) => relativePathKey(left).localeCompare(relativePathKey(right))),
  }
}

export function trustKindForRelativePath(relativePath: string): ProjectTrustKind {
  if (relativePath.startsWith(`${PROJECT_INPUT_DOCUMENTS_DIRECTORY}/`)) return 'document'
  if (relativePath.startsWith(`${PROJECT_INPUT_QA_DIRECTORY}/`)) return 'preset_qa'
  throw new TypeError('Path is outside a fixed project input root')
}
