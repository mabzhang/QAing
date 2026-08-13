export type RendererAudioSourceKind = 'microphone' | 'system'

export interface RendererAudioStatus {
  readonly sessionId: string
  readonly source: RendererAudioSourceKind | null
  readonly state: 'ready' | 'starting' | 'capturing' | 'silent' | 'suspended' | 'stopped' | 'error'
  readonly code?: string
  readonly lastFrameTimestampMs?: number
}

export interface NativeAudioBridge {
  start(input: { readonly sessionId: string; readonly source: RendererAudioSourceKind }): Promise<void>
  stop(input: { readonly sessionId: string }): Promise<void>
  onStatus(listener: (status: RendererAudioStatus) => void): () => void
}

export interface AudioSourceCallbacks {
  readonly onEnded?: (reason: 'stopped' | 'error', code?: string) => void
  readonly onStatus?: (status: RendererAudioStatus) => void
}

export interface AudioSource {
  readonly kind: RendererAudioSourceKind
  start(sessionId: string, callbacks: AudioSourceCallbacks): Promise<void>
  stop(): Promise<void>
  isActive(): boolean
}

export class NativeAudioSource implements AudioSource {
  readonly kind: RendererAudioSourceKind
  private readonly bridge: NativeAudioBridge
  private sessionId: string | null = null
  private stopPromise: Promise<void> | null = null
  private removeStatusListener: (() => void) | null = null

  constructor(kind: RendererAudioSourceKind, bridge: NativeAudioBridge) {
    this.kind = kind
    this.bridge = bridge
  }

  async start(sessionId: string, callbacks: AudioSourceCallbacks): Promise<void> {
    if (!isValidSessionId(sessionId)) throw new Error('Invalid audio session identifier')
    if (this.sessionId !== null) {
      if (this.sessionId === sessionId) return
      throw new Error('Audio source is already active')
    }
    this.sessionId = sessionId
    this.removeStatusListener = this.bridge.onStatus((status) => {
      if (status.sessionId !== this.sessionId || (status.source !== null && status.source !== this.kind)) return
      callbacks.onStatus?.(status)
      if (status.state === 'stopped') {
        this.cleanup()
        callbacks.onEnded?.('stopped')
      } else if (status.state === 'error' && !isRecoverableCaptureError(status.code)) {
        this.cleanup()
        callbacks.onEnded?.('error', status.code)
      }
    })
    try {
      await this.bridge.start({ sessionId, source: this.kind })
    } catch (error) {
      this.cleanup()
      throw error
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise
    const sessionId = this.sessionId
    if (sessionId === null) return Promise.resolve()
    this.stopPromise = this.bridge.stop({ sessionId }).finally(() => {
      this.cleanup()
      this.stopPromise = null
    })
    return this.stopPromise
  }

  isActive(): boolean {
    return this.sessionId !== null
  }

  private cleanup(): void {
    this.removeStatusListener?.()
    this.removeStatusListener = null
    this.sessionId = null
  }
}

export class SingleActiveAudioSource {
  private active: AudioSource | null = null

  async start(source: AudioSource, sessionId: string, callbacks: AudioSourceCallbacks): Promise<void> {
    if (this.active !== null) {
      if (this.active === source && source.isActive()) return
      throw new Error('Only one audio source may be active per session')
    }
    this.active = source
    try {
      await source.start(sessionId, callbacks)
    } catch (error) {
      this.active = null
      throw error
    }
  }

  async stop(): Promise<void> {
    const source = this.active
    if (source === null) return
    try {
      await source.stop()
    } finally {
      if (this.active === source) this.active = null
    }
  }

  activeKind(): RendererAudioSourceKind | null {
    return this.active?.kind ?? null
  }
}

function isValidSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)
}

function isRecoverableCaptureError(code: string | undefined): boolean {
  return code === 'CAPTURE_INTERRUPTED' || code === 'DEAD_AUDIO_STREAM'
}
