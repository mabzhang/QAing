import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { DataStore } from './database'
import { parseStructuredQaBatch } from './importers'
import { KnowledgeRepository } from './repository'
import { InMemoryExactVectorIndex } from './vector'

describe('prepared structured QA batches', () => {
  it('deduplicates the same normalized question and answer across source files before preview', () => {
    const items = parseStructuredQaBatch([
      {
        format: 'json',
        rawContent: '[{"question":"如何退款？","answer":"联系客服。"}]',
      },
      {
        format: 'markdown',
        rawContent: '## Question:如何退款?\n### Answer\n联系客服。',
      },
    ])

    expect(items).toHaveLength(1)
    const store = new DataStore(':memory:')
    try {
      const repository = new KnowledgeRepository(store, new InMemoryExactVectorIndex())
      expect(repository.importPreparedStructuredQaBatch(items)).toHaveLength(1)
      expect(store.listPresetQa()).toHaveLength(1)
      expect(store.listIndexJobs()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('rejects conflicting answers across files before a prepared batch exists', () => {
    expect(() => parseStructuredQaBatch([
      {
        format: 'csv',
        rawContent: 'question,answer\n保修多久？,一年。',
      },
      {
        format: 'markdown',
        rawContent: '## Question:保修多久?\n### Answer\n两年。',
      },
    ])).toThrow(/conflicting answers/i)
  })

  it('rechecks an existing reviewed answer inside the commit transaction', () => {
    const store = new DataStore(':memory:')
    try {
      const repository = new KnowledgeRepository(store, new InMemoryExactVectorIndex())
      const prepared = parseStructuredQaBatch([{
        format: 'markdown',
        rawContent: '## 问题：已审核问题？\n### 答案\n预览时的答案。',
      }])
      expect(() => store.assertPresetQaBatchHasNoConflicts(prepared)).not.toThrow()

      // Simulate another writer winning after preview but before confirmation.
      store.upsertPresetQa({ question: '已审核问题？', answer: '已入库的答案。' }, 1)

      expect(() => repository.importPreparedStructuredQaBatch(prepared, 2)).toThrow(/existing answer/i)
      expect(store.listPresetQa().map(({ answer }) => answer)).toEqual(['已入库的答案。'])
      expect(store.listIndexJobs()).toHaveLength(1)
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
    }
  })

  it('rolls back earlier records and index jobs when a later insert fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qaing-prepared-qa-'))
    const databasePath = join(directory, 'qaing.sqlite3')
    const store = new DataStore(databasePath)
    try {
      const raw = new Database(databasePath)
      try {
        raw.exec(`
          CREATE TRIGGER inject_preset_qa_failure
          BEFORE INSERT ON preset_qa
          WHEN NEW.question = '第二个问题？'
          BEGIN
            SELECT RAISE(ABORT, 'INJECTED_PRESET_QA_FAILURE');
          END;
        `)
      } finally {
        raw.close()
      }
      const repository = new KnowledgeRepository(store, new InMemoryExactVectorIndex())
      const prepared = parseStructuredQaBatch([{
        format: 'json',
        rawContent: JSON.stringify([
          { question: '第一个问题？', answer: '第一个答案。' },
          { question: '第二个问题？', answer: '第二个答案。' },
        ]),
      }])

      expect(() => repository.importPreparedStructuredQaBatch(prepared)).toThrow(/INJECTED_PRESET_QA_FAILURE/)
      expect(store.listPresetQa()).toEqual([])
      expect(store.listIndexJobs()).toEqual([])
      expect(store.integrityCheck()).toBe('ok')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
