import Foundation
import Testing
@testable import QiyiKnowledge

func makeDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

let tinyPNG = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCfcAAAAASUVORK5CYII=")!

struct KnowledgeStoreTests {
    @Test func summaryFilesAreDurableAndMissingFilesDoNotFallBackToStaleIndexText() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root)
        let entry = try await store.addText("原始资料")
        _ = try await store.setSummary("  Agent 的原始输出\n", for: entry.id, provider: "pi")
        let reopened = KnowledgeStore(directory: root)
        #expect(try await reopened.summary(for: entry.id) == "  Agent 的原始输出\n")
        let url = try #require(try await reopened.summaryURL(for: entry.id))
        try FileManager.default.removeItem(at: url)
        await #expect(throws: KnowledgeError.self) { try await reopened.summary(for: entry.id) }
        #expect(try await reopened.text(for: entry.id) == "原始资料")
    }

    @Test func persistsOriginalsAndDuplicateSummariesAcrossReopening() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root.appendingPathComponent("library"))
        let first = try await store.addText("原文一\n保留空格  和换行")
        let second = try await store.addText("原文二")
        _ = try await store.setSummary("相同概述", for: first.id, provider: "pi")
        _ = try await store.setSummary("相同概述", for: second.id, provider: "codex")
        let image = root.appendingPathComponent("image.png")
        try tinyPNG.write(to: image)
        let picture = try await store.addImage(image)
        try FileManager.default.removeItem(at: image)

        let reopened = KnowledgeStore(directory: root.appendingPathComponent("library"))
        #expect(try await reopened.list().count == 3)
        #expect(try await reopened.text(for: first.id) == "原文一\n保留空格  和换行")
        #expect(first.id != second.id)
        #expect(try Data(contentsOf: await reopened.contentURL(for: picture.id)) == tinyPNG)
        #expect(try await reopened.item(picture.id).state == .pending)
        let index = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("library/index.json"))) as? [String: Any])
        let values = try #require(index["entries"] as? [String: Any])
        #expect(values[first.id] != nil && values[second.id] != nil)
    }

    @Test func malformedIndexIsNotSilentlyReplaced() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data("broken index".utf8)
        try bytes.write(to: root.appendingPathComponent("index.json"))
        let store = KnowledgeStore(directory: root)
        await #expect(throws: (any Error).self) { try await store.addText("新的内容") }
        #expect(try Data(contentsOf: root.appendingPathComponent("index.json")) == bytes)
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("content").path))
    }

    @Test func refusesPathsOutsideLibraryAndMissingOriginals() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root)
        let entry = try await store.addText("原文")
        let url = try await store.contentURL(for: entry.id)
        try FileManager.default.removeItem(at: url)
        await #expect(throws: KnowledgeError.self) { try await store.text(for: entry.id) }
        let indexURL = root.appendingPathComponent("index.json")
        var json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: indexURL)) as? [String: Any])
        var entries = try #require(json["entries"] as? [String: [String: Any]])
        entries[entry.id]?["contentFile"] = "../../outside.txt"
        json["entries"] = entries
        try JSONSerialization.data(withJSONObject: json).write(to: indexURL)
        await #expect(throws: KnowledgeError.self) { try await store.contentURL(for: entry.id) }
    }

    @Test func rejectsEmptyOversizedTextAndInvalidImages() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = KnowledgeStore(directory: root)
        await #expect(throws: KnowledgeError.self) { try await store.addText(" \n ") }
        await #expect(throws: KnowledgeError.self) { try await store.addText(String(repeating: "a", count: KnowledgeStore.maximumTextBytes + 1)) }
        let image = root.appendingPathComponent("wrong.png")
        try Data("this is not png".utf8).write(to: image)
        await #expect(throws: KnowledgeError.self) { try await store.addImage(image) }
        #expect(try await store.list().isEmpty)
    }
}
