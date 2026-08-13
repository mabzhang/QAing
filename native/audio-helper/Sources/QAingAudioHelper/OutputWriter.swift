import AudioHelperCore
import Foundation

final class OutputWriter {
    private let fileHandle: FileHandle
    private let queue = DispatchQueue(label: "com.qaing.audio-helper.stdout")
    private let encoder = HelperFrameEncoder()

    init(fileHandle: FileHandle = .standardOutput) {
        self.fileHandle = fileHandle
    }

    func status(
        sessionId: String,
        source: AudioSource?,
        sequence: UInt64,
        state: CaptureState,
        code: String? = nil,
        lastFrameTimestampMs: UInt64? = nil
    ) {
        write { [self] in try self.encoder.status(
            sessionId: sessionId,
            source: source,
            sequence: sequence,
            timestampMs: Self.nowMs(),
            state: state,
            code: code,
            lastFrameTimestampMs: lastFrameTimestampMs
        ) }
    }

    func pcm(
        sessionId: String,
        source: AudioSource,
        sequence: UInt64,
        frame: ProcessedAudioFrame
    ) -> UInt64 {
        let timestampMs = Self.nowMs()
        write { [self] in try self.encoder.pcm(
            sessionId: sessionId,
            source: source,
            sequence: sequence,
            timestampMs: timestampMs,
            energy: frame.energy,
            pcm16: frame.pcm16
        ) }
        return timestampMs
    }

    func heartbeat(sessionId: String, source: AudioSource?, sequence: UInt64) {
        write { [self] in try self.encoder.heartbeat(
            sessionId: sessionId,
            source: source,
            sequence: sequence,
            timestampMs: Self.nowMs()
        ) }
    }

    private func write(_ makeFrame: @escaping () throws -> Data) {
        queue.async { [fileHandle] in
            guard let frame = try? makeFrame() else { exit(74) }
            do { try fileHandle.write(contentsOf: frame) } catch { exit(74) }
        }
    }

    static func nowMs() -> UInt64 {
        UInt64(max(0, Date().timeIntervalSince1970 * 1_000))
    }
}
