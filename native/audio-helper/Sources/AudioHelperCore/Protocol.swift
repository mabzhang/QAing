import Foundation

public enum AudioSource: UInt8, Codable, Sendable {
    case microphone = 1
    case system = 2

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        switch value {
        case "microphone": self = .microphone
        case "system": self = .system
        default: throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Unknown audio source"
        )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(self == .microphone ? "microphone" : "system")
    }
}

public enum HelperEventKind: UInt8, Sendable {
    case status = 1
    case pcm = 2
    case heartbeat = 3
}

public enum CaptureState: String, Codable, Sendable {
    case ready
    case starting
    case capturing
    case silent
    case suspended
    case stopped
    case error
}

public struct HelperCommand: Codable, Equatable, Sendable {
    public enum Command: String, Codable, Sendable {
        case start
        case stop
        case ping
    }

    public let command: Command
    public let sessionId: String?
    public let source: AudioSource?

    public init(command: Command, sessionId: String? = nil, source: AudioSource? = nil) {
        self.command = command
        self.sessionId = sessionId
        self.source = source
    }

    public func validate() throws {
        switch command {
        case .ping:
            return
        case .start:
            guard let sessionId, Self.validSessionId(sessionId), source != nil else {
                throw HelperProtocolError.invalidCommand
            }
        case .stop:
            guard let sessionId, Self.validSessionId(sessionId) else {
                throw HelperProtocolError.invalidCommand
            }
        }
    }

    private static func validSessionId(_ value: String) -> Bool {
        guard (1...128).contains(value.utf8.count) else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar) || ".:_-".unicodeScalars.contains(scalar)
        }
    }
}

public enum HelperProtocolError: Error, Equatable {
    case invalidCommand
    case commandTooLarge
    case invalidLength
    case truncatedStream
    case invalidEnergy
    case invalidPCMSize
}

public final class CommandFrameDecoder {
    private let maximumCommandBytes: Int
    private var buffered = Data()
    private let decoder = JSONDecoder()

    public init(maximumCommandBytes: Int = 16 * 1024) {
        self.maximumCommandBytes = maximumCommandBytes
    }

    public func push(_ data: Data) throws -> [HelperCommand] {
        buffered.append(data)
        if buffered.count > maximumCommandBytes + 4 {
            throw HelperProtocolError.commandTooLarge
        }
        var commands: [HelperCommand] = []
        while buffered.count >= 4 {
            let length = Int(buffered.readUInt32BE(at: 0))
            guard length > 0, length <= maximumCommandBytes else {
                throw HelperProtocolError.invalidLength
            }
            guard buffered.count >= 4 + length else { break }
            let payload = buffered.subdata(in: 4..<(4 + length))
            let command: HelperCommand
            do {
                command = try decoder.decode(HelperCommand.self, from: payload)
                try command.validate()
            } catch {
                throw HelperProtocolError.invalidCommand
            }
            commands.append(command)
            buffered.removeSubrange(0..<(4 + length))
        }
        return commands
    }

    public func finish() throws {
        guard buffered.isEmpty else { throw HelperProtocolError.truncatedStream }
    }
}

public struct HelperFrameEncoder {
    private static let magic = Data("QAG1".utf8)
    private static let version: UInt8 = 1
    private static let fixedBodyBytes = 28
    private static let pcmFrameBytes = 6_400
    private let jsonEncoder = JSONEncoder()

    public init() {}

    public func status(
        sessionId: String,
        source: AudioSource?,
        sequence: UInt64,
        timestampMs: UInt64,
        state: CaptureState,
        code: String? = nil,
        lastFrameTimestampMs: UInt64? = nil
    ) throws -> Data {
        struct Metadata: Codable {
            let state: CaptureState
            let code: String?
            let lastFrameTimestampMs: UInt64?
        }
        let metadata = try jsonEncoder.encode(Metadata(
            state: state,
            code: code,
            lastFrameTimestampMs: lastFrameTimestampMs
        ))
        return try encode(
            kind: .status,
            sessionId: sessionId,
            source: source,
            sequence: sequence,
            timestampMs: timestampMs,
            metadata: metadata,
            payload: Data()
        )
    }

    public func pcm(
        sessionId: String,
        source: AudioSource,
        sequence: UInt64,
        timestampMs: UInt64,
        energy: Float,
        pcm16: Data
    ) throws -> Data {
        guard energy.isFinite, (0...1).contains(energy) else { throw HelperProtocolError.invalidEnergy }
        guard pcm16.count == Self.pcmFrameBytes else { throw HelperProtocolError.invalidPCMSize }
        var metadata = Data()
        metadata.appendUInt32BE(energy.bitPattern)
        return try encode(
            kind: .pcm,
            sessionId: sessionId,
            source: source,
            sequence: sequence,
            timestampMs: timestampMs,
            metadata: metadata,
            payload: pcm16
        )
    }

    public func heartbeat(
        sessionId: String,
        source: AudioSource?,
        sequence: UInt64,
        timestampMs: UInt64
    ) throws -> Data {
        try encode(
            kind: .heartbeat,
            sessionId: sessionId,
            source: source,
            sequence: sequence,
            timestampMs: timestampMs,
            metadata: Data(),
            payload: Data()
        )
    }

    private func encode(
        kind: HelperEventKind,
        sessionId: String,
        source: AudioSource?,
        sequence: UInt64,
        timestampMs: UInt64,
        metadata: Data,
        payload: Data
    ) throws -> Data {
        let session = Data(sessionId.utf8)
        guard session.count <= Int(UInt16.max), metadata.count <= Int(UInt16.max) else {
            throw HelperProtocolError.invalidLength
        }
        let bodyLength = Self.fixedBodyBytes + session.count + metadata.count + payload.count
        guard bodyLength <= Int(UInt32.max) else { throw HelperProtocolError.invalidLength }
        var frame = Data(capacity: bodyLength + 4)
        frame.appendUInt32BE(UInt32(bodyLength))
        frame.append(Self.magic)
        frame.append(Self.version)
        frame.append(kind.rawValue)
        frame.append(source?.rawValue ?? 0)
        frame.append(0)
        frame.appendUInt64BE(sequence)
        frame.appendUInt64BE(timestampMs)
        frame.appendUInt16BE(UInt16(session.count))
        frame.appendUInt16BE(UInt16(metadata.count))
        frame.append(session)
        frame.append(metadata)
        frame.append(payload)
        return frame
    }
}

public extension Data {
    mutating func appendUInt16BE(_ value: UInt16) {
        var bigEndian = value.bigEndian
        Swift.withUnsafeBytes(of: &bigEndian) { append(contentsOf: $0) }
    }

    mutating func appendUInt32BE(_ value: UInt32) {
        var bigEndian = value.bigEndian
        Swift.withUnsafeBytes(of: &bigEndian) { append(contentsOf: $0) }
    }

    mutating func appendUInt64BE(_ value: UInt64) {
        var bigEndian = value.bigEndian
        Swift.withUnsafeBytes(of: &bigEndian) { append(contentsOf: $0) }
    }

    func readUInt32BE(at offset: Int) -> UInt32 {
        precondition(offset >= 0 && offset + 4 <= count)
        return subdata(in: offset..<(offset + 4)).withUnsafeBytes { raw in
            UInt32(bigEndian: raw.loadUnaligned(as: UInt32.self))
        }
    }
}
