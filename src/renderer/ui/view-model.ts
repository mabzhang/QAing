import { questionText } from '../../core/state-machine'
import type { AppState, AudioSourceKind } from '../../core/types'
import type {
  CaptureHealth,
  PermissionState,
  UiActionName,
  UiEnvironment,
} from './contracts'

export type StatusTone = 'neutral' | 'active' | 'success' | 'warning' | 'danger'

export interface PhasePresentation {
  readonly eyebrow: string
  readonly label: string
  readonly detail: string
  readonly tone: StatusTone
  readonly busy: boolean
}

export interface PrimaryActionPresentation {
  readonly action:
    | 'start'
    | 'stop-front'
    | 'acknowledge-front-complete'
    | 'end-question'
    | 'end-answer'
    | 'retry'
    | 'open-knowledge-base'
    | null
  readonly label: string
  readonly hint: string
  readonly disabled: boolean
}

export const AUDIO_SOURCE_LABELS: Readonly<Record<AudioSourceKind, string>> = {
  microphone: '麦克风',
  system: '系统音频',
}

export const PERMISSION_LABELS: Readonly<Record<PermissionState, string>> = {
  checking: '正在检查',
  prompt: '待授权',
  granted: '已授权',
  denied: '未授权',
  unavailable: '不可用',
}

export function hasActiveSession(state: AppState): boolean {
  return state.sessionId !== null
}

export function areSessionControlsLocked(state: AppState): boolean {
  return state.qaPhase !== 'idle' || state.frontPhase !== 'idle'
}

export function selectedPermission(
  state: AppState,
  environment: UiEnvironment,
): PermissionState {
  return environment.permissions[state.audioSource]
}

export function isPermissionBlocking(permission: PermissionState): boolean {
  return permission === 'checking'
    || permission === 'prompt'
    || permission === 'denied'
    || permission === 'unavailable'
}

export function requiredCloudProvidersConfigured(environment: UiEnvironment): boolean {
  return environment.providerStatuses.deepseek.configured && environment.providerStatuses.doubao_asr.configured
}

function capturePresentation(
  mode: AppState['mode'],
  captureHealth: CaptureHealth,
): PhasePresentation | null {
  const modeLabel = mode === 'qa' ? '监听' : '记录'
  switch (captureHealth) {
    case 'starting':
      return {
        eyebrow: '音频连接',
        label: '正在连接音频',
        detail: `正在准备${modeLabel}，请稍候。`,
        tone: 'active',
        busy: true,
      }
    case 'healthy':
      return {
        eyebrow: mode === 'qa' ? '实时问答' : '前置记录',
        label: mode === 'qa' ? '正在监听问题' : '正在记录内容',
        detail: mode === 'qa' ? '文字会持续收敛，由你手动锁定完整问题。' : '原始转写持续保存，结束后将结构化并入库。',
        tone: 'active',
        busy: false,
      }
    case 'silent':
      return {
        eyebrow: '音频检测',
        label: '未检测到声音',
        detail: '请检查当前音源、输出设备或 macOS 系统权限。',
        tone: 'warning',
        busy: false,
      }
    case 'reconnecting':
      return {
        eyebrow: '转写连接',
        label: '正在恢复转写',
        detail: '已确认的文字已保留，正在有界重连语音服务。',
        tone: 'warning',
        busy: true,
      }
    case 'paused':
      return {
        eyebrow: '转写连接',
        label: '转写已暂停',
        detail: '已保留确认文字。请检查网络或重试连接。',
        tone: 'danger',
        busy: false,
      }
    case 'idle':
      return null
  }
}

export function phasePresentation(
  state: AppState,
  environment: UiEnvironment,
): PhasePresentation {
  const isCapturing = state.mode === 'qa'
    ? state.qaPhase === 'listening'
    : state.frontPhase === 'recording'
  if (isCapturing) {
    const capture = capturePresentation(state.mode, environment.captureHealth)
    if (capture !== null) return capture
  }

  if (state.mode === 'qa') {
    switch (state.qaPhase) {
      case 'idle':
        return {
          eyebrow: '实时问答',
          label: '准备开始监听',
          detail: '选择音源后开始，系统会边听边预判候选答案。',
          tone: 'neutral',
          busy: false,
        }
      case 'listening':
        return {
          eyebrow: '实时问答',
          label: '正在等待问题',
          detail: '开始说话后，转写和候选答案会在此处出现。',
          tone: 'active',
          busy: false,
        }
      case 'finalizing':
        return {
          eyebrow: '问题已锁定',
          label: '正在生成确定答案',
          detail: '正在对完整问题做最终检索、来源核对与整合。',
          tone: 'active',
          busy: true,
        }
      case 'answer_locked':
        return {
          eyebrow: '确定答案',
          label: '答案已锁定',
          detail: '已停止接收本轮问题更新，可安心回答。',
          tone: 'success',
          busy: false,
        }
      case 'committing':
        return {
          eyebrow: '对话历史',
          label: '正在保存本轮',
          detail: '问题、答案和来源关系正在写入最近五轮上下文。',
          tone: 'active',
          busy: true,
        }
      case 'error':
        return {
          eyebrow: '需要处理',
          label: '本轮暂停',
          detail: '问题和已确认内容保留，处理异常后可重试。',
          tone: 'danger',
          busy: false,
        }
    }
  }

  switch (state.frontPhase) {
    case 'idle':
      return {
        eyebrow: '前置记录',
        label: '准备开始记录',
        detail: '用于演讲、路演或背景阐述，结束后将内容整理并入库。',
        tone: 'neutral',
        busy: false,
      }
    case 'recording':
      return {
        eyebrow: '前置记录',
        label: '正在等待内容',
        detail: '开始说话后，已确认转写会持续保存。',
        tone: 'active',
        busy: false,
      }
    case 'structuring':
      return {
        eyebrow: '资料处理',
        label: '正在结构化记录',
        detail: '原始转写已保留，正在整理标题、要点和关键数据。',
        tone: 'active',
        busy: true,
      }
    case 'indexing':
      return {
        eyebrow: '资料处理',
        label: '正在写入资料库',
        detail: '结构化文档已生成，正在分块、建立索引并校验。',
        tone: 'active',
        busy: true,
      }
    case 'complete':
      return {
        eyebrow: '入库完成',
        label: '本次记录已可检索',
        detail: '结构化内容已幂等入库，后续 QA 可将它作为来源。',
        tone: 'success',
        busy: false,
      }
    case 'error':
      return {
        eyebrow: '需要处理',
        label: '资料处理暂停',
        detail: '原始转写已保留，可在异常解决后继续处理。',
        tone: 'danger',
        busy: false,
      }
  }
}

export function primaryActionPresentation(
  state: AppState,
  environment: UiEnvironment,
): PrimaryActionPresentation {
  const transcript = questionText(state).trim()
  const permission = selectedPermission(state, environment)
  if (state.mode === 'qa') {
    switch (state.qaPhase) {
      case 'idle':
        {
          const providersReady = requiredCloudProvidersConfigured(environment)
          return {
            action: 'start',
            label: '开始监听',
            hint: providersReady ? `使用${AUDIO_SOURCE_LABELS[state.audioSource]}` : '请先配置 DeepSeek 与豆包 ASR',
            disabled: isPermissionBlocking(permission) || !providersReady,
          }
        }
      case 'listening':
        return {
          action: 'end-question',
          label: '提问结束',
          hint: transcript ? '锁定完整问题并生成确定答案' : '检测到问题后可锁定',
          disabled: !transcript || environment.captureHealth === 'starting',
        }
      case 'answer_locked':
        return {
          action: 'end-answer',
          label: '回答结束',
          hint: '保存本轮并继续监听下一问',
          disabled: false,
        }
      case 'error':
        if (state.errorOperation === 'final') {
          return {
            action: 'retry',
            label: '重新生成确定答案',
            hint: '已锁定问题保持不变',
            disabled: false,
          }
        }
        if (state.errorOperation === 'commit') {
          return {
            action: 'retry',
            label: '重新保存本轮',
            hint: '已锁定答案和来源已保留',
            disabled: false,
          }
        }
        if (state.errorOperation === 'start') {
          return {
            action: 'retry',
            label: '重新开始监听',
            hint: '重新建立音频与转写连接',
            disabled: false,
          }
        }
        return {
          action: 'retry',
          label: '重新尝试',
          hint: '已确认内容保持不变',
          disabled: false,
        }
      case 'finalizing':
      case 'committing':
        return {
          action: null,
          label: state.qaPhase === 'finalizing' ? '正在生成确定答案' : '正在保存本轮',
          hint: '请稍候',
          disabled: true,
        }
    }
  }

  switch (state.frontPhase) {
    case 'idle':
      {
        const providersReady = requiredCloudProvidersConfigured(environment)
        return {
          action: 'start',
          label: '开始记录',
          hint: providersReady ? `使用${AUDIO_SOURCE_LABELS[state.audioSource]}` : '请先配置 DeepSeek 与豆包 ASR',
          disabled: isPermissionBlocking(permission) || !providersReady,
        }
      }
    case 'recording':
      return {
        action: 'stop-front',
        label: '结束记录并入库',
        hint: transcript ? '保存原始转写，然后结构化并索引' : '检测到内容后可结束',
        disabled: !transcript || environment.captureHealth === 'starting',
      }
    case 'complete':
      return {
        action: 'acknowledge-front-complete',
        label: '完成并返回待机',
        hint: '本次内容已可在资料库中检索',
        disabled: false,
      }
    case 'error':
      if (state.errorOperation === 'start') {
        return {
          action: 'retry',
          label: '重新开始记录',
          hint: '重新建立音频与转写连接',
          disabled: false,
        }
      }
      return {
        action: 'retry',
        label: state.errorOperation === 'commit' ? '重新保存资料' : '继续处理资料',
        hint: '使用已保留的原始转写继续',
        disabled: false,
      }
    case 'structuring':
    case 'indexing':
      return {
        action: null,
        label: state.frontPhase === 'structuring' ? '正在结构化' : '正在建立索引',
        hint: '原始转写已保留',
        disabled: true,
      }
  }
}

const QA_FORMAT_ERROR_CODES = new Set([
  'EXPECTED_QUESTION',
  'EMPTY_QUESTION',
  'EXPECTED_ANSWER',
  'EMPTY_ANSWER',
  'EXPECTED_CATEGORY',
  'EMPTY_CATEGORY',
  'EXPECTED_NUMBERED_QUESTION',
  'EXPECTED_NUMBERED_ANSWER',
  'EXPECTED_SEPARATOR',
  'EXPECTED_PREAMBLE_SEPARATOR',
  'INVALID_PREAMBLE',
  'DUPLICATE_TITLE',
  'UNEXPECTED_HEADING',
  'DUPLICATE_ANSWER',
  'UNCLOSED_FENCE',
  'CONFLICTING_QUESTION',
  'REPORT_EXPECTED_METADATA',
  'REPORT_EXPECTED_OVERVIEW',
  'REPORT_INVALID_OVERVIEW',
  'REPORT_EXPECTED_CATEGORY',
  'REPORT_CATEGORY_MISMATCH',
  'REPORT_COUNT_MISMATCH',
  'REPORT_EXPECTED_QUESTION',
  'REPORT_QUESTION_SEQUENCE',
  'REPORT_EXPECTED_ANSWER',
  'REPORT_EXPECTED_SEPARATOR',
  'REPORT_EXPECTED_FOOTER',
] as const)

const QA_FORMAT_CODE_HINTS: Readonly<Record<string, string>> = {
  EXPECTED_QUESTION: '缺少问题标题',
  EMPTY_QUESTION: '问题不能为空',
  EXPECTED_ANSWER: '缺少答案标题',
  EMPTY_ANSWER: '答案不能为空',
  EXPECTED_CATEGORY: '缺少分类标题',
  EMPTY_CATEGORY: '分类不能为空',
  EXPECTED_NUMBERED_QUESTION: '缺少加粗编号问题',
  EXPECTED_NUMBERED_ANSWER: '缺少“回答：”',
  EXPECTED_SEPARATOR: '问答之间缺少“---”分隔线',
  EXPECTED_PREAMBLE_SEPARATOR: '文档说明后缺少“---”分隔线',
  INVALID_PREAMBLE: '文档开头不符合严格格式',
  DUPLICATE_TITLE: '文档标题重复',
  UNEXPECTED_HEADING: '两种 Markdown 模板不可混用',
  DUPLICATE_ANSWER: '答案标记重复',
  UNCLOSED_FENCE: '代码块未闭合',
  CONFLICTING_QUESTION: '同一问题存在冲突答案',
  REPORT_EXPECTED_METADATA: '评审汇总的标题或说明不完整',
  REPORT_EXPECTED_OVERVIEW: '缺少分类总览表',
  REPORT_INVALID_OVERVIEW: '分类总览表不符合三列格式',
  REPORT_EXPECTED_CATEGORY: '缺少评审分类标题',
  REPORT_CATEGORY_MISMATCH: '分类名称或条数与总览不一致',
  REPORT_COUNT_MISMATCH: '实际问答数与声明条数不一致',
  REPORT_EXPECTED_QUESTION: '缺少四级编号问题',
  REPORT_QUESTION_SEQUENCE: '问题编号不连续',
  REPORT_EXPECTED_ANSWER: '问题后缺少“回答：”',
  REPORT_EXPECTED_SEPARATOR: '评审问答后缺少“---”分隔线',
  REPORT_EXPECTED_FOOTER: '评审汇总的文档尾说明不完整',
}

const QA_FORMAT_ERROR_PATTERN = /\bQAING_QA_FORMAT:([A-Z_]+):([1-9][0-9]{0,7})\b/u
const MAX_PUBLIC_QA_ERROR_LINE = 10_000_000

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message
  if (typeof error !== 'object' || error === null) return null
  const message = (error as { readonly message?: unknown }).message
  return typeof message === 'string' ? message : null
}

function safeQaFormatFailure(error: unknown): string | null {
  const message = errorMessage(error)
  const match = message?.match(QA_FORMAT_ERROR_PATTERN)
  const code = match?.[1]
  const line = Number(match?.[2])
  if (
    code === undefined
    || !QA_FORMAT_ERROR_CODES.has(code as never)
    || !Number.isSafeInteger(line)
    || line < 1
    || line > MAX_PUBLIC_QA_ERROR_LINE
  ) return null
  const hint = QA_FORMAT_CODE_HINTS[code] ?? '格式不符合严格规则'
  return `预设 QA 第 ${line} 行：${hint}。Markdown 支持模板 A（## 问题；### 答案）、模板 B（## 分类；**1. 问题**；回答；---）和模板 C（分类总览表；# 分类（N条）；#### 连续编号问题；回答；---）。未写入任何问答。`
}

function projectManagedLibraryFailure(error: unknown): boolean {
  return errorMessage(error)?.includes('QAING_PROJECT_LIBRARY_MANAGED') ?? false
}

export function actionFailureMessage(action: UiActionName, error?: unknown): string {
  switch (action) {
    case 'copy-answer':
      return '复制失败，请稍后重试。'
    case 'configure-provider':
      return '配置未能安全保存。输入已清空，请重新输入后再试。'
    case 'clear-provider':
      return '无法清除当前配置，原配置保持不变。'
    case 'open-permission':
      return '无法打开 macOS 权限设置，请手动前往「系统设置 → 隐私与安全性」。'
    case 'request-permission':
      return '权限申请未完成。请查看当前状态，必要时完全退出并重新打开 QAing。'
    case 'restart-application':
      return '无法完全退出并重开 QAing，请手动退出应用后重新打开。'
    case 'import-source-documents':
      return projectManagedLibraryFailure(error)
        ? '当前项目由「项目同步中心」统一管理，请将文件放入项目的原始资料目录后检查更新。'
        : '导入未能完成，已有资料不受影响。'
    case 'import-preset-qa':
      return projectManagedLibraryFailure(error)
        ? '当前项目由「项目同步中心」统一管理，请将审核后的问答放入项目的预设QA目录。'
        : safeQaFormatFailure(error) ?? '导入未能完成，已有资料不受影响。'
    case 'delete-document':
      return projectManagedLibraryFailure(error)
        ? '当前项目资料由项目文件夹管理，请在源目录移除文件后再检查更新。'
        : '删除未能完成，资料和索引保持不变。'
    case 'stop-session':
      return '未能安全停止当前会话，请重试；已确认内容不受影响。'
    case 'set-always-on-top':
      return '置顶设置未能更新，窗口保持原状态。'
    case 'select-project-root':
      return '项目文件夹未能加载，现有项目与知识版本不受影响。'
    case 'activate-project':
      return '项目未能切换，当前会话继续使用原项目。'
    case 'confirm-project-directories':
      return '固定目录未能完整创建，未启动后续更新。'
    case 'cancel-project-preparation':
      return '未能取消项目准备，请保留当前页面后再试。'
    case 'start-project-sync':
      return '未能启动项目更新，当前 last-good 知识版本保持可用。'
    case 'cancel-project-sync':
      return '取消指令未能确认，请以同步中心的最新状态为准。'
    case 'retry-project-sync':
      return '失败项未能重新启动，已发布知识不受影响。'
    case 'relocate-project':
      return '项目目录未能重新定位，未将不可达目录判定为删除。'
    case 'set-project-sync-policy':
      return '同步策略未能更新，项目保持原策略。'
    case 'set-project-task-filter':
    case 'load-more-project-tasks':
      return '项目任务暂时无法读取，已显示内容保持不变。'
    case 'export-project-diagnostics':
      return '诊断摘要未能导出，不会改变项目或知识库。'
    case 'delete-qa-workspace-round':
      return '轮次未能删除，当前项目的会话工作台保持不变。'
    case 'clear-qa-workspace-project':
      return '当前项目工作台未能清空，所有轮次保持不变。'
    case 'export-qa-workspace-project':
      return '当前项目工作台未能导出，不会改变任何轮次。'
    default:
      return '操作没有完成。已保留当前内容，请重试。'
  }
}
