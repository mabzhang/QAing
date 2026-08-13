import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileQuestion,
  Loader2,
  Pencil,
  Save,
  ShieldCheck,
  Sparkles,
  Square,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  QaSimulationBrief,
  QaSimulationItem,
  QaSimulationPreflight,
} from '../../core/contracts'
import type { SimulatedQaSlot } from './contracts'
import {
  DEFAULT_SIMULATED_QA_TARGET,
  parseSimulatedQaTarget,
  simulatedQaScopeMatches,
} from './simulated-qa'

interface SimulatedQaAssistantProps {
  readonly projectId: string
  readonly projectName: string
  readonly knowledgeVersion: number | null
  readonly slot: SimulatedQaSlot
}

interface BriefForm {
  readonly intervieweeIdentity: string
  readonly audience: string
  readonly focusTopics: string
  readonly scenario: string
  readonly answerStyle: QaSimulationBrief['answerStyle']
  readonly excludedTopics: string
}

const EMPTY_BRIEF: BriefForm = {
  intervieweeIdentity: '',
  audience: '',
  focusTopics: '',
  scenario: '',
  answerStyle: 'standard',
  excludedTopics: '',
}

const PHASE_LABELS = {
  planning: '正在规划',
  generating: '正在生成',
  validating: '正在校验',
  review_required: '等待审阅',
  publishing: '正在发布',
  completed: '已发布',
  completed_with_gaps: '已完成，存在资料缺口',
  paused: '已暂停',
  cancel_requested: '正在取消',
  cancelled: '已取消',
  interrupted: '已中断',
  stale: '资料版本已变化',
  failed: '生成未完成',
} as const

function splitList(value: string): readonly string[] {
  return value.split(/[\n,，;；]+/u).map((item) => item.trim()).filter(Boolean)
}

function toBrief(form: BriefForm): QaSimulationBrief {
  return {
    intervieweeIdentity: form.intervieweeIdentity.trim(),
    audience: form.audience.trim(),
    focusTopics: splitList(form.focusTopics),
    scenario: form.scenario.trim(),
    answerStyle: form.answerStyle,
    excludedTopics: splitList(form.excludedTopics),
  }
}

export function SimulatedQaAssistant({
  projectId,
  projectName,
  knowledgeVersion,
  slot,
}: SimulatedQaAssistantProps): React.JSX.Element {
  const [open, setOpen] = useState(() => knowledgeVersion !== null
    && slot.job !== null
    && simulatedQaScopeMatches(slot.job, projectId, knowledgeVersion))
  const [brief, setBrief] = useState<BriefForm>(EMPTY_BRIEF)
  const [targetInput, setTargetInput] = useState(String(DEFAULT_SIMULATED_QA_TARGET))
  const [preflight, setPreflight] = useState<QaSimulationPreflight | null>(null)
  const [preflightPending, setPreflightPending] = useState(false)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [longerAcknowledged, setLongerAcknowledged] = useState(false)
  const [sparseAcknowledged, setSparseAcknowledged] = useState(false)
  const [editing, setEditing] = useState<QaSimulationItem | null>(null)
  const target = useMemo(() => parseSimulatedQaTarget(targetInput), [targetInput])
  const currentJob = knowledgeVersion !== null && slot.job !== null
    && simulatedQaScopeMatches(slot.job, projectId, knowledgeVersion)
    ? slot.job
    : null
  const currentPage = knowledgeVersion !== null && currentJob !== null && slot.page !== null
    && simulatedQaScopeMatches(slot.page, projectId, knowledgeVersion, currentJob.generation)
    && slot.page.jobId === currentJob.id
    && slot.page.dataRevision === currentJob.dataRevision
    ? slot.page
    : null
  const formComplete = brief.intervieweeIdentity.trim() !== ''
    && brief.audience.trim() !== ''
    && splitList(brief.focusTopics).length > 0
    && brief.scenario.trim() !== ''
  const preflightMatches = preflight !== null
    && preflight.fence.projectId === projectId
    && preflight.fence.knowledgeVersion === knowledgeVersion
    && preflight.targetCount === target.value
  const highVolumeConfirmationRequired = target.requiresRiskConfirmation || preflight?.confirmationRequired === true
  const risksAccepted = !highVolumeConfirmationRequired || (longerAcknowledged && sparseAcknowledged)
  const jobBlocksStart = currentJob !== null
    && !['completed', 'completed_with_gaps', 'cancelled', 'stale', 'failed'].includes(currentJob.state)
  const canPreflight = knowledgeVersion !== null && target.value !== null && formComplete && !slot.busy && !preflightPending
  const canStart = preflightMatches && risksAccepted && !slot.busy && !jobBlocksStart

  useEffect(() => {
    if (currentJob !== null) setOpen(true)
  }, [currentJob])

  const updateBrief = (field: keyof BriefForm, value: string): void => {
    setBrief((current) => ({ ...current, [field]: value }))
    setPreflight(null)
  }

  const runPreflight = async (): Promise<void> => {
    if (!canPreflight || target.value === null) return
    setPreflightPending(true)
    setPreflightError(null)
    try {
      const result = await slot.onPreflight({ projectId, targetCount: target.value, brief: toBrief(brief) })
      if (result.fence.projectId !== projectId || result.fence.knowledgeVersion !== knowledgeVersion) {
        setPreflightError('项目资料已变化，请重新检查。')
        return
      }
      setPreflight(result)
    } catch {
      setPreflightError('生成前检查失败，请稍后重试。')
    } finally {
      setPreflightPending(false)
    }
  }

  const start = (): void => {
    if (!canStart || preflight === null || target.value === null) return
    void slot.onStart({
      fence: preflight.fence,
      targetCount: target.value,
      brief: toBrief(brief),
      ...(highVolumeConfirmationRequired ? { largeBatchAcknowledged: true } : {}),
    })
  }

  const saveEdit = (): void => {
    if (editing === null || currentJob === null || currentPage === null) return
    void slot.onEdit({
      projectId,
      jobId: currentJob.id,
      itemId: editing.id,
      expectedDataRevision: currentPage.dataRevision,
      question: editing.question,
      answer: editing.answer,
    })
    setEditing(null)
  }

  const approvedCount = currentJob?.approvedCount ?? 0
  const active = currentJob !== null && ['planning', 'generating', 'validating', 'publishing', 'cancel_requested'].includes(currentJob.state)
  const mayConfigure = currentJob === null || ['completed', 'completed_with_gaps', 'cancelled', 'stale', 'failed'].includes(currentJob.state)

  return (
    <section className="simulated-qa" aria-labelledby="simulated-qa-title">
      <div className="simulated-qa__header">
        <div><Sparkles aria-hidden="true" /><span><strong id="simulated-qa-title">模拟问答助手</strong><small>基于当前项目资料生成可审阅的预设 QA</small></span></div>
        <button type="button" aria-expanded={open} onClick={() => { setOpen((value) => !value) }}>{open ? '收起' : '开始准备'}</button>
      </div>

      {open ? <div className="simulated-qa__body">
        <p className="simulated-qa__project">当前项目：<strong>{projectName}</strong></p>
        {knowledgeVersion === null ? <div className="simulated-qa__notice" role="status"><CircleAlert aria-hidden="true" />项目知识尚未就绪，暂不启动生成。</div> : null}

        {mayConfigure ? <form className="simulated-qa__form" onSubmit={(event) => { event.preventDefault(); if (preflightMatches) start(); else void runPreflight() }}>
          <label>被提问对象的身份<input value={brief.intervieweeIdentity} onChange={(event) => { updateBrief('intervieweeIdentity', event.currentTarget.value) }} placeholder="例如：项目负责人、品牌方、创始人" required /></label>
          <label>提问者 / 听众是谁<input value={brief.audience} onChange={(event) => { updateBrief('audience', event.currentTarget.value) }} placeholder="例如：客户 CEO、投资人、采购负责人" required /></label>
          <label>对方最关心什么？<textarea value={brief.focusTopics} onChange={(event) => { updateBrief('focusTopics', event.currentTarget.value) }} placeholder="多项可用换行或逗号分隔" required /></label>
          <label>什么会议或沟通场景？<input value={brief.scenario} onChange={(event) => { updateBrief('scenario', event.currentTarget.value) }} placeholder="例如：项目路演、产品评审" required /></label>
          <label>回答详细度<select value={brief.answerStyle} onChange={(event) => { updateBrief('answerStyle', event.currentTarget.value as QaSimulationBrief['answerStyle']) }}><option value="concise">简洁</option><option value="standard">标准</option><option value="detailed">详细</option></select></label>
          <label>禁答内容（可选）<textarea value={brief.excludedTopics} onChange={(event) => { updateBrief('excludedTopics', event.currentTarget.value) }} placeholder="多项可用换行或逗号分隔" /></label>
          <label>期望问答数量<input type="text" inputMode="numeric" value={targetInput} aria-describedby="simulated-qa-target-help" onChange={(event) => { setTargetInput(event.currentTarget.value); setPreflight(null); setLongerAcknowledged(false); setSparseAcknowledged(false) }} /></label>
          <small id="simulated-qa-target-help">默认 30，50 不是上限；超大任务需拆分。证据不足时不凑数，会交付可靠 QA 与资料缺口。</small>
          {target.error !== null ? <span className="simulated-qa__error" role="alert">{target.error}</span> : null}
          {highVolumeConfirmationRequired ? <fieldset className="simulated-qa__risks"><legend>数量超过 40，请确认两项风险</legend><label><input type="checkbox" checked={longerAcknowledged} onChange={(event) => { setLongerAcknowledged(event.currentTarget.checked) }} />制作时间会更长</label><label><input type="checkbox" checked={sparseAcknowledged} onChange={(event) => { setSparseAcknowledged(event.currentTarget.checked) }} />资料较少时，强求该数量容易变成凑数；QAing 不会凑数，证据不足会改列资料缺口</label></fieldset> : null}
          {preflightError !== null ? <div className="simulated-qa__error" role="alert">{preflightError}</div> : null}
          {slot.error !== null ? <div className="simulated-qa__error" role="alert">{slot.error}</div> : null}
          <button type="submit" className="is-primary" disabled={preflightMatches ? !canStart : !canPreflight}>{preflightPending ? <Loader2 aria-hidden="true" className="spin" /> : <Sparkles aria-hidden="true" />}{preflightMatches ? '生成模拟问答' : '生成前检查'}</button>
        </form> : null}

        {currentJob !== null ? <section className="simulated-qa__status" aria-labelledby="simulated-qa-progress-title"><div><strong id="simulated-qa-progress-title">{PHASE_LABELS[currentJob.state]}</strong><span>可靠 {currentJob.reliableCount} 条 · 缺口 {currentJob.gapCount} 项</span></div>{active ? <Loader2 aria-hidden="true" className="spin" /> : <ShieldCheck aria-hidden="true" />}<progress max={Math.max(1, currentJob.totalBatches)} value={Math.min(currentJob.completedBatches, Math.max(1, currentJob.totalBatches))}>{currentJob.completedBatches} / {currentJob.totalBatches}</progress><span className="sr-only" aria-live="polite">{PHASE_LABELS[currentJob.state]}，已处理 {currentJob.completedBatches} / {currentJob.totalBatches} 批</span>{currentJob.errorCode !== null ? <div className="simulated-qa__error" role="alert">任务未完成，可重试或导出诊断。</div> : null}{slot.error !== null ? <div className="simulated-qa__error" role="alert">{slot.error}</div> : null}{active && currentJob.state !== 'cancel_requested' ? <button type="button" onClick={() => { void slot.onCancel(projectId, currentJob.id) }} disabled={slot.busy}><Square aria-hidden="true" />取消</button> : null}{['paused', 'interrupted'].includes(currentJob.state) ? <button type="button" onClick={() => { void slot.onResume(projectId, currentJob.id) }} disabled={slot.busy}>继续</button> : null}</section> : null}

        {currentJob?.state === 'review_required' ? <section className="simulated-qa__review" aria-labelledby="simulated-qa-review-title"><div className="simulated-qa__review-heading"><div><strong id="simulated-qa-review-title">逐条审阅</strong><span>全任务已批准 {approvedCount} 条，任务可靠 {currentJob.reliableCount} 条</span></div><button type="button" className="is-primary" onClick={() => { void slot.onPublish({ projectId, jobId: currentJob.id, expectedDataRevision: currentJob.dataRevision }) }} disabled={slot.busy || approvedCount === 0}><Check aria-hidden="true" />发布已批准 QA</button></div>{currentPage === null ? <div className="simulated-qa__notice" role="status"><Loader2 aria-hidden="true" className="spin" />正在读取当前审阅页…</div> : <><div className="simulated-qa__drafts">{currentPage.items.map((item) => <article key={item.id} className="simulated-qa__draft">{editing?.id === item.id ? <div className="simulated-qa__edit"><label>问题<textarea value={editing.question} onChange={(event) => { setEditing({ ...editing, question: event.currentTarget.value }) }} /></label><label>回答<textarea value={editing.answer} onChange={(event) => { setEditing({ ...editing, answer: event.currentTarget.value }) }} /></label><button type="button" onClick={saveEdit} disabled={slot.busy || editing.question.trim() === '' || editing.answer.trim() === ''}><Save aria-hidden="true" />保存</button><button type="button" onClick={() => { setEditing(null) }}>取消编辑</button></div> : <><h4>{item.question}</h4><p>{item.answer}</p><details><summary><FileQuestion aria-hidden="true" />查看证据（{item.citations.length}）</summary>{item.citations.length === 0 ? <p>未返回可核验证据，不应批准。</p> : <ul>{item.citations.map((citation) => <li key={`${citation.documentId}:${citation.chunkId}`}><strong>{citation.title}</strong><q>{citation.excerpt}</q></li>)}</ul>}</details><div><button type="button" onClick={() => { setEditing(item) }} disabled={slot.busy}><Pencil aria-hidden="true" />编辑</button><button type="button" aria-pressed={item.status === 'human_approved'} onClick={() => { void slot.onReview({ projectId, jobId: currentJob.id, itemIds: [item.id], expectedDataRevision: currentPage.dataRevision, decision: item.status === 'human_approved' ? 'reject' : 'approve' }) }} disabled={slot.busy || item.citations.length === 0}><Check aria-hidden="true" />{item.status === 'human_approved' ? '已批准' : '批准'}</button></div></>}</article>)}</div>{currentPage.gaps.length > 0 ? <aside className="simulated-qa__gaps"><strong>资料缺口</strong><ul>{currentPage.gaps.map((gap) => <li key={gap.id}><span>{gap.topic}</span>{gap.suggestedMaterial}</li>)}</ul></aside> : null}<nav className="simulated-qa__pagination" aria-label="模拟问答审阅分页"><button type="button" disabled={slot.busy || !slot.canPageBackward} onClick={() => { void slot.onPage(projectId, currentJob.id, 'previous', null, currentPage.dataRevision) }}><ChevronLeft aria-hidden="true" />上一页</button><span>第 {slot.pageIndex + 1} 页</span><button type="button" disabled={slot.busy || currentPage.nextCursor === null} onClick={() => { void slot.onPage(projectId, currentJob.id, 'next', currentPage.nextCursor, currentPage.dataRevision) }}>下一页<ChevronRight aria-hidden="true" /></button></nav></>}</section> : null}
      </div> : null}
    </section>
  )
}
