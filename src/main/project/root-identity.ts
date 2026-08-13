import type { ProjectRootIdentity } from './types'

interface StoredProjectRootIdentity {
  readonly canonicalPath: string
  readonly device: string
  readonly inode: string
}

/**
 * SQLite stores the local root identity as one bounded string. Keep this
 * encoder shared by the catalog and sync repository so a project selected in
 * the UI can always be reopened by the scanner without a second identity
 * dialect.
 */
export function serializeProjectRootIdentity(identity: ProjectRootIdentity): string {
  return JSON.stringify({
    canonicalPath: identity.canonicalPath,
    device: identity.device,
    inode: identity.inode,
  } satisfies StoredProjectRootIdentity)
}

export function parseProjectRootIdentity(value: string): ProjectRootIdentity {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error('PROJECT_ROOT_IDENTITY_INVALID')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('PROJECT_ROOT_IDENTITY_INVALID')
  }
  const record = parsed as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'canonicalPath,device,inode'
    || typeof record.canonicalPath !== 'string'
    || typeof record.device !== 'string'
    || typeof record.inode !== 'string'
    || !record.canonicalPath
    || !record.device
    || !record.inode
  ) {
    throw new Error('PROJECT_ROOT_IDENTITY_INVALID')
  }
  return {
    canonicalPath: record.canonicalPath,
    device: record.device,
    inode: record.inode,
  }
}
