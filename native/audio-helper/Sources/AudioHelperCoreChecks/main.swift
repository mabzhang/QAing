import AudioHelperCore
import Darwin
import Foundation

enum CheckFailure: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self { case .failed(let message): return message }
    }
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw CheckFailure.failed(message) }
}

func commandFrame(_ command: HelperCommand) throws -> Data {
    let payload = try JSONEncoder().encode(command)
    var frame = Data()
    frame.appendUInt32BE(UInt32(payload.count))
    frame.append(payload)
    return frame
}

func readUInt64BE(_ data: Data, at offset: Int) -> UInt64 {
    data.subdata(in: offset..<(offset + 8)).withUnsafeBytes { raw in
        UInt64(bigEndian: raw.loadUnaligned(as: UInt64.self))
    }
}

func readInt16LE(_ data: Data, at offset: Int) -> Int16 {
    data.subdata(in: offset..<(offset + 2)).withUnsafeBytes { raw in
        Int16(littleEndian: raw.loadUnaligned(as: Int16.self))
    }
}

func checkCommandFraming() throws {
    let startCommand = HelperCommand(command: .start, sessionId: "session-1", source: .system)
    let start = try commandFrame(startCommand)
    let pingCommand = HelperCommand(command: .ping)
    let ping = try commandFrame(pingCommand)
    let combined = start + ping
    let decoder = CommandFrameDecoder()
    let firstCommands = try decoder.push(Data(combined.prefix(3)))
    try require(firstCommands.isEmpty, "split command emitted too early")
    let remainingCommands = try decoder.push(Data(combined.dropFirst(3)))
    try require(remainingCommands == [startCommand, pingCommand], "coalesced commands decoded incorrectly")
    try decoder.finish()

    let unsafe = try commandFrame(HelperCommand(command: .stop, sessionId: "bad\nsession"))
    do {
        _ = try CommandFrameDecoder().push(unsafe)
        throw CheckFailure.failed("unsafe session identifier was accepted")
    } catch HelperProtocolError.invalidCommand {
        // Expected.
    }
}

func checkBinaryEventEnvelope() throws {
    let pcm = Data(repeating: 0x7f, count: StreamingAudioProcessor.bytesPerFrame)
    let frame = try HelperFrameEncoder().pcm(
        sessionId: "s1",
        source: .microphone,
        sequence: 42,
        timestampMs: 1_234,
        energy: 0.5,
        pcm16: pcm
    )
    try require(Int(frame.readUInt32BE(at: 0)) == frame.count - 4, "event length prefix mismatch")
    try require(String(data: frame.subdata(in: 4..<8), encoding: .utf8) == "QAG1", "event magic mismatch")
    try require(frame[8] == 1 && frame[9] == HelperEventKind.pcm.rawValue, "event header mismatch")
    try require(frame[10] == AudioSource.microphone.rawValue, "event source mismatch")
    try require(readUInt64BE(frame, at: 12) == 42, "event sequence mismatch")
    try require(readUInt64BE(frame, at: 20) == 1_234, "event timestamp mismatch")
    try require(frame.suffix(StreamingAudioProcessor.bytesPerFrame) == pcm, "event PCM mismatch")

    do {
        _ = try HelperFrameEncoder().pcm(
            sessionId: "s", source: .system, sequence: 1, timestampMs: 1,
            energy: 0, pcm16: Data(repeating: 0, count: 10)
        )
        throw CheckFailure.failed("invalid PCM size was accepted")
    } catch HelperProtocolError.invalidPCMSize {
        // Expected.
    }
}

func checkProcessing() throws {
    var processor = StreamingAudioProcessor()
    let frames = processor.push(monoSamples: Array(repeating: 0.5, count: 3_201), inputSampleRate: 16_000)
    try require(frames.count == 1, "16 kHz framing count mismatch")
    try require(frames[0].pcm16.count == 6_400, "PCM frame is not 200 ms")
    try require(abs(frames[0].energy - 0.5) < 0.0001, "energy calculation mismatch")
    try require(readInt16LE(frames[0].pcm16, at: 0) == 16_383, "PCM16 conversion mismatch")

    processor.reset()
    let first = processor.push(monoSamples: Array(repeating: 0.25, count: 4_800), inputSampleRate: 48_000)
    let second = processor.push(monoSamples: Array(repeating: 0.25, count: 4_803), inputSampleRate: 48_000)
    try require(first.isEmpty && second.count == 1, "streaming 48 kHz resampling mismatch")
    try require(abs(second[0].energy - 0.25) < 0.0001, "resampled energy mismatch")

    processor.reset()
    var invalidSamples = Array(repeating: Float(0), count: 3_201)
    invalidSamples[0] = 2
    invalidSamples[1] = -2
    invalidSamples[2] = .nan
    let clamped = processor.push(monoSamples: invalidSamples, inputSampleRate: 16_000)[0]
    try require(readInt16LE(clamped.pcm16, at: 0) == Int16.max, "positive clamp mismatch")
    try require(readInt16LE(clamped.pcm16, at: 2) == Int16.min, "negative clamp mismatch")
    try require(readInt16LE(clamped.pcm16, at: 4) == 0, "NaN sanitization mismatch")
}

func checkStreamHealth() throws {
    var healthySilence = AudioStreamHealthMonitor(startedAt: 0)
    try require(healthySilence.observeFrame(energy: 0, at: 5) == nil, "silence reported too early")
    try require(healthySilence.observeFrame(energy: 0, at: 15) == .silent, "healthy zero-energy stream was not marked silent")
    try require(healthySilence.check(at: 20) == nil, "healthy silent stream was classified as dead")
    try require(healthySilence.observeFrame(energy: 0.2, at: 21) == .recovered, "audio recovery was not reported")

    var dead = AudioStreamHealthMonitor(startedAt: 0)
    try require(dead.check(at: 10) == .silent, "missing PCM diagnostic was not emitted")
    try require(dead.check(at: 10.1) == .dead, "missing PCM stream was not classified as dead")
    try require(dead.check(at: 20) == nil, "dead stream emitted duplicate events")

    var liveWithoutPCM = AudioStreamHealthMonitor(startedAt: 0)
    liveWithoutPCM.observeLiveness(at: 9)
    try require(liveWithoutPCM.check(at: 10) == .silent, "live stream without PCM was not marked silent")
    liveWithoutPCM.observeLiveness(at: 15)
    try require(liveWithoutPCM.check(at: 16) == nil, "independently live silent stream was marked dead")
}

func checkPOSIXControlPipe() throws {
    var descriptors: [Int32] = [0, 0]
    try require(Darwin.pipe(&descriptors) == 0, "could not create POSIX control pipe")
    let readDescriptor = descriptors[0]
    var writeDescriptor = descriptors[1]
    defer {
        Darwin.close(readDescriptor)
        if writeDescriptor >= 0 { Darwin.close(writeDescriptor) }
    }

    let command = HelperCommand(command: .ping)
    let shortFrame = try commandFrame(command)
    try require(shortFrame.count < 128, "control-pipe fixture is not a short frame")
    let written = shortFrame.withUnsafeBytes { rawBuffer in
        Darwin.write(writeDescriptor, rawBuffer.baseAddress!, shortFrame.count)
    }
    try require(written == shortFrame.count, "short control frame write failed")

    // The write end intentionally remains open here. A length-oriented API can
    // block waiting for more input; production read(2) must return this short
    // frame immediately.
    let startedAt = ProcessInfo.processInfo.systemUptime
    let chunk = try POSIXInputReader().readChunk(fileDescriptor: readDescriptor)
    let elapsed = ProcessInfo.processInfo.systemUptime - startedAt
    try require(chunk == shortFrame, "POSIX short read changed the control frame")
    try require(elapsed < 0.5, "POSIX short read waited for buffer fill or EOF")
    let decoded = try CommandFrameDecoder().push(chunk ?? Data())
    try require(decoded == [command], "short control frame did not reach the decoder")

    var calls = 0
    let interruptedReader = POSIXInputReader { _, buffer, _ in
        calls += 1
        if calls == 1 {
            errno = EINTR
            return -1
        }
        buffer.storeBytes(of: UInt8(0x7f), as: UInt8.self)
        return 1
    }
    let afterInterrupt = try interruptedReader.readChunk(fileDescriptor: readDescriptor, maximumBytes: 1)
    try require(calls == 2 && afterInterrupt == Data([0x7f]), "EINTR was not retried safely")

    Darwin.close(writeDescriptor)
    writeDescriptor = -1
    let eof = try POSIXInputReader().readChunk(fileDescriptor: readDescriptor)
    try require(eof == nil, "POSIX EOF was not reported")
}

do {
    try checkCommandFraming()
    try checkBinaryEventEnvelope()
    try checkProcessing()
    try checkStreamHealth()
    try checkPOSIXControlPipe()
    FileHandle.standardOutput.write(Data("AudioHelperCoreChecks: 5 suites passed\n".utf8))
} catch {
    FileHandle.standardError.write(Data("AudioHelperCoreChecks failed: \(error)\n".utf8))
    exit(1)
}
