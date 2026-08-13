import Darwin
import Foundation

public enum POSIXInputError: Error, Equatable {
    case invalidMaximumBytes
    case readFailed(Int32)
}

/// Performs one POSIX `read(2)` operation and returns as soon as any bytes are
/// available. Unlike `FileHandle.readData(ofLength:)`, this does not wait for a
/// requested buffer length or EOF on a long-lived control pipe.
public struct POSIXInputReader {
    public typealias ReadBytes = (Int32, UnsafeMutableRawPointer, Int) -> Int

    private let readBytes: ReadBytes

    public init() {
        readBytes = { fileDescriptor, buffer, maximumBytes in
            Darwin.read(fileDescriptor, buffer, maximumBytes)
        }
    }

    /// Injection point used by the native self-check to deterministically
    /// exercise EINTR without signals or timing-sensitive process behavior.
    public init(readBytes: @escaping ReadBytes) {
        self.readBytes = readBytes
    }

    /// Returns `nil` only for EOF. Short reads are successful reads.
    public func readChunk(fileDescriptor: Int32, maximumBytes: Int = 8 * 1024) throws -> Data? {
        guard maximumBytes > 0 else { throw POSIXInputError.invalidMaximumBytes }
        var buffer = [UInt8](repeating: 0, count: maximumBytes)
        while true {
            let count = buffer.withUnsafeMutableBytes { rawBuffer in
                readBytes(fileDescriptor, rawBuffer.baseAddress!, maximumBytes)
            }
            if count > 0 { return Data(buffer.prefix(count)) }
            if count == 0 { return nil }
            let errorNumber = errno
            if errorNumber == EINTR { continue }
            throw POSIXInputError.readFailed(errorNumber)
        }
    }
}
