import { describe, expect, it } from 'vitest'
import { initialAppState } from '../../core/state-machine'
import type { AppState } from '../../core/types'
import type { UiEnvironment } from './contracts'
import {
  actionFailureMessage,
  areSessionControlsLocked,
  phasePresentation,
  primaryActionPresentation,
} from './view-model'

const readyEnvironment: UiEnvironment = {
  permissions: { microphone: 'granted', system: 'granted' },
  captureHealth: 'healthy',
  alwaysOnTop: false,
  retrievalMode: 'hybrid',
  retrievalHealth: 'ready',
  knowledgeBase: { presetQaCount: 12, sourceDocumentCount: 4, pendingIndexJobs: 0 },
  providerStatuses: {
    deepseek: { configured: true, maskedKey: '••••abcd' },
    doubao_asr: { configured: true, maskedKey: '••••efgh' },
    embedding: { configured: true, maskedKey: '本地模型' },
  },
  documents: [],
}

function stateWith(patch: Partial<AppState>): AppState {
  return { ...initialAppState, ...patch }
}

describe('renderer view model', () => {
  it('shows only whitelisted QA format guidance and never echoes paths or document text', () => {
    const safe = actionFailureMessage(
      'import-preset-qa',
      new Error(
        "Error invoking remote method 'qaing:library:import-qa': Error: "
        + 'QAING_QA_FORMAT:EXPECTED_SEPARATOR:27:/Users/private/董事会.md:机密问题正文',
      ),
    )
    expect(safe).toContain('第 27 行')
    expect(safe).toContain('模板 A')
    expect(safe).toContain('模板 B')
    expect(safe).toContain('模板 C')
    expect(safe).not.toContain('/Users/private')
    expect(safe).not.toContain('董事会')
    expect(safe).not.toContain('机密问题正文')

    const unknown = actionFailureMessage(
      'import-preset-qa',
      new Error('QAING_QA_FORMAT:UNKNOWN_CODE:27:/Users/private/secret.md'),
    )
    expect(unknown).toBe('导入未能完成，已有资料不受影响。')
    expect(unknown).not.toContain('/Users/private')
    expect(actionFailureMessage(
      'import-source-documents',
      new Error('QAING_QA_FORMAT:EXPECTED_SEPARATOR:27'),
    )).toBe('导入未能完成，已有资料不受影响。')

    const report = actionFailureMessage(
      'import-preset-qa',
      new Error('QAING_QA_FORMAT:REPORT_COUNT_MISMATCH:109:/Users/private/评审汇总.md:机密答案'),
    )
    expect(report).toContain('第 109 行')
    expect(report).toContain('实际问答数')
    expect(report).toContain('模板 C')
    expect(report).not.toMatch(/\/Users|private|机密答案/u)
  })

  it('explains that legacy library mutations are disabled for an active project', () => {
    const error = new Error(
      "Error invoking remote method 'qaing:library:import-source': Error: QAING_PROJECT_LIBRARY_MANAGED",
    )
    expect(actionFailureMessage('import-source-documents', error)).toContain('项目同步中心')
    expect(actionFailureMessage('import-preset-qa', error)).toContain('预设QA目录')
    expect(actionFailureMessage('delete-document', error)).toContain('源目录移除')
  })

  it('keeps project-workspace mutation failures scoped and non-destructive', () => {
    expect(actionFailureMessage('delete-qa-workspace-round')).toContain('轮次未能删除')
    expect(actionFailureMessage('clear-qa-workspace-project')).toContain('所有轮次保持不变')
    expect(actionFailureMessage('export-qa-workspace-project')).toContain('不会改变任何轮次')
  })

  it('maps every durable QA phase to an unambiguous status and action', () => {
    const finalizing = stateWith({ qaPhase: 'finalizing', sessionId: 'session-1' })
    expect(phasePresentation(finalizing, readyEnvironment)).toMatchObject({
      label: '正在生成确定答案',
      busy: true,
    })
    expect(primaryActionPresentation(finalizing, readyEnvironment)).toMatchObject({
      action: null,
      disabled: true,
    })

    const locked = stateWith({
      qaPhase: 'answer_locked',
      sessionId: 'session-1',
      lockedAnswer: '确定答案',
    })
    expect(phasePresentation(locked, readyEnvironment).tone).toBe('success')
    expect(primaryActionPresentation(locked, readyEnvironment)).toMatchObject({
      action: 'end-answer',
      disabled: false,
    })

    const committing = stateWith({ qaPhase: 'committing', sessionId: 'session-1' })
    expect(primaryActionPresentation(committing, readyEnvironment).action).toBeNull()
    expect(areSessionControlsLocked(committing)).toBe(true)
  })

  it('does not allow empty or unauthorized sessions to be submitted', () => {
    const deniedEnvironment: UiEnvironment = {
      ...readyEnvironment,
      permissions: { ...readyEnvironment.permissions, system: 'denied' },
    }
    expect(primaryActionPresentation(initialAppState, deniedEnvironment)).toMatchObject({
      action: 'start',
      disabled: true,
    })

    const firstRunEnvironment: UiEnvironment = {
      ...readyEnvironment,
      permissions: { ...readyEnvironment.permissions, system: 'prompt' },
    }
    expect(primaryActionPresentation(initialAppState, firstRunEnvironment)).toMatchObject({
      action: 'start',
      disabled: true,
    })

    const missingProviderEnvironment: UiEnvironment = {
      ...readyEnvironment,
      providerStatuses: {
        ...readyEnvironment.providerStatuses,
        doubao_asr: { configured: false, maskedKey: null },
      },
    }
    expect(primaryActionPresentation(initialAppState, missingProviderEnvironment)).toMatchObject({
      action: 'start',
      hint: '请先配置 DeepSeek 与豆包 ASR',
      disabled: true,
    })

    const emptyListening = stateWith({ qaPhase: 'listening', sessionId: 'session-1' })
    expect(primaryActionPresentation(emptyListening, readyEnvironment)).toMatchObject({
      action: 'end-question',
      disabled: true,
    })

    const listeningWithQuestion = stateWith({
      qaPhase: 'listening',
      sessionId: 'session-1',
      finalSegments: ['请介绍今年的收入。'],
    })
    expect(primaryActionPresentation(listeningWithQuestion, readyEnvironment)).toMatchObject({
      action: 'end-question',
      disabled: false,
    })
  })

  it('uses operation-specific recovery labels without the ambiguous legacy retry copy', () => {
    expect(primaryActionPresentation(stateWith({
      qaPhase: 'error',
      sessionId: 'session-1',
      errorOperation: 'final',
    }), readyEnvironment).label).toBe('重新生成确定答案')
    expect(primaryActionPresentation(stateWith({
      qaPhase: 'error',
      sessionId: 'session-1',
      errorOperation: 'commit',
    }), readyEnvironment).label).toBe('重新保存本轮')
    expect(primaryActionPresentation(stateWith({
      qaPhase: 'error',
      sessionId: null,
      errorOperation: 'start',
    }), readyEnvironment).label).toBe('重新开始监听')
    expect(primaryActionPresentation(stateWith({
      mode: 'front',
      qaPhase: 'idle',
      frontPhase: 'error',
      errorOperation: 'front',
    }), readyEnvironment).label).toBe('继续处理资料')
  })

  it('shows front-mode recovery and completion as explicit user-controlled steps', () => {
    const frontError = stateWith({
      mode: 'front',
      frontPhase: 'error',
      qaPhase: 'idle',
      error: '索引失败',
    })
    expect(phasePresentation(frontError, readyEnvironment)).toMatchObject({ tone: 'danger', busy: false })
    expect(primaryActionPresentation(frontError, readyEnvironment).action).toBe('retry')

    const complete = stateWith({ mode: 'front', frontPhase: 'complete', qaPhase: 'idle' })
    expect(primaryActionPresentation(complete, readyEnvironment)).toMatchObject({
      action: 'acknowledge-front-complete',
      disabled: false,
    })
  })
})
