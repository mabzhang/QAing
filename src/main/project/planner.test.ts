import { describe, expect, it } from 'vitest'
import { planProjectIncrement, projectSourceId } from './planner'
import type { ProjectManifestEntry, ProjectSourceObservation } from './types'

function observed(path: string, hash: string, inode: string): ProjectSourceObservation {
  return {
    relativePath: path,
    pathKey: path.toLocaleLowerCase('zh-CN'),
    trustKind: 'document',
    size: 4,
    mtimeNs: '1',
    device: '1',
    inode,
    rawSha256: hash,
    detectedType: 'text',
    disposition: 'local',
    errorCode: null,
  }
}

function manifest(path: string, hash: string, inode: string, overrides: Partial<ProjectManifestEntry> = {}): ProjectManifestEntry {
  return {
    ...observed(path, hash, inode),
    sourceId: `source_${inode}`,
    state: 'ready',
    activeRawSha256: hash,
    activeCanonicalSha256: `canonical_${inode}`,
    outputRelativePath: `转换资料库/资料/${inode}.md`,
    outputSize: 10,
    outputMtimeNs: '1',
    outputDevice: '1',
    outputInode: inode,
    missingSinceGeneration: null,
    lastSeenGeneration: 1,
    ...overrides,
  }
}

describe('project incremental planner', () => {
  it('freezes the shared source-id algorithm for manifest and planner adapters', () => {
    expect(projectSourceId('project', 'document', '原始资料/a.txt')).toBe('source_a5c1bfec1148f1bb62fa2f9c')
    const plan = planProjectIncrement('project', 1, [observed('原始资料/a.txt', 'a'.repeat(64), '1')], [])
    expect(plan.conversions[0]?.sourceId).toBe(projectSourceId('project', 'document', '原始资料/a.txt'))
  })
  it('skips unchanged, converts changed, and keeps deterministic operation ids', () => {
    const old = manifest('原始资料/a.txt', 'a'.repeat(64), '1')
    const changed = observed('原始资料/a.txt', 'b'.repeat(64), '1')
    const plan = planProjectIncrement('project', 2, [changed], [old])
    expect(plan.conversions).toHaveLength(1)
    expect(plan.conversions[0]).toMatchObject({ sourceId: old.sourceId })
    expect(planProjectIncrement('project', 2, [changed], [old]).conversions[0]?.operationId)
      .toBe(plan.conversions[0]?.operationId)
  })

  it('associates a unique inode rename without reconversion', () => {
    const old = manifest('原始资料/old.txt', 'a'.repeat(64), '1')
    const renamed = observed('原始资料/new.txt', 'a'.repeat(64), '1')
    const plan = planProjectIncrement('project', 2, [renamed], [old])
    expect(plan.renames).toEqual([expect.objectContaining({ sourceId: old.sourceId })])
    expect(plan.unchangedSourceIds).toEqual([old.sourceId])
    expect(plan.conversions).toHaveLength(0)
  })

  it('does not relink an edited file solely because its inode survived a rename', () => {
    const old = manifest('原始资料/old.txt', 'a'.repeat(64), '1')
    const movedAndEdited = observed('原始资料/new.txt', 'b'.repeat(64), '1')
    const plan = planProjectIncrement('project', 2, [movedAndEdited], [old])
    expect(plan.renames).toHaveLength(0)
    expect(plan.conversions[0]?.sourceId).toBe(projectSourceId('project', 'document', '原始资料/new.txt'))
    expect(plan.missingGraceSourceIds).toEqual([old.sourceId])
  })

  it('does not silently associate ambiguous duplicate hashes', () => {
    const first = manifest('原始资料/a.txt', 'a'.repeat(64), '1')
    const second = manifest('原始资料/b.txt', 'a'.repeat(64), '2')
    const incoming = observed('原始资料/c.txt', 'a'.repeat(64), '3')
    const plan = planProjectIncrement('project', 2, [incoming], [first, second])
    expect(plan.ambiguousRelativePaths).toEqual(['原始资料/c.txt'])
    expect(plan.conversions).toHaveLength(0)
  })

  it('requires two successful generations before tombstoning a missing source', () => {
    const firstMissing = manifest('原始资料/a.txt', 'a'.repeat(64), '1')
    expect(planProjectIncrement('project', 2, [], [firstMissing]).missingGraceSourceIds).toEqual([firstMissing.sourceId])
    const grace = manifest(firstMissing.relativePath, firstMissing.activeRawSha256 ?? '', '1', {
      state: 'missing_grace',
      missingSinceGeneration: 2,
    })
    expect(planProjectIncrement('project', 3, [], [grace]).tombstoneSourceIds).toEqual([grace.sourceId])
  })

  it('reuses last-good content when a missing-grace source reappears unchanged', () => {
    const grace = manifest('原始资料/a.txt', 'a'.repeat(64), '1', {
      state: 'missing_grace',
      missingSinceGeneration: 2,
    })
    const plan = planProjectIncrement('project', 3, [observed('原始资料/a.txt', 'a'.repeat(64), '1')], [grace])
    expect(plan.unchangedSourceIds).toEqual([grace.sourceId])
    expect(plan.conversions).toHaveLength(0)
  })
})
