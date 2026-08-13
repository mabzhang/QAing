import {
  CheckCircle2,
  Cpu,
  KeyRound,
  Loader2,
  Mic,
  Pin,
  Radio,
  ShieldCheck,
  Trash2,
  Volume2,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { AudioPermissionRequestResult } from '../../core/contracts'
import type { AudioSourceKind } from '../../core/types'
import type {
  PermissionState,
  CloudProviderKind,
  SettingsSection,
  UiActionName,
  UiEnvironment,
} from './contracts'
import { PERMISSION_LABELS } from './view-model'
import { DrawerShell } from './DrawerShell'

interface SettingsDrawerProps {
  readonly section: SettingsSection
  readonly environment: UiEnvironment
  readonly pendingAction: UiActionName | null
  readonly actionError: string | null
  readonly mutationLocked: boolean
  readonly onClose: () => void
  readonly onConfigureProvider: (provider: CloudProviderKind, credential: string) => void
  readonly onClearProvider: (provider: CloudProviderKind) => void
  readonly onOpenPermission: (source: AudioSourceKind) => void
  readonly onRequestAudioPermission: (source: AudioSourceKind) => void
  readonly onRestartApplication: () => void
  readonly permissionRequestResults: Readonly<Partial<Record<AudioSourceKind, AudioPermissionRequestResult>>>
  readonly onSetAlwaysOnTop: (enabled: boolean) => void
}

const PROVIDERS: readonly {
  provider: CloudProviderKind
  name: string
  role: string
  placeholder: string
  icon: LucideIcon
}[] = [
  {
    provider: 'deepseek',
    name: 'DeepSeek V4 Flash',
    role: '候选与确定答案整合',
    placeholder: '输入 DeepSeek API Key',
    icon: Radio,
  },
  {
    provider: 'doubao_asr',
    name: '豆包 SeedASR',
    role: '云端双向流式语音转写',
    placeholder: '输入豆包 ASR API Key',
    icon: Mic,
  },
]

const PERMISSIONS: readonly {
  source: AudioSourceKind
  name: string
  description: string
  icon: LucideIcon
}[] = [
  {
    source: 'system',
    name: '系统音频权限',
    description: '用于捕获会议、播放器和线上路演声音。',
    icon: Volume2,
  },
  {
    source: 'microphone',
    name: '麦克风权限',
    description: '用于捕获现场提问和面对面交流。',
    icon: Mic,
  },
]

function PermissionStatus({ permission }: { readonly permission: PermissionState }): React.JSX.Element {
  const Icon = permission === 'granted' ? CheckCircle2 : permission === 'checking' ? Loader2 : ShieldCheck
  return (
    <span className={`drawer-status drawer-status--${permission}`}>
      <Icon aria-hidden="true" className={permission === 'checking' ? 'spin' : undefined} />
      {PERMISSION_LABELS[permission]}
    </span>
  )
}

export function SettingsDrawer({
  section,
  environment,
  pendingAction,
  actionError,
  mutationLocked,
  onClose,
  onConfigureProvider,
  onClearProvider,
  onOpenPermission,
  onRequestAudioPermission,
  onRestartApplication,
  permissionRequestResults,
  onSetAlwaysOnTop,
}: SettingsDrawerProps): React.JSX.Element {
  const [credentials, setCredentials] = useState<Readonly<Record<CloudProviderKind, string>>>(() => ({
    deepseek: '',
    doubao_asr: '',
  }))
  const [pendingClear, setPendingClear] = useState<CloudProviderKind | null>(null)
  const busy = pendingAction !== null
  const mutationsDisabled = busy || mutationLocked
  const embedding = environment.providerStatuses.embedding
  const localModelState = environment.retrievalMode === 'keyword_fallback'
    ? 'fallback'
    : embedding.configured
      ? 'ready'
      : environment.retrievalHealth === 'searching'
        ? 'loading'
        : 'missing'
  const localModelLabel = {
    missing: '未下载',
    loading: '加载中',
    ready: '已就绪',
    fallback: '关键词降级',
  }[localModelState]

  const submitProvider = (provider: CloudProviderKind): void => {
    const credential = credentials[provider].trim()
    if (credential.length < 8 || mutationsDisabled) return
    setCredentials((current) => ({ ...current, [provider]: '' }))
    setPendingClear(null)
    onConfigureProvider(provider, credential)
  }

  return (
    <DrawerShell
      title="设置与连接"
      description="管理窗口行为、供应商凭据与 macOS 音频权限。"
      icon={ShieldCheck}
      busy={busy}
      actionError={actionError}
      onClose={onClose}
    >
      {mutationLocked ? (
        <div className="drawer-session-lock" role="status">
          <ShieldCheck aria-hidden="true" />
          <span>当前会话进行中：窗口置顶仍可调整，服务和权限配置需在本轮结束后修改。</span>
        </div>
      ) : null}
      <section className="drawer-section" data-section={section === 'general' ? 'active' : 'muted'}>
        <div className="drawer-section__heading">
          <div>
            <span>Window</span>
            <h3>窗口行为</h3>
          </div>
          <p>默认不置顶，避免遮挡演示。需要持续查看时可手动开启。</p>
        </div>
        <label className="window-setting-row">
          <span className="provider-card__icon"><Pin aria-hidden="true" /></span>
          <span className="window-setting-row__copy">
            <strong>始终置顶</strong>
            <small>开启后 QAing 会保持在其他窗口上方，该选择会保存。</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="始终置顶"
            checked={environment.alwaysOnTop}
            disabled={busy}
            onChange={(event) => { onSetAlwaysOnTop(event.currentTarget.checked) }}
          />
          <span className="window-setting-row__switch" aria-hidden="true" />
          <span className="window-setting-row__state">{environment.alwaysOnTop ? '已开启' : '已关闭'}</span>
        </label>
      </section>
      <section className="drawer-section" data-section={section === 'permissions' || section === 'audio' ? 'muted' : 'active'}>
        <div className="drawer-section__heading">
          <div>
            <span>Providers</span>
            <h3>模型与转写服务</h3>
          </div>
          <p>凭据仅提交给主进程安全存储；Renderer 不保留已提交明文。</p>
        </div>

        <div className="provider-list">
          {PROVIDERS.map(({ provider, name, role, placeholder, icon: Icon }) => {
            const status = environment.providerStatuses[provider]
            const value = credentials[provider]
            return (
              <article className="provider-card" key={provider}>
                <header>
                  <span className="provider-card__icon"><Icon aria-hidden="true" /></span>
                  <div>
                    <h4>{name}</h4>
                    <p>{role}</p>
                  </div>
                  <span className={`provider-state${status.configured ? ' is-configured' : ''}`}>
                    {status.configured ? <CheckCircle2 aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
                    {status.configured ? '已配置' : '未配置'}
                  </span>
                </header>
                {status.configured ? (
                  <div className="masked-credential">
                    <KeyRound aria-hidden="true" />
                    <span>{status.maskedKey ?? '已安全保存'}</span>
                    <small>不可回显明文</small>
                  </div>
                ) : null}
                <form
                  className="credential-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    submitProvider(provider)
                  }}
                >
                  <label htmlFor={`provider-${provider}`}>
                    {status.configured ? '更换凭据' : '配置凭据'}
                  </label>
                  <div>
                    <input
                      id={`provider-${provider}`}
                      type="password"
                      autoComplete="new-password"
                      spellCheck={false}
                      value={value}
                      placeholder={placeholder}
                      disabled={mutationsDisabled}
                      minLength={8}
                      maxLength={4096}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.value
                        setCredentials((current) => ({ ...current, [provider]: nextValue }))
                      }}
                    />
                    <button type="submit" disabled={mutationsDisabled || value.trim().length < 8}>
                      {pendingAction === 'configure-provider' ? <Loader2 aria-hidden="true" className="spin" /> : <ShieldCheck aria-hidden="true" />}
                      安全保存
                    </button>
                  </div>
                </form>
                {status.configured ? (
                  pendingClear === provider ? (
                    <div className="provider-clear-confirm" role="group" aria-label={`确认清除 ${name} 凭据`}>
                      <span>清除后需重新输入密钥才能使用。</span>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingClear(null)
                          onClearProvider(provider)
                        }}
                        disabled={mutationsDisabled}
                      >
                        确认清除
                      </button>
                      <button type="button" onClick={() => { setPendingClear(null) }} disabled={busy}>取消</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="danger-text-button"
                      onClick={() => { setPendingClear(provider) }}
                      disabled={mutationsDisabled}
                    >
                      <Trash2 aria-hidden="true" />
                      清除已保存凭据
                    </button>
                  )
                ) : null}
              </article>
            )
          })}
          <article className="provider-card local-model-card">
            <header>
              <span className="provider-card__icon"><Cpu aria-hidden="true" /></span>
              <div>
                <h4>bge-large-zh-v1.5</h4>
                <p>固定的本地中文语义向量模型，不需要 API Key。</p>
              </div>
              <span className={`provider-state local-model-state local-model-state--${localModelState}`}>
                {localModelState === 'loading' ? <Loader2 aria-hidden="true" className="spin" /> : localModelState === 'ready' ? <CheckCircle2 aria-hidden="true" /> : <Cpu aria-hidden="true" />}
                {localModelLabel}
              </span>
            </header>
            <div className="local-model-details">
              <span>1024 维</span>
              <span>最多 512 tokens</span>
              <span>Apple Silicon 本地推理</span>
            </div>
            {localModelState === 'fallback' ? (
              <p className="local-model-warning">语义模型不可用时，系统只执行明示的关键词检索，不会伪造向量结果。</p>
            ) : null}
          </article>
        </div>
      </section>

      <section className="drawer-section" data-section={section === 'permissions' || section === 'audio' ? 'active' : 'muted'}>
        <div className="drawer-section__heading">
          <div>
            <span>macOS privacy</span>
            <h3>音频权限</h3>
          </div>
          <p>权限被拒绝时不启动空会话；授权后请返回 QAing 重试。</p>
        </div>
        <div className="permission-list">
          {PERMISSIONS.map(({ source, name, description, icon: Icon }) => {
            const permission = environment.permissions[source]
            const requestResult = permission === 'granted' ? undefined : permissionRequestResults[source]
            const requestable = permission === 'prompt'
            const needsSettings = permission === 'denied'
              || permission === 'unavailable'
              || requestResult?.status === 'required'
              || requestResult?.status === 'preflight_failed'
            const needsRestart = requestResult?.status === 'restart_required'
              || permission === 'denied'
              || permission === 'unavailable'
            const guide = requestResult?.status === 'granted'
              ? 'macOS 请求已通过，正在等待最终状态同步。'
              : requestResult?.status === 'restart_required'
              ? 'macOS 已接收设置，但当前应用身份尚未生效。'
              : requestResult?.status === 'preflight_failed'
                ? '系统预检未完成。请先在系统设置确认权限。'
                : requestResult?.status === 'required'
                  ? 'macOS 仍未授权。请在系统设置中手动允许 QAing。'
                  : permission === 'granted'
              ? '已完成，开始会话时会再做一次严格校验。'
              : permission === 'checking'
                ? '正在读取 macOS 最终状态，请勿重复点击。'
                : requestable
                  ? '点击一次申请权限，并在 macOS 弹窗中选择。'
                  : '打开系统设置并允许 QAing，返回应用后会重新检查。'
            return (
              <article key={source} className="permission-card">
                <span className="provider-card__icon"><Icon aria-hidden="true" /></span>
                <div>
                  <h4>{name}</h4>
                  <p>{description}</p>
                </div>
                <PermissionStatus permission={permission} />
                <p className="permission-card__guide">{guide}</p>
                {requestable && requestResult === undefined ? (
                  <button
                    type="button"
                    onClick={() => { onRequestAudioPermission(source) }}
                    disabled={mutationsDisabled}
                  >
                    申请权限
                  </button>
                ) : needsSettings ? (
                  <button type="button" onClick={() => { onOpenPermission(source) }} disabled={mutationsDisabled}>
                    打开系统设置
                  </button>
                ) : (
                  <button type="button" disabled>
                    {permission === 'checking'
                      ? '正在检查…'
                      : requestResult?.status === 'restart_required'
                        ? '需要重开'
                        : requestResult?.status === 'granted'
                          ? '正在同步…'
                          : '已完成'}
                  </button>
                )}
                {needsRestart ? (
                  <div className="permission-card__restart">
                    <span>若已在系统设置开启但状态仍未生效，请完全退出并重新打开 QAing。</span>
                    <button type="button" onClick={onRestartApplication} disabled={mutationsDisabled}>
                      完全退出并重开
                    </button>
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      </section>

      <footer className="drawer-security-note">
        <ShieldCheck aria-hidden="true" />
        <p><strong>安全原则</strong><span>API Key 不得进入日志、快照、渲染层持久状态或安装包。</span></p>
      </footer>
    </DrawerShell>
  )
}
