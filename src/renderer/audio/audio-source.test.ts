import { describe, expect, it, vi } from 'vitest'
import {
  NativeAudioSource,
  SingleActiveAudioSource,
  type NativeAudioBridge,
  type RendererAudioStatus,
} from './audio-source'

class FakeBridge implements NativeAudioBridge {
  readonly starts: Array<{ sessionId: string; source: 'microphone' | 'system' }> = []
  readonly stops: string[] = []
  private readonly statusListeners = new Set<(status: RendererAudioStatus) => void>()

  async start(input: { sessionId: string; source: 'microphone' | 'system' }): Promise<void> {
    this.starts.push(input)
  }

  async stop(input: { sessionId: string }): Promise<void> {
    this.stops.push(input.sessionId)
  }

  onStatus(listener: (status: RendererAudioStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  status(status: RendererAudioStatus): void {
    for (const listener of this.statusListeners) listener(status)
  }
}

describe('NativeAudioSource', () => {
  it('filters stale sessions and other sources while forwarding non-PCM status', async () => {
    const bridge = new FakeBridge()
    const source = new NativeAudioSource('system', bridge)
    const onStatus = vi.fn()
    await source.start('current', { onStatus })
    bridge.status({ sessionId: 'stale', source: 'system', state: 'capturing' })
    bridge.status({ sessionId: 'current', source: 'microphone', state: 'capturing' })
    bridge.status({ sessionId: 'current', source: 'system', state: 'silent', code: 'ZERO_ENERGY' })
    expect(onStatus).toHaveBeenCalledOnce()
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'silent' }))
  })

  it('keeps transitional suspension/restart active and only ends on terminal status', async () => {
    const bridge = new FakeBridge()
    const source = new NativeAudioSource('microphone', bridge)
    const onEnded = vi.fn()
    await source.start('s1', { onEnded })
    bridge.status({ sessionId: 's1', source: 'microphone', state: 'suspended' })
    bridge.status({ sessionId: 's1', source: 'microphone', state: 'error', code: 'CAPTURE_INTERRUPTED' })
    bridge.status({ sessionId: 's1', source: 'microphone', state: 'capturing' })
    expect(source.isActive()).toBe(true)
    bridge.status({ sessionId: 's1', source: 'microphone', state: 'error', code: 'PERMISSION_DENIED' })
    expect(onEnded.mock.calls).toEqual([
      ['error', 'PERMISSION_DENIED'],
    ])
    expect(source.isActive()).toBe(false)
  })

  it('stops idempotently and removes native listeners', async () => {
    const bridge = new FakeBridge()
    const source = new NativeAudioSource('system', bridge)
    const onStatus = vi.fn()
    await source.start('s1', { onStatus })
    const first = source.stop()
    expect(source.stop()).toBe(first)
    await first
    expect(bridge.stops).toEqual(['s1'])
    bridge.status({ sessionId: 's1', source: 'system', state: 'capturing' })
    expect(onStatus).not.toHaveBeenCalled()
  })
})

describe('SingleActiveAudioSource', () => {
  it('prevents simultaneous microphone and system capture', async () => {
    const bridge = new FakeBridge()
    const coordinator = new SingleActiveAudioSource()
    const microphone = new NativeAudioSource('microphone', bridge)
    const system = new NativeAudioSource('system', bridge)
    await coordinator.start(microphone, 's1', {})
    await expect(coordinator.start(system, 's1', {})).rejects.toThrow('Only one audio source')
    expect(coordinator.activeKind()).toBe('microphone')
    await coordinator.stop()
    expect(coordinator.activeKind()).toBeNull()
  })
})
