import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

protocol NativeCapture: AnyObject, Sendable {
    func start() async throws
    func stop() async
}

enum NativeCaptureError: Error {
    case screenPermissionRequired
    case microphonePermissionRequired
    case noDisplay
    case unsupportedAudioFormat
}

final class MicrophoneCapture: NativeCapture, @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let onSamples: ([Float], Double) -> Void
    private let onInterrupted: () -> Void
    private var running = false
    private let stateLock = NSLock()
    private var configurationObserver: NSObjectProtocol?

    init(onSamples: @escaping ([Float], Double) -> Void, onInterrupted: @escaping () -> Void) {
        self.onSamples = onSamples
        self.onInterrupted = onInterrupted
    }

    func start() async throws {
        guard await microphoneAccessGranted() else {
            throw NativeCaptureError.microphonePermissionRequired
        }
        guard !stateLock.withLock({ running }) else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NativeCaptureError.unsupportedAudioFormat
        }
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, _ in
            guard let self, let samples = Self.monoSamples(from: buffer) else { return }
            self.onSamples(samples, format.sampleRate)
        }
        engine.prepare()
        do {
            try engine.start()
            stateLock.withLock { running = true }
            configurationObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange,
                object: engine,
                queue: nil
            ) { [weak self] _ in
                guard let self, self.stateLock.withLock({ self.running }) else { return }
                self.onInterrupted()
            }
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
    }

    func stop() async {
        guard stateLock.withLock({
            guard running else { return false }
            running = false
            return true
        }) else { return }
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func microphoneAccessGranted() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .audio)
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }

    private static func monoSamples(from buffer: AVAudioPCMBuffer) -> [Float]? {
        let frameCount = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frameCount > 0, channelCount > 0 else { return [] }
        if let channels = buffer.floatChannelData {
            var mono = Array(repeating: Float(0), count: frameCount)
            for channel in 0..<channelCount {
                for frame in 0..<frameCount { mono[frame] += channels[channel][frame] }
            }
            let divisor = Float(channelCount)
            return mono.map { $0 / divisor }
        }
        if let channels = buffer.int16ChannelData {
            var mono = Array(repeating: Float(0), count: frameCount)
            for channel in 0..<channelCount {
                for frame in 0..<frameCount {
                    mono[frame] += Float(channels[channel][frame]) / 32_768
                }
            }
            let divisor = Float(channelCount)
            return mono.map { $0 / divisor }
        }
        return nil
    }
}

final class SystemAudioCapture: NSObject, NativeCapture, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let onSamples: ([Float], Double) -> Void
    private let onLiveness: () -> Void
    private let onInterrupted: () -> Void
    private let callbackQueue = DispatchQueue(label: "com.qaing.audio-helper.screencapture")
    private let stateLock = NSLock()
    private var stream: SCStream?
    private var running = false

    init(
        onSamples: @escaping ([Float], Double) -> Void,
        onLiveness: @escaping () -> Void,
        onInterrupted: @escaping () -> Void
    ) {
        self.onSamples = onSamples
        self.onLiveness = onLiveness
        self.onInterrupted = onInterrupted
    }

    func start() async throws {
        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess()
            throw NativeCaptureError.screenPermissionRequired
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw NativeCaptureError.noDisplay }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.queueDepth = 3

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: callbackQueue)
        // A 1 fps 2x2 screen output is a cheap independent liveness probe. It
        // lets us classify no audio buffers as legitimate system silence while
        // still detecting a stream that has stopped producing all callbacks.
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: callbackQueue)
        self.stream = stream
        stateLock.withLock { running = true }
        do {
            try await stream.startCapture()
        } catch {
            stateLock.withLock { running = false }
            self.stream = nil
            throw error
        }
    }

    func stop() async {
        guard let stream else { return }
        self.stream = nil
        stateLock.withLock { running = false }
        try? await stream.stopCapture()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let unexpectedlyStopped = stateLock.withLock {
            let wasRunning = running
            running = false
            return wasRunning
        }
        if unexpectedlyStopped { onInterrupted() }
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        if outputType == .screen {
            onLiveness()
            return
        }
        guard outputType == .audio else { return }
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription),
              let samples = Self.monoSamples(from: sampleBuffer, format: asbdPointer.pointee)
        else { return }
        onSamples(samples, asbdPointer.pointee.mSampleRate)
    }

    private static func monoSamples(
        from sampleBuffer: CMSampleBuffer,
        format: AudioStreamBasicDescription
    ) -> [Float]? {
        var requiredSize = 0
        var retainedBlockBuffer: CMBlockBuffer?
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &requiredSize,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &retainedBlockBuffer
        )
        guard status == noErr, requiredSize > 0 else { return nil }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: requiredSize, alignment: 16)
        defer { raw.deallocate() }
        let audioBufferList = raw.assumingMemoryBound(to: AudioBufferList.self)
        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: audioBufferList,
            bufferListSize: requiredSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &retainedBlockBuffer
        )
        guard status == noErr else { return nil }

        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        let channels = max(1, Int(format.mChannelsPerFrame))
        let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
        let nonInterleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let isFloat = format.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let isSignedInteger = format.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0
        var mono = Array(repeating: Float(0), count: frames)

        if isFloat && format.mBitsPerChannel == 32 {
            if nonInterleaved {
                guard buffers.count >= channels else { return nil }
                for channel in 0..<channels {
                    guard let data = buffers[channel].mData else { return nil }
                    let values = data.assumingMemoryBound(to: Float.self)
                    for frame in 0..<frames { mono[frame] += values[frame] }
                }
            } else {
                guard let data = buffers.first?.mData else { return nil }
                let values = data.assumingMemoryBound(to: Float.self)
                for frame in 0..<frames {
                    for channel in 0..<channels { mono[frame] += values[frame * channels + channel] }
                }
            }
        } else if isSignedInteger && format.mBitsPerChannel == 16 {
            if nonInterleaved {
                guard buffers.count >= channels else { return nil }
                for channel in 0..<channels {
                    guard let data = buffers[channel].mData else { return nil }
                    let values = data.assumingMemoryBound(to: Int16.self)
                    for frame in 0..<frames { mono[frame] += Float(values[frame]) / 32_768 }
                }
            } else {
                guard let data = buffers.first?.mData else { return nil }
                let values = data.assumingMemoryBound(to: Int16.self)
                for frame in 0..<frames {
                    for channel in 0..<channels {
                        mono[frame] += Float(values[frame * channels + channel]) / 32_768
                    }
                }
            }
        } else {
            return nil
        }
        let divisor = Float(channels)
        return mono.map { $0 / divisor }
    }
}
