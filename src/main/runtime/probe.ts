import { app, shell, systemPreferences } from 'electron'
import type {
  AudioPermissionRequestResult,
  ProviderName,
  RuntimeStatus,
} from '../../core/contracts'
import type { AudioSourceKind } from '../../core/types'
import type { RuntimeProbe } from '../app/facade'
import type { DataStore } from '../data/database'
import type { IsolatedLocalBgeEmbeddingProvider } from '../data/isolated-bge-provider'
import type { NativeAudioRuntime } from './adapters'

export interface WindowBehaviorPort {
  readonly alwaysOnTop: boolean
  setAlwaysOnTop(enabled: boolean): Promise<void>
}

type RefreshScope = 'runtime' | 'library'
type Listener = (scope: RefreshScope) => void

export class RuntimeSignals {
  readonly #listeners = new Set<Listener>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #pendingScope: RefreshScope = 'runtime'

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  emit(scope: RefreshScope = 'runtime'): void {
    if (scope === 'library') this.#pendingScope = 'library'
    if (this.#timer !== null) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      const pendingScope = this.#pendingScope
      this.#pendingScope = 'runtime'
      for (const listener of this.#listeners) listener(pendingScope)
    }, 100)
    this.#timer.unref?.()
  }
}

function permission(mediaType: 'microphone' | 'screen'): 'unknown' | 'granted' | 'denied' | 'restricted' | 'not_determined' {
  const value = systemPreferences.getMediaAccessStatus(mediaType)
  if (value === 'granted' || value === 'denied' || value === 'restricted') return value
  if (value === 'not-determined') return 'not_determined'
  return 'unknown'
}

export class MacRuntimeProbe implements RuntimeProbe {
  readonly #provider: IsolatedLocalBgeEmbeddingProvider
  readonly #store: DataStore
  readonly #audio: NativeAudioRuntime
  readonly #signals: RuntimeSignals
  readonly #windowBehavior: WindowBehaviorPort
  readonly #requestAudioPermission: (source: AudioSourceKind) => Promise<AudioPermissionRequestResult>
  readonly #restartApplication: () => Promise<void>

  constructor(input: {
    readonly provider: IsolatedLocalBgeEmbeddingProvider
    readonly store: DataStore
    readonly audio: NativeAudioRuntime
    readonly signals: RuntimeSignals
    readonly windowBehavior: WindowBehaviorPort
    readonly requestAudioPermission: (source: AudioSourceKind) => Promise<AudioPermissionRequestResult>
    readonly restartApplication: () => Promise<void>
  }) {
    this.#provider = input.provider
    this.#store = input.store
    this.#audio = input.audio
    this.#signals = input.signals
    this.#windowBehavior = input.windowBehavior
    this.#requestAudioPermission = input.requestAudioPermission
    this.#restartApplication = input.restartApplication
  }

  subscribe(listener: Listener): () => void {
    return this.#signals.subscribe(listener)
  }

  async getStatus(): Promise<Omit<RuntimeStatus, 'providerStatuses'>> {
    const readiness = this.#provider.readiness
    const remaining = this.#store.listUnembeddedOwners(this.#provider.metadata, 1).length
    const retrievalMode: RuntimeStatus['retrievalMode'] = readiness === 'ready'
      ? remaining === 0 ? 'hybrid' : 'index_loading'
      : readiness === 'failed' ? 'keyword_fallback' : 'index_loading'
    return {
      platform: 'darwin-arm64',
      appVersion: app.getVersion(),
      retrievalMode,
      audioPermission: permission('microphone'),
      screenAudioPermission: (() => {
        const value = permission('screen')
        return value === 'restricted' ? 'denied' : value
      })(),
      helperStatus: this.#audio.status,
      alwaysOnTop: this.#windowBehavior.alwaysOnTop,
    }
  }

  async openSystemPermissions(kind: 'microphone' | 'screen_audio'): Promise<void> {
    const section = kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture'
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${section}`)
  }

  async requestAudioPermission(source: AudioSourceKind): Promise<AudioPermissionRequestResult> {
    const result = await this.#requestAudioPermission(source)
    this.#signals.emit()
    return result
  }

  async restartApplication(): Promise<void> {
    await this.#restartApplication()
  }

  async setAlwaysOnTop(enabled: boolean): Promise<void> {
    await this.#windowBehavior.setAlwaysOnTop(enabled)
    this.#signals.emit()
  }

  async onProviderChanged(provider: ProviderName): Promise<void> {
    void provider
    this.#signals.emit()
  }
}
