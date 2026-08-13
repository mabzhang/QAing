import AppKit
import AudioHelperCore
import Foundation

final class CaptureCoordinator: @unchecked Sendable {
    private struct Active {
        let sessionId: String
        let source: AudioSource
        let generation: UInt64
    }

    private let writer: OutputWriter
    private let queue = DispatchQueue(label: "com.qaing.audio-helper.capture")
    private var active: Active?
    private var capture: NativeCapture?
    private var processor = StreamingAudioProcessor()
    private var sequence: UInt64 = 0
    private var generation: UInt64 = 0
    private var sleeping = false
    private var captureRunning = false
    private var healthMonitor: AudioStreamHealthMonitor?
    private var lastFrameTimestampMs: UInt64?
    private let healthTimer: DispatchSourceTimer
    private var observers: [NSObjectProtocol] = []

    init(writer: OutputWriter) {
        self.writer = writer
        healthTimer = DispatchSource.makeTimerSource(queue: queue)
        healthTimer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in self?.suspendForSleep() })
        observers.append(center.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in self?.resumeAfterWake() })
        healthTimer.setEventHandler { [weak self] in self?.checkStreamHealth() }
        healthTimer.resume()
    }

    deinit {
        healthTimer.cancel()
        for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    }

    func handle(_ command: HelperCommand) {
        queue.async { [weak self] in
            guard let self else { return }
            switch command.command {
            case .ping:
                self.writer.heartbeat(
                    sessionId: self.active?.sessionId ?? "",
                    source: self.active?.source,
                    sequence: self.sequence
                )
            case .start:
                guard let sessionId = command.sessionId, let source = command.source else { return }
                if self.active?.sessionId == sessionId, self.active?.source == source { return }
                self.start(sessionId: sessionId, source: source)
            case .stop:
                guard let sessionId = command.sessionId, self.active?.sessionId == sessionId else { return }
                self.stop(clearActive: true, emitStopped: true)
            }
        }
    }

    func heartbeat() {
        queue.async { [weak self] in
            guard let self else { return }
            self.writer.heartbeat(
                sessionId: self.active?.sessionId ?? "",
                source: self.active?.source,
                sequence: self.sequence
            )
        }
    }

    private func start(sessionId: String, source: AudioSource) {
        stop(clearActive: true, emitStopped: false)
        generation &+= 1
        let current = Active(sessionId: sessionId, source: source, generation: generation)
        active = current
        sequence = 0
        processor.reset()
        healthMonitor = AudioStreamHealthMonitor(startedAt: Self.monotonicNow())
        lastFrameTimestampMs = nil
        captureRunning = false
        writer.status(sessionId: sessionId, source: source, sequence: 0, state: .starting)
        startHardware(for: current)
    }

    private func startHardware(for current: Active) {
        guard !sleeping else { return }
        let onSamples: ([Float], Double) -> Void = { [weak self] samples, rate in
            self?.queue.async { self?.consume(samples: samples, sampleRate: rate, active: current) }
        }
        let onInterrupted: () -> Void = { [weak self] in
            self?.queue.async { self?.captureInterrupted(active: current, code: "CAPTURE_INTERRUPTED") }
        }
        let onLiveness: () -> Void = { [weak self] in
            self?.queue.async {
                guard self?.active?.generation == current.generation else { return }
                self?.healthMonitor?.observeLiveness(at: Self.monotonicNow())
            }
        }
        let newCapture: NativeCapture = current.source == .microphone
            ? MicrophoneCapture(onSamples: onSamples, onInterrupted: onInterrupted)
            : SystemAudioCapture(
                onSamples: onSamples,
                onLiveness: onLiveness,
                onInterrupted: onInterrupted
            )
        capture = newCapture
        Task { [weak self, weak newCapture] in
            guard let self, let newCapture else { return }
            do {
                try await newCapture.start()
                self.queue.async {
                    guard self.active?.generation == current.generation, self.capture === newCapture else {
                        Task { await newCapture.stop() }
                        return
                    }
                    self.captureRunning = true
                    self.healthMonitor = AudioStreamHealthMonitor(startedAt: Self.monotonicNow())
                    self.writer.status(
                        sessionId: current.sessionId,
                        source: current.source,
                        sequence: self.sequence,
                        state: .capturing
                    )
                }
            } catch {
                self.queue.async {
                    guard self.active?.generation == current.generation, self.capture === newCapture else { return }
                    self.capture = nil
                    self.captureRunning = false
                    self.writer.status(
                        sessionId: current.sessionId,
                        source: current.source,
                        sequence: self.sequence,
                        state: .error,
                        code: Self.errorCode(error)
                    )
                }
            }
        }
    }

    private func consume(samples: [Float], sampleRate: Double, active expected: Active) {
        guard active?.generation == expected.generation, !sleeping else { return }
        for frame in processor.push(monoSamples: samples, inputSampleRate: sampleRate) {
            sequence &+= 1
            lastFrameTimestampMs = writer.pcm(
                sessionId: expected.sessionId,
                source: expected.source,
                sequence: sequence,
                frame: frame
            )
            if let healthEvent = healthMonitor?.observeFrame(energy: frame.energy, at: Self.monotonicNow()) {
                switch healthEvent {
                case .silent:
                    writer.status(
                        sessionId: expected.sessionId,
                        source: expected.source,
                        sequence: sequence,
                        state: .silent,
                        code: "ZERO_ENERGY",
                        lastFrameTimestampMs: lastFrameTimestampMs
                    )
                case .recovered:
                    writer.status(
                        sessionId: expected.sessionId,
                        source: expected.source,
                        sequence: sequence,
                        state: .capturing,
                        code: "AUDIO_RESUMED",
                        lastFrameTimestampMs: lastFrameTimestampMs
                    )
                case .dead:
                    break
                }
            }
        }
    }

    private func stop(clearActive: Bool, emitStopped: Bool) {
        let previous = active
        let previousCapture = capture
        capture = nil
        captureRunning = false
        healthMonitor = nil
        generation &+= 1
        processor.reset()
        if clearActive { active = nil }
        if let previousCapture { Task { await previousCapture.stop() } }
        if emitStopped, let previous {
            writer.status(
                sessionId: previous.sessionId,
                source: previous.source,
                sequence: sequence,
                state: .stopped
            )
        }
    }

    private func checkStreamHealth() {
        guard captureRunning, let current = active,
              let event = healthMonitor?.check(at: Self.monotonicNow())
        else { return }
        switch event {
        case .silent:
            writer.status(
                sessionId: current.sessionId,
                source: current.source,
                sequence: sequence,
                state: .silent,
                code: "NO_PCM_FRAMES",
                lastFrameTimestampMs: lastFrameTimestampMs
            )
        case .dead:
            captureInterrupted(active: current, code: "DEAD_AUDIO_STREAM")
        case .recovered:
            break
        }
    }

    private func captureInterrupted(active expected: Active, code: String) {
        guard active?.generation == expected.generation, capture != nil else { return }
        captureRunning = false
        let interruptedCapture = capture
        capture = nil
        if let interruptedCapture { Task { await interruptedCapture.stop() } }
        writer.status(
            sessionId: expected.sessionId,
            source: expected.source,
            sequence: sequence,
            state: .error,
            code: code,
            lastFrameTimestampMs: lastFrameTimestampMs
        )
    }

    private func suspendForSleep() {
        queue.async { [weak self] in
            guard let self, let current = self.active, !self.sleeping else { return }
            self.sleeping = true
            self.stop(clearActive: false, emitStopped: false)
            self.writer.status(
                sessionId: current.sessionId,
                source: current.source,
                sequence: self.sequence,
                state: .suspended,
                code: "SYSTEM_SLEEP"
            )
        }
    }

    private func resumeAfterWake() {
        queue.asyncAfter(deadline: .now() + .milliseconds(750)) { [weak self] in
            guard let self, let previous = self.active, self.sleeping else { return }
            self.sleeping = false
            self.generation &+= 1
            let resumed = Active(
                sessionId: previous.sessionId,
                source: previous.source,
                generation: self.generation
            )
            self.active = resumed
            self.processor.reset()
            self.writer.status(
                sessionId: resumed.sessionId,
                source: resumed.source,
                sequence: self.sequence,
                state: .starting,
                code: "WAKE_RESTART"
            )
            self.startHardware(for: resumed)
        }
    }

    private static func errorCode(_ error: Error) -> String {
        switch error {
        case NativeCaptureError.screenPermissionRequired: return "SCREEN_PERMISSION_REQUIRED"
        case NativeCaptureError.microphonePermissionRequired: return "MICROPHONE_PERMISSION_REQUIRED"
        case NativeCaptureError.noDisplay: return "NO_CAPTURE_DISPLAY"
        case NativeCaptureError.unsupportedAudioFormat: return "UNSUPPORTED_AUDIO_FORMAT"
        default: return "CAPTURE_START_FAILED"
        }
    }

    private static func monotonicNow() -> TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }
}
