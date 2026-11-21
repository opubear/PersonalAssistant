import Foundation

public enum AgentProvider: String, Codable, CaseIterable, Sendable {
    case codex, pi, dsh

    public var arguments: [String] {
        switch self {
        case .codex: return ["app-server"]
        case .pi: return ["--mode", "rpc"]
        case .dsh: return ["--profile", "acp"]
        }
    }
}

public struct AgentConfiguration: Codable, Sendable {
    public var provider: AgentProvider
    public var executable: String
    public var arguments: [String]
    public var basePrompt: String
    public var reasoningEffort: String?

    public init(provider: AgentProvider = .codex) {
        self.provider = provider
        executable = provider.rawValue
        arguments = provider.arguments
        basePrompt = "你是栖忆个人助手。请用中文回答，优先使用本地概述文件，必要时核对原文或图片，清楚区分概述与原始证据。"
    }

    public func validate() throws {
        guard !executable.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AgentError("请选择 agent 的可执行文件或填写命令名称。")
        }
        if let effort = reasoningEffort {
            guard provider == .codex, !effort.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw AgentError("思考深度仅支持 Codex，且不能使用空值。")
            }
        }
    }

    public static func load(from directory: URL, filename: String = "agent-settings.json") throws -> Self? {
        let url = directory.appendingPathComponent(filename)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        var configuration = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        let oldDefault = "请用中文分析我发送的窗口截图，先说明看到的内容，再回答其中的问题或给出建议。后续截图属于同一个会话，请结合上下文。"
        if configuration.basePrompt == oldDefault { configuration.basePrompt = Self(provider: configuration.provider).basePrompt }
        return configuration
    }

    public func save(to directory: URL, filename: String = "agent-settings.json") throws {
        try validate()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: directory.appendingPathComponent(filename), options: .atomic)
    }
}

public struct AgentError: LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public struct AgentInteraction {
    public struct Choice {
        public let id: String
        public let title: String
        public init(id: String, title: String) { self.id = id; self.title = title }
    }
    public let title: String
    public let detail: String
    public let choices: [Choice]
    public let acceptsText: Bool
    public let initialText: String

    public init(title: String, detail: String, choices: [Choice] = [], acceptsText: Bool = false, initialText: String = "") {
        self.title = title
        self.detail = detail
        self.choices = choices
        self.acceptsText = acceptsText
        self.initialText = initialText
    }
}

public enum AgentAnswer {
    case choice(String), text(String), cancelled
}

@MainActor
public protocol ScreenshotAgentSession: AnyObject {
    func start() async throws
    func analyze(image: URL, appName: String) async throws -> String
    func stop()
}

public struct AgentImage: Sendable {
    public let url: URL
    public let mimeType: String
    public init(url: URL, mimeType: String = "image/png") { self.url = url; self.mimeType = mimeType }
}

public struct AgentPrompt: Sendable {
    public let text: String
    public let images: [AgentImage]
    public let includeBasePrompt: Bool
    public let reportsProgress: Bool

    public init(text: String, images: [AgentImage] = [], includeBasePrompt: Bool = true, reportsProgress: Bool = true) {
        self.text = text
        self.images = images
        self.includeBasePrompt = includeBasePrompt
        self.reportsProgress = reportsProgress
    }
}

@MainActor
public protocol ConversationAgentSession: ScreenshotAgentSession {
    func respond(to prompt: AgentPrompt) async throws -> String
}
