import Foundation
import Testing
import QiyiAgents
@testable import QiyiKnowledge

@MainActor
final class RecordingSession: ConversationAgentSession {
    var prompts: [AgentPrompt] = []
    var stopped = false
    var starts = 0
    var responder: (AgentPrompt) async throws -> String
    init(_ responder: @escaping (AgentPrompt) async throws -> String = { _ in "回答正文" }) { self.responder = responder }
    func start() async throws { starts += 1 }
    func stop() { stopped = true }
    func respond(to prompt: AgentPrompt) async throws -> String { prompts.append(prompt); return try await responder(prompt) }
    func analyze(image: URL, appName: String) async throws -> String { try await respond(to: .init(text: appName, images: [.init(url: image)])) }
}

@MainActor
struct KnowledgeAssistantTests {
    @Test func usesCurrentPersonalMemoryInAnswers() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let conversation = RecordingSession()
        let assistant = KnowledgeAssistant(store: KnowledgeStore(directory: root), conversation: conversation, provider: "pi")
        var current = "LOCAL_PERSONAL_MEMORY"
        assistant.personalContext = { current }
        _ = try await assistant.ask("问题")
        #expect(conversation.prompts[0].text.contains("LOCAL_PERSONAL_MEMORY"))
        current = "CHANGED_PERSONAL_MEMORY"
        _ = try await assistant.ask("追问")
        #expect(conversation.prompts[1].text.contains("CHANGED_PERSONAL_MEMORY"))
        #expect(!conversation.prompts[1].text.contains("LOCAL_PERSONAL_MEMORY"))
        #expect(conversation.starts == 1)
        assistant.stop()
    }

    @Test func answersFromTheSummaryFileWithoutReadingTheImage() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root.appendingPathComponent("library"))
        let png = root.appendingPathComponent("screen.png")
        try tinyPNG.write(to: png)
        let picture = try await store.addImage(png)
        _ = try await store.setSummary("旧的索引概述", for: picture.id, provider: "codex")
        let summaryFile = try #require(try await store.summaryURL(for: picture.id))
        try Data("从文件读取的最新概述：交付日期 11 月 20 日。".utf8).write(to: summaryFile)
        // A summary-only answer still works when the original is unavailable.
        try FileManager.default.removeItem(at: await store.contentURL(for: picture.id))
        let conversation = RecordingSession { request in
            #expect(request.images.isEmpty)
            #expect(request.text.contains("从文件读取的最新概述"))
            #expect(!request.text.contains("旧的索引概述"))
            if request.text.contains("概述目录：") { return "{\"ids\":[\"\(picture.id)\"],\"readOriginalIds\":[]}" }
            return "交付日期为 11 月 20 日。"
        }
        let assistant = KnowledgeAssistant(store: KnowledgeStore(directory: store.directory), conversation: conversation, provider: "codex")
        let answer = try await assistant.ask("交付日期？")
        #expect(answer.sources.map(\.id) == [picture.id])
        #expect(conversation.prompts.count == 2)
        #expect(FileManager.default.fileExists(atPath: store.directory.appendingPathComponent("conversations/\(answer.id).json").path))
        assistant.stop()
    }

    @Test func readsOriginalsOnlyWhenThePersistentAgentRequestsThem() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root.appendingPathComponent("library"))
        let chosen = try await store.addText("实际交付日期是 11 月 20 日。原文核验标记。")
        let ignored = try await store.addText("不应发送给回答会话的内容标记。")
        let png = root.appendingPathComponent("screen.png")
        try tinyPNG.write(to: png)
        let picture = try await store.addImage(png)
        for item in [chosen, ignored, picture] { _ = try await store.setSummary("概述 \(item.id)", for: item.id, provider: "codex") }
        let conversation = RecordingSession { request in
            #expect(!request.text.contains("不应发送给回答会话"))
            if request.text.contains("概述目录：") {
                #expect(request.images.isEmpty)
                #expect(!request.text.contains("原文核验标记"))
                return "{\"ids\":[\"\(chosen.id)\",\"\(picture.id)\"],\"readOriginalIds\":[\"\(chosen.id)\",\"\(picture.id)\"]}"
            }
            #expect(request.text.contains("原文核验标记"))
            #expect(request.images.count == 1)
            let bytes = try Data(contentsOf: request.images[0].url)
            #expect(bytes == tinyPNG)
            return "原件核对完成。"
        }
        let assistant = KnowledgeAssistant(store: store, conversation: conversation, provider: "codex")
        let answer = try await assistant.ask("请核对原文和图片。")
        #expect(answer.sources.map(\.id) == [chosen.id, picture.id])
        #expect(conversation.starts == 1)
        assistant.stop()
    }

    @Test func invalidSelectionAndMissingRequestedOriginalNeverProduceAnAnswer() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root)
        let item = try await store.addText("事实原文")
        _ = try await store.setSummary("事实概述", for: item.id, provider: "pi")
        var invalid = true
        let conversation = RecordingSession { request in
            #expect(request.text.contains("概述目录："))
            return invalid ? "{\"ids\":[\"../../secret\"],\"readOriginalIds\":[]}"
                : "{\"ids\":[\"\(item.id)\"],\"readOriginalIds\":[\"\(item.id)\"]}"
        }
        let assistant = KnowledgeAssistant(store: store, conversation: conversation, provider: "pi")
        await #expect(throws: KnowledgeError.self) { try await assistant.ask("事实？") }
        invalid = false
        try FileManager.default.removeItem(at: await store.contentURL(for: item.id))
        await #expect(throws: KnowledgeError.self) { try await assistant.ask("核对原文？") }
        #expect(conversation.prompts.count == 2)
        assistant.stop()
    }

    @Test func pagesThroughSummariesAndSerializesQuestionsInOnePersistentSession() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root)
        for index in 0..<32 {
            let item = try await store.addText("原文 \(index)")
            _ = try await store.setSummary("概述标记\(index)结束", for: item.id, provider: "pi")
        }
        var concurrent = 0, maximum = 0
        var catalogs: [String] = []
        let conversation = RecordingSession { request in
            concurrent += 1; maximum = max(maximum, concurrent)
            defer { concurrent -= 1 }
            try await Task.sleep(nanoseconds: 5_000_000)
            if request.text.contains("概述目录：") { catalogs.append(request.text); return "{\"ids\":[],\"readOriginalIds\":[]}" }
            return "暂无相关资料。"
        }
        let assistant = KnowledgeAssistant(store: store, conversation: conversation, provider: "pi")
        async let first = assistant.ask("问题一")
        async let second = assistant.ask("问题二")
        _ = try await (first, second)
        #expect(maximum == 1)
        #expect(conversation.starts == 1)
        #expect(catalogs.count == 4)
        for index in 0..<32 { #expect(catalogs.joined().contains("概述标记\(index)结束")) }
        assistant.stop()
    }

    @Test func selectionValidationRequiresOriginalsToBeSelectedAndAcceptsFencedJSON() throws {
        #expect(try KnowledgeAssistant.decodeSelection("```json\n{\"ids\":[\"a\"],\"readOriginalIds\":[]}\n```", allowed: ["a"]).ids == ["a"])
        for invalid in ["{\"ids\":[\"a\",\"a\"],\"readOriginalIds\":[]}",
                        "{\"ids\":[],\"readOriginalIds\":[\"a\"]}",
                        "{\"ids\":[\"a\"],\"readOriginalIds\":[\"a\",\"a\"]}", "我认为 a 合适"] {
            #expect(throws: KnowledgeError.self) { try KnowledgeAssistant.decodeSelection(invalid, allowed: ["a"]) }
        }
    }
}
