import { describe, expect, it, vi } from 'vitest'
import {
  requireMacAudioPermission,
  requestMacAudioPermission,
  type MacAudioPermissionGateway,
  type MacMediaAccessStatus,
} from './permissions'

function gateway(initial: MacMediaAccessStatus): MacAudioPermissionGateway & {
  status: MacMediaAccessStatus
} {
  return {
    status: initial,
    getMediaAccessStatus: vi.fn(function (this: { status: MacMediaAccessStatus }) {
      return this.status
    }),
    askForMicrophoneAccess: vi.fn(async () => true),
    enumerateScreensForConsent: vi.fn(async () => undefined),
  }
}

describe('requestMacAudioPermission', () => {
  it('returns granted without requesting an already-granted permission', async () => {
    const input = gateway('granted')

    await expect(requestMacAudioPermission('microphone', input)).resolves.toEqual({ status: 'granted' })
    expect(input.askForMicrophoneAccess).not.toHaveBeenCalled()
    expect(input.enumerateScreensForConsent).not.toHaveBeenCalled()
  })

  it('performs one explicit microphone request and returns a granted outcome', async () => {
    const input = gateway('not-determined')
    vi.mocked(input.getMediaAccessStatus)
      .mockReturnValueOnce('not-determined')
      .mockReturnValueOnce('granted')

    await expect(requestMacAudioPermission('microphone', input)).resolves.toEqual({ status: 'granted' })
    expect(input.askForMicrophoneAccess).toHaveBeenCalledOnce()
    expect(input.getMediaAccessStatus).toHaveBeenCalledTimes(2)
    expect(input.enumerateScreensForConsent).not.toHaveBeenCalled()
  })

  it('returns required when the user denies the microphone request', async () => {
    const input = gateway('not-determined')
    vi.mocked(input.askForMicrophoneAccess).mockResolvedValue(false)

    await expect(requestMacAudioPermission('microphone', input)).resolves.toEqual({
      status: 'required',
      code: 'MICROPHONE_PERMISSION_REQUIRED',
    })
    expect(input.askForMicrophoneAccess).toHaveBeenCalledOnce()
  })

  it.each(['not-determined', 'unknown'] as const)(
    'does not report microphone access as granted when the final OS status is %s',
    async (finalStatus) => {
      const input = gateway('not-determined')
      vi.mocked(input.getMediaAccessStatus)
        .mockReturnValueOnce('not-determined')
        .mockReturnValueOnce(finalStatus)

      const result = await requestMacAudioPermission('microphone', input)

      expect(result.status).toBe('restart_required')
      if (result.status !== 'granted') {
        expect(result.code).toBe('MICROPHONE_PERMISSION_RESTART_REQUIRED')
      }
      expect(input.askForMicrophoneAccess).toHaveBeenCalledOnce()
    },
  )

  it.each(['denied', 'restricted'] as const)(
    'does not issue a futile microphone request when the status is %s',
    async (status) => {
      const input = gateway(status)

      await expect(requestMacAudioPermission('microphone', input)).resolves.toEqual({
        status: 'required',
        code: 'MICROPHONE_PERMISSION_REQUIRED',
      })
      expect(input.askForMicrophoneAccess).not.toHaveBeenCalled()
    },
  )

  it('classifies a failed microphone request without leaking the OS error', async () => {
    const input = gateway('not-determined')
    vi.mocked(input.askForMicrophoneAccess).mockRejectedValue(new Error('private OS detail'))

    await expect(requestMacAudioPermission('microphone', input)).resolves.toEqual({
      status: 'preflight_failed',
      code: 'MICROPHONE_PERMISSION_PREFLIGHT_FAILED',
    })
  })

  it('enumerates screens once and returns granted only after the OS confirms access', async () => {
    const input = gateway('not-determined')
    vi.mocked(input.getMediaAccessStatus)
      .mockReturnValueOnce('not-determined')
      .mockReturnValueOnce('granted')

    await expect(requestMacAudioPermission('system', input)).resolves.toEqual({ status: 'granted' })
    expect(input.enumerateScreensForConsent).toHaveBeenCalledOnce()
    expect(input.getMediaAccessStatus).toHaveBeenCalledTimes(2)
  })

  it.each(['denied', 'restricted'] as const)(
    'does not enumerate screens when system permission is already %s',
    async (status) => {
      const input = gateway(status)

      await expect(requestMacAudioPermission('system', input)).resolves.toEqual({
        status: 'required',
        code: 'SCREEN_PERMISSION_REQUIRED',
      })
      expect(input.enumerateScreensForConsent).not.toHaveBeenCalled()
    },
  )

  it('returns required when denial is observed after the screen request', async () => {
    const input = gateway('not-determined')
    vi.mocked(input.getMediaAccessStatus)
      .mockReturnValueOnce('not-determined')
      .mockReturnValueOnce('denied')

    await expect(requestMacAudioPermission('system', input)).resolves.toEqual({
      status: 'required',
      code: 'SCREEN_PERMISSION_REQUIRED',
    })
  })

  it.each(['not-determined', 'unknown'] as const)(
    'returns restart_required when screen permission remains %s after one request',
    async (status) => {
      const input = gateway(status)

      await expect(requestMacAudioPermission('system', input)).resolves.toEqual({
        status: 'restart_required',
        code: 'SCREEN_PERMISSION_RESTART_REQUIRED',
      })
      expect(input.enumerateScreensForConsent).toHaveBeenCalledOnce()
    },
  )

  it('classifies screen enumeration failure without leaking the OS error', async () => {
    const input = gateway('not-determined')
    vi.mocked(input.enumerateScreensForConsent).mockRejectedValue(new Error('private OS detail'))

    await expect(requestMacAudioPermission('system', input)).resolves.toEqual({
      status: 'preflight_failed',
      code: 'SCREEN_PERMISSION_PREFLIGHT_FAILED',
    })
  })

  it.each(['microphone', 'system'] as const)(
    'converts a %s status API exception into a controlled preflight outcome',
    async (source) => {
      const input = gateway('not-determined')
      vi.mocked(input.getMediaAccessStatus).mockImplementation(() => {
        throw new Error('private OS detail')
      })

      await expect(requestMacAudioPermission(source, input)).resolves.toEqual({
        status: 'preflight_failed',
        code: source === 'microphone'
          ? 'MICROPHONE_PERMISSION_PREFLIGHT_FAILED'
          : 'SCREEN_PERMISSION_PREFLIGHT_FAILED',
      })
      expect(input.askForMicrophoneAccess).not.toHaveBeenCalled()
      expect(input.enumerateScreensForConsent).not.toHaveBeenCalled()
    },
  )

  it('classifies a failure while rechecking screen permission', async () => {
    const input = gateway('not-determined')
    vi.mocked(input.getMediaAccessStatus)
      .mockReturnValueOnce('not-determined')
      .mockImplementationOnce(() => {
        throw new Error('private OS detail')
      })

    await expect(requestMacAudioPermission('system', input)).resolves.toEqual({
      status: 'preflight_failed',
      code: 'SCREEN_PERMISSION_PREFLIGHT_FAILED',
    })
  })
})

describe('requireMacAudioPermission', () => {
  it.each(['microphone', 'system'] as const)('passes only an already-granted %s permission', (source) => {
    const input = gateway('granted')

    expect(() => requireMacAudioPermission(source, input)).not.toThrow()
    expect(input.askForMicrophoneAccess).not.toHaveBeenCalled()
    expect(input.enumerateScreensForConsent).not.toHaveBeenCalled()
  })

  it.each([
    ['microphone', 'not-determined', 'MICROPHONE_PERMISSION_REQUIRED'],
    ['microphone', 'denied', 'MICROPHONE_PERMISSION_REQUIRED'],
    ['microphone', 'restricted', 'MICROPHONE_PERMISSION_REQUIRED'],
    ['system', 'not-determined', 'SCREEN_PERMISSION_REQUIRED'],
    ['system', 'denied', 'SCREEN_PERMISSION_REQUIRED'],
    ['system', 'restricted', 'SCREEN_PERMISSION_REQUIRED'],
  ] as const)(
    'rejects %s status %s without causing request side effects',
    (source, status, code) => {
      const input = gateway(status)

      expect(() => requireMacAudioPermission(source, input)).toThrowError(expect.objectContaining({ code }))
      expect(input.askForMicrophoneAccess).not.toHaveBeenCalled()
      expect(input.enumerateScreensForConsent).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['microphone', 'MICROPHONE_PERMISSION_RESTART_REQUIRED'],
    ['system', 'SCREEN_PERMISSION_RESTART_REQUIRED'],
  ] as const)('rejects unknown %s status as restart_required', (source, code) => {
    const input = gateway('unknown')

    expect(() => requireMacAudioPermission(source, input)).toThrowError(expect.objectContaining({ code }))
    expect(input.askForMicrophoneAccess).not.toHaveBeenCalled()
    expect(input.enumerateScreensForConsent).not.toHaveBeenCalled()
  })

  it.each([
    ['microphone', 'MICROPHONE_PERMISSION_PREFLIGHT_FAILED'],
    ['system', 'SCREEN_PERMISSION_PREFLIGHT_FAILED'],
  ] as const)('classifies a %s status read exception as preflight_failed', (source, code) => {
    const input = gateway('granted')
    vi.mocked(input.getMediaAccessStatus).mockImplementation(() => {
      throw new Error('private OS detail')
    })

    expect(() => requireMacAudioPermission(source, input)).toThrowError(expect.objectContaining({ code }))
    expect(input.askForMicrophoneAccess).not.toHaveBeenCalled()
    expect(input.enumerateScreensForConsent).not.toHaveBeenCalled()
  })
})
