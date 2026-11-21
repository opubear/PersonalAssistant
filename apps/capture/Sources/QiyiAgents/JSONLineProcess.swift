import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

@MainActor
protocol AgentTransport: AnyObject {
    var onRecord: (([String: Any]) -> Void)? { get set }
    var onFailure: ((Error) -> Void)? { get set }
    func start(configuration: AgentConfiguration, directory: URL) throws
    func send(_ record: [String: Any]) async throws
    func close()
}

/// Owns a child process, not a shell. Protocol stdout and diagnostic stderr are
/// drained independently so a verbose agent cannot block the screenshot UI.
@MainActor
final class JSONLineProcess: AgentTransport {
    var onRecord: (([String: Any]) -> Void)?
    var onFailure: ((Error) -> Void)?
    private var process: Process?
    private var input: FileHandle?
    private var stderrTail = ""
    private let writer = DispatchQueue(label: "qiyi-capture.agent.stdin")
    private var closed = false
    private var stdoutEnded = false
    private var exitStatus: Int32?

    func start(configuration: AgentConfiguration, directory: URL) throws {
        try configuration.validate()
        var environment = ProcessInfo.processInfo.environment
        // Finder does not inherit the user's interactive-shell PATH.
        #if !os(Windows)
        let extra = ["\(NSHomeDirectory())/.local/bin", "\(NSHomeDirectory())/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        let inherited = environment["PATH", default: ""].split(separator: ":").map(String.init)
        environment["PATH"] = (inherited + extra.filter { !inherited.contains($0) }).joined(separator: ":")
        #endif
        let executable = try Self.resolve(configuration.executable, environment: environment)
        let child = Process()
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        #if canImport(Darwin)
        // Darwin can deliver pipe signals process-wide. Suppress them on this
        // descriptor so an agent closing stdin produces a recoverable error.
        guard fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) != -1 else {
            throw AgentError("无法保护 agent 输入管道（\(errno)）。")
        }
        #endif
        child.executableURL = executable
        child.arguments = configuration.arguments
        child.currentDirectoryURL = directory
        child.environment = environment
        child.standardInput = stdin
        child.standardOutput = stdout
        child.standardError = stderr
        child.terminationHandler = { [weak self] child in
            DispatchQueue.main.async {
                guard let self, !self.closed else { return }
                self.exitStatus = child.terminationStatus
                self.reportExitIfDrained()
            }
        }
        try child.run()
        process = child
        input = stdin.fileHandleForWriting
        read(stdout.fileHandleForReading, protocolStream: true)
        read(stderr.fileHandleForReading, protocolStream: false)
    }

    private static func resolve(_ name: String, environment: [String: String]) throws -> URL {
        let expanded = (name as NSString).expandingTildeInPath
        if expanded.contains("/") || expanded.contains("\\") {
            let url = URL(fileURLWithPath: expanded)
            guard FileManager.default.isExecutableFile(atPath: url.path) else {
                throw AgentError("无法执行：\(url.path)")
            }
            return url
        }
        #if os(Windows)
        let separator: Character = ";"
        let suffixes = ["", ".exe", ".com"]
        #else
        let separator: Character = ":"
        let suffixes = [""]
        #endif
        for folder in environment["PATH", default: ""].split(separator: separator) {
            for suffix in suffixes {
                let url = URL(fileURLWithPath: String(folder)).appendingPathComponent(name + suffix)
                if FileManager.default.isExecutableFile(atPath: url.path) { return url }
            }
        }
        throw AgentError("找不到 \(name)。请先安装该 agent，或在设置中填写其可执行文件的完整路径。")
    }

    private func read(_ handle: FileHandle, protocolStream: Bool) {
        DispatchQueue(label: "qiyi-capture.agent.\(protocolStream ? "stdout" : "stderr")").async { [weak self] in
            defer { try? handle.close() }
            var buffer = Data()
            do {
                // read(upToCount:) can wait to fill the requested length on
                // pipes. availableData returns as soon as a record arrives.
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    if !protocolStream {
                        let text = String(decoding: chunk, as: UTF8.self)
                        DispatchQueue.main.async {
                            guard let self else { return }
                            self.stderrTail = String((self.stderrTail + text).suffix(8_192))
                        }
                        continue
                    }
                    buffer.append(chunk)
                    // Split on LF only; Unicode line separators are legal JSON text.
                    while let index = buffer.firstIndex(of: 10) {
                        let line = Data(buffer[..<index])
                        buffer.removeSubrange(...index)
                        if line.allSatisfy({ $0 == 13 || $0 == 32 }) { continue }
                        guard let record = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                            throw AgentError("Agent 输出了非 JSON 对象，请检查启动参数。")
                        }
                        DispatchQueue.main.async { self?.deliver(record) }
                    }
                    guard buffer.count <= 32 * 1_024 * 1_024 else {
                        throw AgentError("Agent 单条输出超过 32 MB，已停止会话。")
                    }
                }
                if protocolStream, !buffer.isEmpty { throw AgentError("Agent 输出不完整，连接已断开。") }
                if protocolStream {
                    DispatchQueue.main.async {
                        self?.stdoutEnded = true
                        self?.reportExitIfDrained()
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self, !self.closed else { return }
                    self.onFailure?(error)
                }
            }
        }
    }

    private func deliver(_ record: [String: Any]) {
        if !closed { onRecord?(record) }
    }

    private func reportExitIfDrained() {
        // The exit callback can race the last stdout record. Drain records first
        // so a short-lived child cannot discard its final response.
        guard !closed, stdoutEnded, let exitStatus else { return }
        onFailure?(AgentError("Agent 已退出（\(exitStatus)）。\n\(stderrTail)"))
    }

    func send(_ record: [String: Any]) async throws {
        guard !closed, let input else { throw AgentError("Agent 连接已关闭。") }
        var data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        data.append(10)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            writer.async {
                do { try Self.writeWithoutSIGPIPE(data, to: input); continuation.resume() }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    private nonisolated static func writeWithoutSIGPIPE(_ data: Data, to handle: FileHandle) throws {
        #if canImport(Glibc)
        // Block SIGPIPE on this write's thread only. Changing the process-wide
        // signal handler would interfere with applications embedding this library.
        var blocked = sigset_t(), previous = sigset_t(), pending = sigset_t()
        sigemptyset(&blocked)
        sigaddset(&blocked, SIGPIPE)
        let code = pthread_sigmask(SIG_BLOCK, &blocked, &previous)
        guard code == 0 else { throw AgentError("无法保护 agent 管道写入（\(code)）。") }
        sigpending(&pending)
        let alreadyPending = sigismember(&pending, SIGPIPE) == 1
        defer {
            sigpending(&pending)
            if !alreadyPending, sigismember(&pending, SIGPIPE) == 1 {
                var signal: Int32 = 0
                sigwait(&blocked, &signal)
            }
            pthread_sigmask(SIG_SETMASK, &previous, nil)
        }
        #endif
        try handle.write(contentsOf: data)
    }

    func close() {
        guard !closed else { return }
        closed = true
        if let input { writer.async { try? input.close() } }
        input = nil
        guard let child = process else { return }
        process = nil
        if child.isRunning { child.terminate() }
        // Give protocol teardown a bounded grace period; a stuck model request
        // must not leave an orphaned agent after the app quits.
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            guard child.isRunning else { return }
            #if os(Windows)
            child.terminate()
            #else
            _ = kill(child.processIdentifier, SIGKILL)
            #endif
        }
    }
}
