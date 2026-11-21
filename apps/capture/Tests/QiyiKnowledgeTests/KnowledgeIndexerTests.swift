import Foundation
import Testing
import QiyiAgents
@testable import QiyiKnowledge

@MainActor
struct KnowledgeIndexerTests {
    @Test func screenshotsUseFreshWorkersAndCommitFilesBeforeNotifyingWithoutStartingConversation() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root.appendingPathComponent("library"))
        let conversation = RecordingSession()
        let assistant = KnowledgeAssistant(store: store, conversation: conversation, provider: "codex")
        var workers: [RecordingSession] = []
        let output = "  截图显示交付日期：11 月 20 日。\n"
        let indexer = KnowledgeIndexer(store: store, provider: "pi") {
            let worker = RecordingSession { prompt in
                #expect(prompt.text == KnowledgeIndexer.imagePrompt)
                #expect(!prompt.includeBasePrompt)
                #expect(prompt.images.count == 1)
                let bytes = try Data(contentsOf: prompt.images[0].url)
                #expect(bytes == tinyPNG)
                return output
            }
            workers.append(worker)
            return worker
        }
        var committed: [String] = []
        indexer.onLibraryChanged = {
            let folder = store.directory.appendingPathComponent("summaries")
            let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
            #expect(!files.isEmpty)
            committed = files.map(\.lastPathComponent)
        }
        for index in 0..<2 {
            let image = root.appendingPathComponent("shot\(index).png")
            try tinyPNG.write(to: image)
            let archived = try await store.addImage(image, source: "Browser", deduplicateScreenshot: true)
            try FileManager.default.removeItem(at: image)
            #expect(try await indexer.analyze(image: image, appName: "Browser") == output)
            let path = try #require(try await store.summaryURL(for: archived.id))
            #expect(try String(contentsOf: path, encoding: .utf8) == output)
            #expect(workers[index].prompts[0].images[0].url != image)
        }
        #expect(workers.count == 2 && workers.allSatisfy { $0.starts == 1 && $0.prompts.count == 1 && $0.stopped })
        #expect(committed.count == 2)
        #expect(conversation.starts == 0 && conversation.prompts.isEmpty)
        assistant.stop(); indexer.stop()
    }

    @Test func indexingContinuesWhileThePersistentAgentIsWaitingAndAfterItStops() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root)
        var continuation: CheckedContinuation<String, Never>?
        let conversation = RecordingSession { _ in await withCheckedContinuation { continuation = $0 } }
        let assistant = KnowledgeAssistant(store: store, conversation: conversation, provider: "pi")
        let question = Task { try await assistant.ask("等待中的问题") }
        for _ in 0..<400 {
            if continuation != nil { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        let response = try #require(continuation)
        let indexer = KnowledgeIndexer(store: store, provider: "pi") { RecordingSession { _ in "独立的资料概述" } }
        let first = try await store.addText("第一份资料")
        #expect(try await indexer.summarize(first.id).state == .ready)
        response.resume(returning: "问答结束")
        _ = try await question.value
        assistant.stop()
        let second = try await store.addText("停止问答后新增的资料")
        #expect(try await indexer.summarize(second.id).state == .ready)
        indexer.stop()
    }

    @Test func failedIndexingPreservesOriginalAndRetriesWithAFreshWorker() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root)
        let item = try await store.addText("发布计划：11 月 20 日交付。")
        var workers: [RecordingSession] = []
        let indexer = KnowledgeIndexer(store: store, provider: "pi") {
            let shouldFail = workers.isEmpty
            let worker = RecordingSession { _ in
                if shouldFail { throw KnowledgeError("模型不可用") }
                return "发布计划说明 11 月 20 日交付。"
            }
            workers.append(worker)
            return worker
        }
        var statuses: [String] = []
        indexer.onStatus = { statuses.append($0) }
        await #expect(throws: KnowledgeError.self) { try await indexer.summarize(item.id) }
        #expect(statuses.last?.contains("概述失败") == true)
        #expect(try await store.item(item.id).state == .failed)
        #expect(try await store.text(for: item.id).contains("11 月 20 日"))
        #expect(try await indexer.summarize(item.id).state == .ready)
        #expect(workers.count == 2 && workers.allSatisfy(\.stopped))
        #expect(workers[1].prompts[0].includeBasePrompt == false)
        indexer.stop()
    }

    @Test func storageFailureIsNotReportedAsACompletedSummary() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root)
        let item = try await store.addText("需要保存的原文")
        try Data("not a directory".utf8).write(to: root.appendingPathComponent("summaries"))
        let indexer = KnowledgeIndexer(store: store, provider: "pi") { RecordingSession { _ in "资料概述" } }
        var completed = false
        indexer.onStatus = { if $0.contains("文件已保存") { completed = true } }
        await #expect(throws: (any Error).self) { try await indexer.summarize(item.id) }
        #expect(!completed)
        #expect(try await store.item(item.id).state == .failed)
        #expect(try await store.text(for: item.id) == "需要保存的原文")
        indexer.stop()
    }

    @Test func explicitRegenerationReplacesTheFileAndFailedRegenerationPreservesIt() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root)
        let item = try await store.addText("原文")
        var count = 0
        let indexer = KnowledgeIndexer(store: store, provider: "pi") {
            count += 1
            let current = count
            return RecordingSession { _ in
                if current == 3 { throw KnowledgeError("重新生成失败") }
                return "第 \(current) 版概述"
            }
        }
        _ = try await indexer.summarize(item.id)
        _ = try await indexer.summarize(item.id)
        #expect(count == 1)
        _ = try await indexer.summarize(item.id, force: true)
        #expect(try await store.summary(for: item.id) == "第 2 版概述")
        await #expect(throws: KnowledgeError.self) { try await indexer.summarize(item.id, force: true) }
        #expect(try await store.summary(for: item.id) == "第 2 版概述")
        indexer.stop()
    }
}
