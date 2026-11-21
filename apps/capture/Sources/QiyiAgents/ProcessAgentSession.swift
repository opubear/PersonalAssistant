import Foundation

@MainActor
public final class ProcessAgentSession: ConversationAgentSession {
    public var onInteraction: ((AgentInteraction, @escaping (AgentAnswer) -> Void) -> Void)?
    public var onProgress: ((String) -> Void)?
    public var onDisconnect: ((Error) -> Void)?
    private let configuration: AgentConfiguration
    private let directory: URL
    private let connection: AgentConnection
    private var sessionID: String?
    private var ready = false
    private var needsBasePrompt = true
    private var supportsImages = true
    private var reportsProgress = true
    private var turn: AgentTurn?
    private var toolDetails: [String: [String: Any]] = [:]

    public convenience init(configuration: AgentConfiguration, directory: URL) {
        self.init(configuration: configuration, directory: directory, transport: JSONLineProcess())
    }

    init(configuration: AgentConfiguration, directory: URL, transport: any AgentTransport) {
        self.configuration = configuration
        self.directory = directory
        connection = AgentConnection(transport: transport)
        connection.onEvent = { [weak self] in self?.receive($0) }
        connection.onFailure = { [weak self] error in
            guard let self else { return }
            self.ready = false
            self.turn?.finish(.failure(error))
            self.onDisconnect?(error)
        }
    }

    public func start() async throws {
        do {
            try connection.start(configuration: configuration, directory: directory)
            switch configuration.provider {
            case .pi:
                _ = try await connection.request(["type": "get_state"])
            case .codex:
                _ = try await connection.rpc("initialize", [
                    "clientInfo": ["name": "qiyi", "title": "Qiyi", "version": "1.0.0"],
                ])
                try await connection.send(["jsonrpc": "2.0", "method": "initialized"])
                let response = try await connection.rpc("thread/start", [
                    "cwd": directory.path, "approvalPolicy": "on-request", "approvalsReviewer": "user",
                    "sandbox": "read-only",
                ])
                sessionID = (response["thread"] as? [String: Any])?["id"] as? String
                guard sessionID != nil else { throw AgentError("Codex 没有返回会话 ID。") }
            case .dsh:
                let response = try await connection.rpc("initialize", [
                    "protocolVersion": 1, "clientCapabilities": [:] as [String: String],
                    "clientInfo": ["name": "qiyi-capture", "version": "1.0.0"],
                ])
                let capabilities = response["agentCapabilities"] as? [String: Any]
                let prompt = capabilities?["promptCapabilities"] as? [String: Any]
                supportsImages = prompt?["image"] as? Bool == true
                let session = try await connection.rpc("session/new", ["cwd": directory.path, "mcpServers": [] as [String]])
                sessionID = session["sessionId"] as? String
                guard sessionID != nil else { throw AgentError("dsh 没有返回会话 ID。") }
            }
            ready = true
        } catch {
            connection.fail(error)
            throw error
        }
    }

    public func analyze(image: URL, appName: String) async throws -> String {
        try await respond(to: AgentPrompt(
            text: "请分析这张来自 \(appName) 的窗口截图（\(image.lastPathComponent)）。", images: [.init(url: image)]
        ))
    }

    public func respond(to request: AgentPrompt) async throws -> String {
        guard ready else { throw AgentError("Agent 尚未就绪，请在设置中启动会话。") }
        guard turn == nil else { throw AgentError("Agent 正在处理上一条消息。") }
        guard request.images.isEmpty || supportsImages else {
            throw AgentError("此 dsh 配置不支持图片。可以处理文本；处理图片需要选择支持图片的模型并启用 ACP 图片附件存储。")
        }
        let current = AgentTurn()
        turn = current
        reportsProgress = request.reportsProgress
        toolDetails.removeAll()
        let deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 600_000_000_000) } catch { return }
            self?.connection.fail(AgentError("Agent 回复超过 10 分钟，已停止会话。已保存的资料不受影响。"))
        }
        defer { deadline.cancel(); turn = nil; reportsProgress = true }
        do {
            var prompt = request.text
            if needsBasePrompt, request.includeBasePrompt, !configuration.basePrompt.isEmpty {
                prompt = configuration.basePrompt + "\n\n" + prompt
            }
            switch configuration.provider {
            case .pi:
                let images = try await inlineImages(request.images)
                let response = try await connection.request([
                    "type": "prompt", "message": prompt,
                    "images": images,
                ])
                if response["disposition"] as? String == "handled" {
                    throw AgentError("Pi 扩展接管了提示词，没有启动本轮回复。")
                }
            case .codex:
                var params: [String: Any] = [
                    "threadId": sessionID!,
                    "input": [["type": "text", "text": prompt]] + request.images.map { ["type": "localImage", "path": $0.url.path] },
                ]
                if let effort = configuration.reasoningEffort { params["effort"] = effort }
                _ = try await connection.rpc("turn/start", params)
            case .dsh:
                let images = try await inlineImages(request.images)
                let response = try await connection.rpc("session/prompt", [
                    "sessionId": sessionID!, "prompt": [["type": "text", "text": prompt]] + images,
                ], timeout: 600)
                if response["stopReason"] as? String == "end_turn" {
                    current.finish(.success(current.text))
                } else {
                    current.finish(.failure(AgentError("dsh 未完成本轮：\(response["stopReason"] ?? "未知原因")")))
                }
            }
            let text = try await current.value()
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw AgentError("Agent 结束了本轮，但没有返回文字回复。")
            }
            if request.includeBasePrompt { needsBasePrompt = false }
            return text
        } catch {
            // A failed/aborted stream must never be mistaken for the next image.
            connection.fail(error)
            throw error
        }
    }

    private func inlineImages(_ images: [AgentImage]) async throws -> [[String: String]] {
        try await Task.detached {
            try images.map { image in
                ["type": "image", "data": try Data(contentsOf: image.url).base64EncodedString(), "mimeType": image.mimeType]
            }
        }.value
    }

    public func stop() { connection.stop() }

    private func receive(_ record: [String: Any]) {
        rememberToolDetails(record)
        if record["type"] as? String == "extension_ui_request" {
            handlePiInteraction(record)
            return
        }
        if record["method"] != nil, record["id"] != nil {
            handleServerRequest(record)
            return
        }
        guard let turn else { return }
        switch configuration.provider {
        case .pi: receivePi(record, turn: turn)
        case .codex: receiveCodex(record, turn: turn)
        case .dsh: receiveACP(record, turn: turn)
        }
    }

    private func receivePi(_ record: [String: Any], turn: AgentTurn) {
        switch record["type"] as? String {
        case "message_end":
            guard let message = record["message"] as? [String: Any], message["role"] as? String == "assistant" else { return }
            // Automatic retries may replace a failed assistant message.
            turn.error = (message["errorMessage"] as? String).map { AgentError($0) }
            if message["stopReason"] as? String == "error", turn.error == nil {
                turn.error = AgentError("Pi 模型调用失败。")
            }
            if message["stopReason"] as? String == "aborted" { turn.error = AgentError("Pi 已取消本轮。") }
            if let blocks = message["content"] as? [[String: Any]] {
                let text = blocks.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined(separator: "\n")
                turn.append(text)
                if !text.isEmpty { turn.finalText = text }
                if reportsProgress { onProgress?(turn.text) }
            }
        case "agent_settled":
            if record["aborted"] as? Bool == true { turn.error = AgentError("Pi 已取消本轮。") }
            turn.finish(turn.error.map { .failure($0) } ?? .success(turn.finalText ?? turn.text))
        default: break
        }
    }

    private func receiveCodex(_ record: [String: Any], turn: AgentTurn) {
        guard let params = record["params"] as? [String: Any], params["threadId"] as? String == sessionID else { return }
        if record["method"] as? String == "item/completed",
           let item = params["item"] as? [String: Any], item["type"] as? String == "agentMessage", let text = item["text"] as? String {
            turn.append(text)
            turn.finalText = text
            if reportsProgress { onProgress?(turn.text) }
        }
        if record["method"] as? String == "turn/completed", let completed = params["turn"] as? [String: Any] {
            if completed["status"] as? String == "completed" {
                turn.finish(.success(turn.finalText ?? turn.text))
            } else {
                let error = (completed["error"] as? [String: Any])?["message"] as? String ?? "Codex 本轮已中断。"
                turn.finish(.failure(AgentError(error)))
            }
        }
    }

    private func receiveACP(_ record: [String: Any], turn: AgentTurn) {
        guard record["method"] as? String == "session/update",
              let params = record["params"] as? [String: Any], params["sessionId"] as? String == sessionID,
              let update = params["update"] as? [String: Any], update["sessionUpdate"] as? String == "agent_message_chunk",
              let content = update["content"] as? [String: Any], content["type"] as? String == "text",
              let text = content["text"] as? String else { return }
        turn.text += text
        if reportsProgress { onProgress?(turn.text) }
    }

    func ask(_ interaction: AgentInteraction, answer: @escaping (AgentAnswer) -> Void) {
        guard let onInteraction else {
            connection.fail(AgentError("Agent 需要用户回应，但当前调用方没有提供交互界面。"))
            return
        }
        onInteraction(interaction, answer)
    }

    private func rememberToolDetails(_ record: [String: Any]) {
        guard let params = record["params"] as? [String: Any] else { return }
        if record["method"] as? String == "session/update", params["sessionId"] as? String == sessionID,
           let update = params["update"] as? [String: Any], let id = update["toolCallId"] as? String {
            toolDetails[id, default: [:]].merge(update) { _, new in new }
        }
        if ["item/started", "item/updated", "item/completed"].contains(record["method"] as? String ?? ""),
           params["threadId"] as? String == sessionID,
           let item = params["item"] as? [String: Any], let id = item["id"] as? String {
            toolDetails[id, default: [:]].merge(item) { _, new in new }
        }
    }

    func permissionDetail(_ params: [String: Any]) -> [String: Any] {
        let tool = params["toolCall"] as? [String: Any]
        let id = tool?["toolCallId"] as? String ?? params["itemId"] as? String ?? ""
        var detail = params
        if let known = toolDetails[id] { detail["operation"] = known }
        return detail
    }

    func reply(to record: [String: Any], result: [String: Any]) {
        guard let id = record["id"] else { return }
        send(["jsonrpc": "2.0", "id": id, "result": result])
    }

    func send(_ record: [String: Any]) {
        Task {
            do { try await connection.send(record) }
            catch { connection.fail(error) }
        }
    }
}

@MainActor
private final class AgentTurn {
    var text = ""
    // Keep progress messages visible, but return the last completed assistant
    // message so commentary cannot corrupt a structured selection response.
    var finalText: String?
    var error: Error?
    private var result: Result<String, Error>?
    private var continuation: CheckedContinuation<String, Error>?

    func append(_ value: String) {
        guard !value.isEmpty else { return }
        text += (text.isEmpty ? "" : "\n\n") + value
    }

    func finish(_ result: Result<String, Error>) {
        guard self.result == nil else { return }
        self.result = result
        continuation?.resume(with: result)
        continuation = nil
    }

    func value() async throws -> String {
        if let result { return try result.get() }
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
}
