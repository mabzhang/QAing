import AudioHelperCore
import Foundation

let writer = OutputWriter()
let coordinator = CaptureCoordinator(writer: writer)
let decoder = CommandFrameDecoder()
let input = POSIXInputReader()
let heartbeat = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
heartbeat.schedule(deadline: .now(), repeating: .seconds(1), leeway: .milliseconds(100))
heartbeat.setEventHandler { coordinator.heartbeat() }
heartbeat.resume()
writer.status(sessionId: "", source: nil, sequence: 0, state: .ready)

do {
    while let chunk = try input.readChunk(fileDescriptor: FileHandle.standardInput.fileDescriptor) {
        for command in try decoder.push(chunk) { coordinator.handle(command) }
    }
    try decoder.finish()
} catch {
    writer.status(sessionId: "", source: nil, sequence: 0, state: .error, code: "INVALID_CONTROL_PROTOCOL")
    exit(64)
}
