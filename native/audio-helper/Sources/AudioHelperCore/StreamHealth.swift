import Foundation

public enum StreamHealthEvent: Equatable, Sendable {
    case silent
    case recovered
    case dead
}

/// Distinguishes a healthy stream carrying zero-energy frames from a stream
/// that stopped delivering frames entirely. Callers provide monotonic seconds.
public struct AudioStreamHealthMonitor: Sendable {
    private let silenceThreshold: Float
    private let silenceDuration: TimeInterval
    private let deadStreamDuration: TimeInterval
    private var lastFrameAt: TimeInterval
    private var lastLivenessAt: TimeInterval
    private var silenceStartedAt: TimeInterval?
    private var silentReported = false
    private var deadReported = false

    public init(
        startedAt: TimeInterval,
        silenceThreshold: Float = 0.001,
        silenceDuration: TimeInterval = 10,
        deadStreamDuration: TimeInterval = 10
    ) {
        self.silenceThreshold = silenceThreshold
        self.silenceDuration = silenceDuration
        self.deadStreamDuration = deadStreamDuration
        self.lastFrameAt = startedAt
        self.lastLivenessAt = startedAt
    }

    public mutating func observeFrame(energy: Float, at now: TimeInterval) -> StreamHealthEvent? {
        lastFrameAt = now
        lastLivenessAt = now
        deadReported = false
        if energy <= silenceThreshold {
            if silenceStartedAt == nil { silenceStartedAt = now }
            if !silentReported, now - (silenceStartedAt ?? now) >= silenceDuration {
                silentReported = true
                return .silent
            }
            return nil
        }
        silenceStartedAt = nil
        if silentReported {
            silentReported = false
            return .recovered
        }
        return nil
    }

    /// Records an independent native-stream liveness signal (for example a
    /// low-rate ScreenCaptureKit screen sample when system audio is silent).
    public mutating func observeLiveness(at now: TimeInterval) {
        lastLivenessAt = now
        deadReported = false
    }

    public mutating func check(at now: TimeInterval) -> StreamHealthEvent? {
        if !deadReported, now - lastLivenessAt > deadStreamDuration {
            deadReported = true
            return .dead
        }
        if !silentReported, now - lastFrameAt >= silenceDuration {
            silentReported = true
            silenceStartedAt = lastFrameAt
            return .silent
        }
        return nil
    }
}
