import type { AudioSourceKind } from '../../core/types'

export type MacMediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export interface MacAudioPermissionStatusGateway {
  readonly getMediaAccessStatus: (kind: 'microphone' | 'screen') => MacMediaAccessStatus
}

export interface MacAudioPermissionGateway extends MacAudioPermissionStatusGateway {
  readonly askForMicrophoneAccess: () => Promise<boolean>
  readonly enumerateScreensForConsent: () => Promise<void>
}

export type MacAudioPermissionErrorCode =
  | 'MICROPHONE_PERMISSION_REQUIRED'
  | 'MICROPHONE_PERMISSION_RESTART_REQUIRED'
  | 'MICROPHONE_PERMISSION_PREFLIGHT_FAILED'
  | 'SCREEN_PERMISSION_REQUIRED'
  | 'SCREEN_PERMISSION_RESTART_REQUIRED'
  | 'SCREEN_PERMISSION_PREFLIGHT_FAILED'

export type MacAudioPermissionOutcome =
  | { readonly status: 'granted' }
  | {
    readonly status: 'required'
    readonly code: 'MICROPHONE_PERMISSION_REQUIRED' | 'SCREEN_PERMISSION_REQUIRED'
  }
  | {
    readonly status: 'restart_required'
    readonly code: 'MICROPHONE_PERMISSION_RESTART_REQUIRED' | 'SCREEN_PERMISSION_RESTART_REQUIRED'
  }
  | {
    readonly status: 'preflight_failed'
    readonly code: 'MICROPHONE_PERMISSION_PREFLIGHT_FAILED' | 'SCREEN_PERMISSION_PREFLIGHT_FAILED'
  }

export class MacAudioPermissionError extends Error {
  readonly code: MacAudioPermissionErrorCode

  constructor(code: MacAudioPermissionErrorCode) {
    const source = code.startsWith('MICROPHONE_') ? 'Microphone' : 'Screen and system audio recording'
    const reason = code.endsWith('_RESTART_REQUIRED')
      ? 'permission must be rechecked after restarting QAing'
      : code.endsWith('_PREFLIGHT_FAILED')
        ? 'permission preflight failed'
        : 'permission is required'
    super(`${source} ${reason}`)
    this.name = 'MacAudioPermissionError'
    this.code = code
  }
}

/**
 * Performs at most one user-initiated TCC request for the permission wizard.
 * All OS failures are converted to a bounded outcome so the caller can guide
 * the user without leaking native error details or accidentally retrying.
 */
export async function requestMacAudioPermission(
  source: AudioSourceKind,
  gateway: MacAudioPermissionGateway,
): Promise<MacAudioPermissionOutcome> {
  const initialStatus = readStatus(source, gateway)
  if (initialStatus === null) return outcome(source, 'preflight_failed')
  if (initialStatus === 'granted') return { status: 'granted' }
  if (initialStatus === 'denied' || initialStatus === 'restricted') {
    return outcome(source, 'required')
  }

  if (source === 'microphone') {
    let requestGranted: boolean
    try {
      requestGranted = await gateway.askForMicrophoneAccess()
    } catch {
      return outcome(source, 'preflight_failed')
    }
    if (!requestGranted) return outcome(source, 'required')

    // The request result says what the user selected, while the OS status is
    // the capture authority. Do not call an unresolved status "granted".
    return outcomeAfterRequest(source, readStatus(source, gateway))
  }

  // Discard all source metadata. Production PCM remains helper -> main -> ASR.
  try {
    await gateway.enumerateScreensForConsent()
  } catch {
    return outcome(source, 'preflight_failed')
  }

  return outcomeAfterRequest(source, readStatus(source, gateway))
}

/**
 * Strict capture-start gate. It never prompts, enumerates screens, or performs
 * any other side effect: only an already-granted OS status may pass.
 */
export function requireMacAudioPermission(
  source: AudioSourceKind,
  gateway: MacAudioPermissionStatusGateway,
): void {
  const status = readStatus(source, gateway)
  if (status === 'granted') return
  if (status === null) {
    throw new MacAudioPermissionError(codeFor(source, 'preflight_failed'))
  }
  if (status === 'unknown') {
    throw new MacAudioPermissionError(codeFor(source, 'restart_required'))
  }
  throw new MacAudioPermissionError(codeFor(source, 'required'))
}

function readStatus(
  source: AudioSourceKind,
  gateway: MacAudioPermissionStatusGateway,
): MacMediaAccessStatus | null {
  try {
    return gateway.getMediaAccessStatus(source === 'microphone' ? 'microphone' : 'screen')
  } catch {
    return null
  }
}

function outcome(
  source: AudioSourceKind,
  status: Exclude<MacAudioPermissionOutcome['status'], 'granted'>,
): MacAudioPermissionOutcome {
  const prefix = source === 'microphone' ? 'MICROPHONE' : 'SCREEN'
  if (status === 'restart_required') {
    return { status, code: `${prefix}_PERMISSION_RESTART_REQUIRED` }
  }
  if (status === 'preflight_failed') {
    return { status, code: `${prefix}_PERMISSION_PREFLIGHT_FAILED` }
  }
  return { status, code: `${prefix}_PERMISSION_REQUIRED` }
}

function outcomeAfterRequest(
  source: AudioSourceKind,
  status: MacMediaAccessStatus | null,
): MacAudioPermissionOutcome {
  if (status === null) return outcome(source, 'preflight_failed')
  if (status === 'granted') return { status: 'granted' }
  if (status === 'denied' || status === 'restricted') return outcome(source, 'required')

  // Consent can remain prompt/unknown until the signed application is
  // relaunched. Never treat that state as permission to start capture.
  return outcome(source, 'restart_required')
}

function codeFor(
  source: AudioSourceKind,
  reason: Exclude<MacAudioPermissionOutcome['status'], 'granted'>,
): MacAudioPermissionErrorCode {
  const prefix = source === 'microphone' ? 'MICROPHONE' : 'SCREEN'
  if (reason === 'restart_required') return `${prefix}_PERMISSION_RESTART_REQUIRED`
  if (reason === 'preflight_failed') return `${prefix}_PERMISSION_PREFLIGHT_FAILED`
  return `${prefix}_PERMISSION_REQUIRED`
}
