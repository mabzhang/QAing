import Foundation

public struct ProcessedAudioFrame: Equatable, Sendable {
    public let pcm16: Data
    public let energy: Float

    public init(pcm16: Data, energy: Float) {
        self.pcm16 = pcm16
        self.energy = energy
    }
}

public struct StreamingAudioProcessor: Sendable {
    public static let targetSampleRate = 16_000.0
    public static let samplesPerFrame = 3_200
    public static let bytesPerFrame = 6_400

    private var inputRate: Double?
    private var resampleBuffer: [Float] = []
    private var resamplePosition = 0.0
    private var frameBuffer: [Float] = []

    public init() {}

    public mutating func reset() {
        inputRate = nil
        resampleBuffer.removeAll(keepingCapacity: true)
        resamplePosition = 0
        frameBuffer.removeAll(keepingCapacity: true)
    }

    public mutating func push(monoSamples: [Float], inputSampleRate: Double) -> [ProcessedAudioFrame] {
        guard inputSampleRate.isFinite, inputSampleRate > 0, !monoSamples.isEmpty else { return [] }
        if inputRate != inputSampleRate {
            inputRate = inputSampleRate
            resampleBuffer.removeAll(keepingCapacity: true)
            resamplePosition = 0
        }
        resampleBuffer.append(contentsOf: monoSamples.map { sample in
            guard sample.isFinite else { return 0 }
            return min(1, max(-1, sample))
        })

        let step = inputSampleRate / Self.targetSampleRate
        while resamplePosition + 1 < Double(resampleBuffer.count) {
            let lowerIndex = Int(resamplePosition)
            let fraction = Float(resamplePosition - Double(lowerIndex))
            let lower = resampleBuffer[lowerIndex]
            let upper = resampleBuffer[lowerIndex + 1]
            frameBuffer.append(lower + (upper - lower) * fraction)
            resamplePosition += step
        }

        let consumed = min(Int(resamplePosition), max(0, resampleBuffer.count - 1))
        if consumed > 0 {
            resampleBuffer.removeFirst(consumed)
            resamplePosition -= Double(consumed)
        }

        var frames: [ProcessedAudioFrame] = []
        while frameBuffer.count >= Self.samplesPerFrame {
            let samples = Array(frameBuffer.prefix(Self.samplesPerFrame))
            frameBuffer.removeFirst(Self.samplesPerFrame)
            frames.append(Self.makeFrame(samples))
        }
        return frames
    }

    private static func makeFrame(_ samples: [Float]) -> ProcessedAudioFrame {
        var pcm = Data(capacity: bytesPerFrame)
        var sumSquares: Double = 0
        for sample in samples {
            let clamped = min(1, max(-1, sample))
            sumSquares += Double(clamped * clamped)
            let scaled = clamped < 0 ? clamped * 32_768 : clamped * 32_767
            var littleEndian = Int16(max(Float(Int16.min), min(Float(Int16.max), scaled))).littleEndian
            Swift.withUnsafeBytes(of: &littleEndian) { pcm.append(contentsOf: $0) }
        }
        let energy = Float(min(1, sqrt(sumSquares / Double(samples.count))))
        return ProcessedAudioFrame(pcm16: pcm, energy: energy)
    }
}
