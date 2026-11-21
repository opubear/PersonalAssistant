import Foundation
import Testing
@testable import QiyiAgents

@MainActor
private final class MockTransport: AgentTransport {
    var onRecord: (([String: Any]) -> Void)?
    var onFailure: ((Error) -> Void)?
    var sent: [[String: Any]] = []
    var closed = false
    var starts = 0
    var handler: (([String: Any]) -> Void)?
    var supportsImages = true
    var failTurn = false
    var codexThread: [String: Any] = ["id": "thread-1", "ephemeral": true]

    func start(configuration: AgentConfiguration, directory: URL) throws { starts += 1 }
    func close() { closed = true }
    func send(_ record: [String: Any]) async throws {
        sent.append(record)
        if let handler { handler(record); return }
        let method = record["method"] as? String ?? record["type"] as? String ?? ""
        let id = record["id"] ?? "none"
        func reply(_ result: [String: Any]) { onRecord?(["id": id, "result": result]) }
        switch method {
        case "initialize": reply(["agentCapabilities": ["promptCapabilities": ["image": supportsImages]]])
        case "initialized": break
        case "thread/start": reply(["thread": codexThread])
        case "session/new": reply(["sessionId": "session-1"])
        case "get_state": onRecord?(["id": id, "type": "response", "success": true])
        case "prompt":
            var message: [String: Any] = ["role": "assistant", "content": [["type": "text", "text": "Pi 回复"]]]
            if failTurn { message["errorMessage"] = "模型无法读取图片" }
            onRecord?(["type": "message_end", "message": message])
            onRecord?(["type": "agent_settled", "aborted": false])
            onRecord?(["id": id, "type": "response", "success": true, "data": ["disposition": "started"]])
        case "turn/start":
            onRecord?(["method": "item/completed", "params": ["threadId": "thread-1", "item": ["type": "agentMessage", "text": "Codex 回复"]]])
            onRecord?(["method": "turn/completed", "params": ["threadId": "thread-1", "turn": ["status": failTurn ? "failed" : "completed", "error": ["message": "模型失败"]]]])
            reply(["turn": ["id": "turn-1"]])
        case "session/prompt":
            for text in ["DSH ", "回复"] {
                onRecord?(["method": "session/update", "params": ["sessionId": "session-1", "update": ["sessionUpdate": "agent_message_chunk", "content": ["type": "text", "text": text]]]])
            }
            reply(["stopReason": failTurn ? "cancelled" : "end_turn"])
        default: break
        }
    }
}

@MainActor
struct AgentSessionTests {
    @Test(arguments: AgentProvider.allCases)
    func readingPlansDoNotStreamInternalJSONToTheUI(provider: AgentProvider) async throws {
        let session = ProcessAgentSession(configuration: .init(provider: provider), directory: FileManager.default.temporaryDirectory, transport: MockTransport())
        var progress: [String] = []
        session.onProgress = { progress.append($0) }
        try await session.start()
        _ = try await session.respond(to: AgentPrompt(text: "阅读规划", reportsProgress: false))
        #expect(progress.isEmpty)
        _ = try await session.respond(to: AgentPrompt(text: "正常回答"))
        #expect(!progress.isEmpty)
        session.stop()
    }

    @Test func reasoningEffortIsScopedToTheConfiguredCodexSession() async throws {
        var config = AgentConfiguration()
        config.reasoningEffort = "high"
        let readerTransport = MockTransport()
        let reader = ProcessAgentSession(configuration: config, directory: FileManager.default.temporaryDirectory, transport: readerTransport)
        try await reader.start()
        _ = try await reader.respond(to: AgentPrompt(text: "固定提示词", includeBasePrompt: false))
        let readerTurn = try #require(readerTransport.sent.first { $0["method"] as? String == "turn/start" })
        #expect((readerTurn["params"] as? [String: Any])?["effort"] as? String == "high")
        let conversationTransport = MockTransport()
        let conversation = ProcessAgentSession(configuration: .init(), directory: FileManager.default.temporaryDirectory, transport: conversationTransport)
        try await conversation.start()
        _ = try await conversation.respond(to: AgentPrompt(text: "普通问答"))
        let conversationTurn = try #require(conversationTransport.sent.first { $0["method"] as? String == "turn/start" })
        #expect((conversationTurn["params"] as? [String: Any])?["effort"] == nil)
        reader.stop(); conversation.stop()
        config.provider = .pi
        #expect(throws: AgentError.self) { try config.validate() }
    }

    @Test func stoppingBeforeStartupNeverLaunchesAnOrphanProcess() async {
        let transport = MockTransport()
        let session = ProcessAgentSession(configuration: .init(), directory: FileManager.default.temporaryDirectory, transport: transport)
        session.stop()
        await #expect(throws: AgentError.self) { try await session.start() }
        #expect(transport.starts == 0)
    }

    @Test(arguments: [false, nil] as [Bool?])
    func codexRequiresAnEphemeralThreadBeforeSendingContent(ephemeral: Bool?) async {
        let transport = MockTransport()
        transport.codexThread["ephemeral"] = ephemeral
        let session = ProcessAgentSession(configuration: .init(), directory: FileManager.default.temporaryDirectory, transport: transport)
        await #expect(throws: AgentError.self) { try await session.start() }
        await #expect(throws: AgentError.self) { try await session.respond(to: .init(text: "资料概述")) }
        #expect(transport.closed)
        #expect(!transport.sent.contains { $0["method"] as? String == "turn/start" })
    }

    @Test(arguments: AgentProvider.allCases)
    func sendsImagesAndReusesSessionWithBasePromptOnlyOnce(provider: AgentProvider) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let image = directory.appendingPathComponent("window.png")
        let bytes = Data([137, 80, 78, 71])
        try bytes.write(to: image)
        let transport = MockTransport()
        var config = AgentConfiguration(provider: provider)
        config.basePrompt = "基础提示词，只发送一次"
        let session = ProcessAgentSession(configuration: config, directory: directory, transport: transport)
        try await session.start()
        for _ in 0..<2 {
            let reply = try await session.analyze(image: image, appName: "Test App")
            #expect(reply.contains("回复"))
        }
        let messages = transport.sent.filter { ["prompt", "turn/start", "session/prompt"].contains($0["method"] as? String ?? $0["type"] as? String ?? "") }
        #expect(messages.count == 2)
        let encoded = try messages.map { String(decoding: try JSONSerialization.data(withJSONObject: $0), as: UTF8.self) }
        #expect(encoded[0].contains("基础提示词"))
        #expect(!encoded[1].contains("基础提示词"))
        if provider == .codex {
            let starts = transport.sent.filter { $0["method"] as? String == "thread/start" }
            #expect(starts.count == 1)
            let threadParams = try #require(starts.first?["params"] as? [String: Any])
            #expect(threadParams["ephemeral"] as? Bool == true)
            #expect(messages.allSatisfy { ($0["params"] as? [String: Any])?["threadId"] as? String == "thread-1" })
            let params = try #require(messages[0]["params"] as? [String: Any])
            let input = try #require(params["input"] as? [[String: Any]])
            #expect(input[1]["type"] as? String == "localImage")
            #expect(input[1]["path"] as? String == image.path)
        } else {
            #expect(encoded.allSatisfy { $0.contains(bytes.base64EncodedString()) })
        }
        session.stop()
        #expect(transport.closed)
    }

    @Test func textOnlyDSHCanChatButRejectsImagesBeforeSendingThem() async throws {
        let transport = MockTransport()
        transport.supportsImages = false
        let session = ProcessAgentSession(configuration: .init(provider: .dsh), directory: URL(fileURLWithPath: "/tmp"), transport: transport)
        try await session.start()
        #expect(try await session.respond(to: .init(text: "文本问题")) == "DSH 回复")
        let count = transport.sent.count
        await #expect(throws: AgentError.self) { try await session.analyze(image: URL(fileURLWithPath: "/missing.png"), appName: "Test") }
        #expect(transport.sent.count == count)
        #expect(!transport.closed)
        session.stop()
    }

    @Test(arguments: AgentProvider.allCases)
    func supportsTextThenMultipleImagesWithIndependentBasePrompt(provider: AgentProvider) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let png = directory.appendingPathComponent("one.png"), jpg = directory.appendingPathComponent("two.jpg")
        try Data([1]).write(to: png)
        try Data([2]).write(to: jpg)
        let transport = MockTransport()
        var config = AgentConfiguration(provider: provider)
        config.basePrompt = "用户偏好标记"
        let session = ProcessAgentSession(configuration: config, directory: directory, transport: transport)
        try await session.start()
        _ = try await session.respond(to: .init(text: "内部整理", includeBasePrompt: false))
        _ = try await session.respond(to: .init(text: "用户问题", images: [.init(url: png), .init(url: jpg, mimeType: "image/jpeg")]))
        let prompts = transport.sent.filter { ["prompt", "turn/start", "session/prompt"].contains($0["method"] as? String ?? $0["type"] as? String ?? "") }
        let first = try JSONSerialization.data(withJSONObject: prompts[0])
        let second = try JSONSerialization.data(withJSONObject: prompts[1])
        #expect(!String(decoding: first, as: UTF8.self).contains("用户偏好标记"))
        #expect(String(decoding: second, as: UTF8.self).contains("用户偏好标记"))
        if provider != .codex { #expect(String(decoding: second, as: UTF8.self).contains("image\\/jpeg")) }
        session.stop()
    }

    @Test func permissionWaitsForUserAndReturnsExactOfferedID() async throws {
        let transport = MockTransport()
        let session = ProcessAgentSession(configuration: .init(provider: .dsh), directory: URL(fileURLWithPath: "/tmp"), transport: transport)
        try await session.start()
        var answer: ((AgentAnswer) -> Void)?
        session.onInteraction = { request, callback in
            #expect(request.choices.map(\.id) == ["custom-allow-once", "custom-reject-once"])
            #expect(request.detail.contains("echo hello"))
            answer = callback
        }
        transport.onRecord?(["method": "session/update", "params": ["sessionId": "session-1", "update": [
            "sessionUpdate": "tool_call", "toolCallId": "tool-1", "title": "Run command", "rawInput": ["command": "echo hello"],
        ]]])
        transport.onRecord?(["jsonrpc": "2.0", "id": 45, "method": "session/request_permission", "params": [
            "toolCall": ["toolCallId": "tool-1"],
            "options": [["optionId": "custom-allow-once", "name": "允许"], ["optionId": "custom-reject-once", "name": "拒绝"]],
        ]])
        #expect(answer != nil)
        #expect(!transport.sent.contains { $0["id"] as? Int == 45 })
        answer?(.choice("custom-reject-once"))
        try await waitUntil { transport.sent.contains { $0["id"] as? Int == 45 } }
        let response = try #require(transport.sent.last?["result"] as? [String: Any])
        let outcome = try #require(response["outcome"] as? [String: Any])
        #expect(outcome["optionId"] as? String == "custom-reject-once")
        #expect(outcome["outcome"] as? String == "selected")
        session.stop()
    }

    @Test(arguments: AgentProvider.allCases)
    func failedTurnClosesSessionInsteadOfReportingSuccess(provider: AgentProvider) async throws {
        let image = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        try Data([1]).write(to: image)
        defer { try? FileManager.default.removeItem(at: image) }
        let transport = MockTransport()
        transport.failTurn = true
        let session = ProcessAgentSession(configuration: .init(provider: provider), directory: image.deletingLastPathComponent(), transport: transport)
        try await session.start()
        await #expect(throws: AgentError.self) { try await session.analyze(image: image, appName: "Test") }
        #expect(transport.closed)
        await #expect(throws: AgentError.self) { try await session.analyze(image: image, appName: "Test") }
    }

    @Test func processExitReleasesPendingRequest() async throws {
        let transport = MockTransport()
        transport.handler = { _ in }
        let connection = AgentConnection(transport: transport)
        let pending = Task { try await connection.request(["type": "get_state"]) }
        try await waitUntil { !transport.sent.isEmpty }
        transport.onFailure?(AgentError("unexpected exit"))
        await #expect(throws: AgentError.self) { try await pending.value }
        #expect(transport.closed)
    }

    @Test func settingsRoundTripDoesNotSplitArgumentsOrPrompt() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var configuration = AgentConfiguration(provider: .pi)
        configuration.arguments += ["--model", "a value with spaces"]
        configuration.basePrompt = "第一行\n\"第二行\""
        try configuration.save(to: directory)
        let restored = try #require(try AgentConfiguration.load(from: directory))
        #expect(restored.arguments == configuration.arguments)
        #expect(restored.basePrompt == configuration.basePrompt)
    }
}

@MainActor
func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<400 {
        if condition() { return }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
    throw AgentError("Test condition timed out")
}
