import Foundation

public struct KnowledgeError: LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public struct KnowledgeItem: Codable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable { case text, image }
    public enum State: String, Codable, Sendable { case pending, ready, failed }
    public let id: String
    public let kind: Kind
    public let source: String
    public let sourceLocator: String?
    public let createdAt: Date
    public let contentFile: String
    public let mimeType: String
    public var summary: String?
    public var summaryFile: String?
    public var state: State
    public var summarizedBy: String?
    public var error: String?
}

public struct KnowledgeSource: Codable, Sendable {
    public let id: String
    public let summary: String
    public let kind: KnowledgeItem.Kind
}

public struct KnowledgeAnswer: Codable, Identifiable, Sendable {
    public let id: String
    public let question: String
    public let response: String
    public let sources: [KnowledgeSource]
    public let provider: String
    public let createdAt: Date
}

/// One actor owns the file-backed key/value index. Raw content is committed
/// before requesting a summary, so provider failures never lose submitted data.
public actor KnowledgeStore {
    public nonisolated let directory: URL
    public static let maximumTextBytes = 64 * 1_024
    public static let maximumImageBytes = 20 * 1_024 * 1_024

    private struct Index: Codable {
        var version = 1
        var entries: [String: KnowledgeItem] = [:]
    }

    public init(directory: URL) { self.directory = directory.standardizedFileURL }

    public func list() throws -> [KnowledgeItem] {
        try readIndex().entries.values.sorted {
            $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt
        }
    }

    public func item(_ id: String) throws -> KnowledgeItem {
        guard let item = try readIndex().entries[id] else { throw KnowledgeError("资料不存在：\(id)") }
        return item
    }

    public func addText(_ text: String) throws -> KnowledgeItem {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw KnowledgeError("请输入要保存的文本。") }
        let data = Data(text.utf8)
        guard data.count <= Self.maximumTextBytes else { throw KnowledgeError("单条文本最多 64 KB，请拆分后保存。") }
        return try insert(data: data, kind: .text, mime: "text/plain", suffix: "txt", source: "用户文本", locator: nil)
    }

    public func addImage(_ url: URL, source: String? = nil, deduplicateScreenshot: Bool = false) throws -> KnowledgeItem {
        let locator = deduplicateScreenshot ? url.standardizedFileURL.path : nil
        if let locator, let existing = try list().first(where: { $0.sourceLocator == locator }) { return existing }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= Self.maximumImageBytes else { throw KnowledgeError("单张图片最多 20 MB。原始图片仍保留。") }
        let data = try Data(contentsOf: url)
        guard data.count <= Self.maximumImageBytes else { throw KnowledgeError("单张图片最多 20 MB。") }
        let format: (String, String)
        if data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) { format = ("image/png", "png") }
        else if data.starts(with: [255, 216, 255]) { format = ("image/jpeg", "jpg") }
        else { throw KnowledgeError("资料库目前接受 PNG 和 JPEG 图片。") }
        return try insert(data: data, kind: .image, mime: format.0, suffix: format.1, source: source ?? url.lastPathComponent, locator: locator)
    }

    public func contentURL(for id: String) throws -> URL {
        let record = try item(id)
        let root = directory.appendingPathComponent("content", isDirectory: true).resolvingSymlinksInPath()
        let url = root.appendingPathComponent(record.contentFile).resolvingSymlinksInPath()
        guard url.deletingLastPathComponent() == root, record.contentFile == url.lastPathComponent else {
            throw KnowledgeError("资料路径无效：\(id)")
        }
        guard FileManager.default.fileExists(atPath: url.path) else { throw KnowledgeError("资料的原始文件已丢失：\(record.contentFile)") }
        return url
    }

    public func text(for id: String) throws -> String {
        guard try item(id).kind == .text else { throw KnowledgeError("该资料不是文本。") }
        let data = try Data(contentsOf: contentURL(for: id))
        guard data.count <= Self.maximumTextBytes, let text = String(data: data, encoding: .utf8) else {
            throw KnowledgeError("资料文本不是有效 UTF-8，或已超过 64 KB。")
        }
        return text
    }

    public func setSummary(_ summary: String, for id: String, provider: String) throws -> KnowledgeItem {
        let normalized = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized.count <= 1_200 else { throw KnowledgeError("Agent 概述为空或超过 1200 字，请重试生成。") }
        _ = try contentURL(for: id)
        var index = try readIndex()
        guard var entry = index.entries[id] else { throw KnowledgeError("资料不存在：\(id)") }
        let folder = directory.appendingPathComponent("summaries", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let filename = id + ".md"
        let output = folder.appendingPathComponent(filename)
        try Data(summary.utf8).write(to: output, options: .atomic)
        entry.summary = normalized
        entry.summaryFile = filename
        entry.state = .ready
        entry.summarizedBy = provider
        entry.error = nil
        index.entries[id] = entry
        do { try writeIndex(index) }
        catch { throw KnowledgeError("概述已写入 \(output.path)，但索引保存失败：\(error.localizedDescription)") }
        return entry
    }

    public func summaryURL(for id: String) throws -> URL? {
        let entry = try item(id)
        guard let filename = entry.summaryFile else { return nil }
        let root = directory.appendingPathComponent("summaries", isDirectory: true).resolvingSymlinksInPath()
        let url = root.appendingPathComponent(filename).resolvingSymlinksInPath()
        guard filename == id + ".md", url.deletingLastPathComponent() == root, url.lastPathComponent == filename else {
            throw KnowledgeError("概述路径无效：\(id)")
        }
        guard FileManager.default.fileExists(atPath: url.path) else { throw KnowledgeError("概述文件已丢失：\(filename)") }
        return url
    }

    public func summary(for id: String) throws -> String {
        let entry = try item(id)
        guard entry.state == .ready, let indexed = entry.summary else { throw KnowledgeError("资料尚未生成可用概述：\(id)") }
        // Older libraries kept summaries in index.json; new records use the standalone output file.
        guard let url = try summaryURL(for: id) else { return indexed }
        let data = try Data(contentsOf: url)
        guard data.count <= Self.maximumTextBytes, let text = String(data: data, encoding: .utf8),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw KnowledgeError("概述文件为空、过大或不是 UTF-8：\(id)")
        }
        return text
    }

    public func markFailed(_ id: String, error: String) throws {
        var index = try readIndex()
        guard var entry = index.entries[id] else { throw KnowledgeError("资料不存在：\(id)") }
        // A failed refresh must not invalidate an already usable summary.
        if entry.summary == nil { entry.state = .failed }
        entry.error = error
        index.entries[id] = entry
        try writeIndex(index)
    }

    public func saveAnswer(_ answer: KnowledgeAnswer) throws {
        let folder = directory.appendingPathComponent("conversations", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try encoder().encode(answer).write(to: folder.appendingPathComponent(answer.id + ".json"), options: .atomic)
    }

    private func insert(data: Data, kind: KnowledgeItem.Kind, mime: String, suffix: String, source: String, locator: String?) throws -> KnowledgeItem {
        var index = try readIndex()
        let id = UUID().uuidString.lowercased()
        let record = KnowledgeItem(id: id, kind: kind, source: source, sourceLocator: locator, createdAt: Date(),
                                   contentFile: id + "." + suffix, mimeType: mime, state: .pending)
        let folder = directory.appendingPathComponent("content", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(record.contentFile)
        try data.write(to: url, options: .atomic)
        index.entries[id] = record
        do { try writeIndex(index) }
        catch { throw KnowledgeError("原始资料已保存到 \(url.path)，但资料索引写入失败：\(error.localizedDescription)") }
        return record
    }

    private func readIndex() throws -> Index {
        let url = directory.appendingPathComponent("index.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return Index() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let index = try decoder.decode(Index.self, from: Data(contentsOf: url))
        guard index.version == 1, index.entries.allSatisfy({ $0.key == $0.value.id && UUID(uuidString: $0.key) != nil }) else {
            throw KnowledgeError("资料索引格式无效，原文件未被覆盖。")
        }
        return index
    }

    private func writeIndex(_ index: Index) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try encoder().encode(index).write(to: directory.appendingPathComponent("index.json"), options: .atomic)
    }

    private func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
