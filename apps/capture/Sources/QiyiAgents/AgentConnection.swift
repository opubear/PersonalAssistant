import Foundation

/// Correlates both Pi RPC and JSON-RPC replies. Unsolicited events and requests
/// remain visible to the provider adapter, including permission questions.
@MainActor
final class AgentConnection {
    var onEvent: (([String: Any]) -> Void)?
    var onFailure: ((Error) -> Void)?
    private let transport: any AgentTransport
    private var pending: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var failure: Error?
    private var started = false

    init(transport: any AgentTransport) {
        self.transport = transport
        transport.onRecord = { [weak self] in self?.receive($0) }
        transport.onFailure = { [weak self] in self?.fail($0) }
    }

    func start(configuration: AgentConfiguration, directory: URL) throws {
        if let failure { throw failure }
        guard !started else { throw AgentError("此 agent 连接已经启动，不能重复启动。") }
        started = true
        try transport.start(configuration: configuration, directory: directory)
    }

    func request(_ record: [String: Any], timeout: UInt64 = 30) async throws -> [String: Any] {
        if let failure { throw failure }
        let id = UUID().uuidString
        var record = record
        record["id"] = id
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task {
                do { try await transport.send(record) }
                catch { fail(error) }
            }
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: timeout * 1_000_000_000)
                guard let self, self.pending[id] != nil else { return }
                self.fail(AgentError("Agent 响应超时，已停止会话。请检查登录、模型和启动参数后重新启动。"))
            }
        }
    }

    func rpc(_ method: String, _ params: [String: Any], timeout: UInt64 = 30) async throws -> [String: Any] {
        try await request(["jsonrpc": "2.0", "method": method, "params": params], timeout: timeout)
    }

    func send(_ record: [String: Any]) async throws {
        if let failure { throw failure }
        try await transport.send(record)
    }

    func stop() { fail(AgentError("Agent 会话已停止。")) }

    func fail(_ error: Error) {
        guard failure == nil else { return }
        failure = error
        let requests = pending.values
        pending.removeAll()
        transport.close()
        for continuation in requests { continuation.resume(throwing: error) }
        onFailure?(error)
    }

    private func receive(_ record: [String: Any]) {
        let isReply = record["type"] as? String == "response" || record["result"] != nil || record["error"] != nil && record["method"] == nil
        if isReply, let id = record["id"] as? String, let continuation = pending.removeValue(forKey: id) {
            if let error = record["error"] {
                let message = (error as? [String: Any])?["message"] as? String ?? String(describing: error)
                continuation.resume(throwing: AgentError(message))
            } else if record["success"] as? Bool == false {
                continuation.resume(throwing: AgentError("Agent 拒绝了请求。"))
            } else {
                continuation.resume(returning: (record["result"] ?? record["data"]) as? [String: Any] ?? [:])
            }
            return
        }
        onEvent?(record)
    }
}
