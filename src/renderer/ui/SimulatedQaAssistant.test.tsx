import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { SimulatedQaSlot } from './contracts'
import { SimulatedQaAssistant } from './SimulatedQaAssistant'

function slot(patch: Partial<SimulatedQaSlot> = {}): SimulatedQaSlot {
  return {
    job: null,
    page: null,
    pageIndex: 0,
    canPageBackward: false,
    busy: false,
    error: null,
    onPreflight: () => Promise.reject(new Error('not connected')),
    onStart: () => undefined,
    onCancel: () => undefined,
    onPage: () => undefined,
    onEdit: () => undefined,
    onResume: () => undefined,
    onReview: () => undefined,
    onPublish: () => undefined,
    ...patch,
  }
}

describe('SimulatedQaAssistant controlled shell', () => {
  it('renders a truthful collapsed entry without manufacturing a job', () => {
    const html = renderToStaticMarkup(
      <SimulatedQaAssistant projectId="project-1" projectName="项目甲" knowledgeVersion={8} slot={slot()} />,
    )
    expect(html).toContain('模拟问答助手')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('正在生成')
  })

  it('drops a stale job and page from a different project or source revision', () => {
    const html = renderToStaticMarkup(
      <SimulatedQaAssistant
        projectId="project-1"
        projectName="项目甲"
        knowledgeVersion={8}
        slot={slot({
          job: {
            id: 'job-1', projectId: 'project-2', generation: 3, knowledgeVersion: 7, state: 'review_required',
            completedBatches: 3, totalBatches: 3, targetCount: 30, reliableCount: 29, gapCount: 1,
            approvedCount: 0, dataRevision: 9, createdAt: 1, updatedAt: 2, completedAt: null, errorCode: null,
          },
          page: {
            projectId: 'project-2', jobId: 'job-1', generation: 3, knowledgeVersion: 7, items: [], gaps: [],
            totalItems: 0, nextCursor: null, dataRevision: 9,
          },
        })}
      />,
    )
    expect(html).not.toContain('逐条审阅')
    expect(html).not.toContain('可靠 29 条')
  })

  it('uses whole-job approval count for publishing even when the visible page has none', () => {
    const html = renderToStaticMarkup(
      <SimulatedQaAssistant
        projectId="project-1"
        projectName="项目甲"
        knowledgeVersion={8}
        slot={slot({
          job: {
            id: 'job-1', projectId: 'project-1', generation: 3, knowledgeVersion: 8, state: 'review_required',
            completedBatches: 3, totalBatches: 3, targetCount: 30, reliableCount: 29, gapCount: 1,
            approvedCount: 12, dataRevision: 9, createdAt: 1, updatedAt: 2, completedAt: null, errorCode: null,
          },
          page: {
            projectId: 'project-1', jobId: 'job-1', generation: 3, knowledgeVersion: 8, items: [], gaps: [],
            totalItems: 29, nextCursor: null, dataRevision: 9,
          },
        })}
      />,
    )
    expect(html).toContain('全任务已批准 12 条')
    expect(html).toMatch(/<button[^>]+class="is-primary"[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?发布已批准 QA<\/button>/u)
  })

  it('states that high-volume generation never pads unsupported QA', () => {
    const source = readFileSync(new URL('./SimulatedQaAssistant.tsx', import.meta.url), 'utf8')
    expect(source).toContain('QAing 不会凑数，证据不足会改列资料缺口')
    expect(source).not.toContain('可能出现重复、低价值问题')
  })
})
