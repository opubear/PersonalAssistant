import Foundation
import QiyiAgents
import QiyiCaptureCore
import QiyiKnowledge
#if os(macOS)
import AppKit
import QiyiMacOS
#endif

/// A local JSONL interface shared by desktop frontends. The service owns all
/// mutations and agent lifetimes; a UI never edits the library files directly.
@MainActor
final class SnapService {
    let directory: URL
    private let store: KnowledgeStore
    private let emit: ([String: Any]) -> Void
    private let finish: () -> Void
    private var assistant: KnowledgeAssistant?
    private var indexer: KnowledgeIndexer?
    private var screenshots: ScreenshotAgentQueue?
    private var generation = UUID()
    private var readerGeneration = UUID()
    private var readerConfiguration: AgentConfiguration?
    private var readerLoaded = false
    private var interactions: [String: (owner: UUID, group: UUID, request: AgentInteraction, answer: (AgentAnswer) -> Void)] = [:]
    private var isClosing = false
    private var activeIDs: Set<String> = []
    private var shortcutError: String?
    private var personalContext = ""
    #if os(macOS)
    private var hotKey: MacOSGlobalHotKey?
    private lazy var captureBackend = ScreenshotBackend(provider: MacOSCaptureProvider(), store: FileScreenshotStore(directory: directory))
    #endif

    init(directory: URL, emit: @escaping ([String: Any]) -> Void, finish: @escaping () -> Void) {
        self.directory = directory
        self.store = KnowledgeStore(directory: directory.appendingPathComponent("library", isDirectory: true))
        self.emit = emit
        self.finish = finish
    }

    func registerShortcut() {
        #if os(macOS)
        do {
            hotKey = try MacOSGlobalHotKey { [weak self] in
                guard let self else { return }
                do {
                    // Pin the focused window synchronously at the key event.
                    let operation = try self.beginCapture()
                    Task {
                        do { _ = try await operation.value }
                        catch { self.event("warning", ["message": error.localizedDescription]) }
                    }
                } catch {
                    self.event("warning", ["message": error.localizedDescription])
                }
            }
        } catch { shortcutError = error.localizedDescription }
        #endif
    }

    func receive(_ message: [String: Any]) {
        guard let id = message["id"] as? String, let method = message["method"] as? String else {
            event("warning", ["message": "无效请求：需要 id 和 method。"])
            return
        }
        guard !isClosing else { return }
        guard !activeIDs.contains(id), activeIDs.count < 64 else {
            emit(["id": id, "error": ["message": "重复请求或等待请求过多。"]])
            return
        }
        activeIDs.insert(id)
        Task {
            defer { activeIDs.remove(id) }
            do {
                let result = try await dispatch(method, message["params"] as? [String: Any] ?? [:])
                emit(["id": id, "result": result])
            } catch { emit(["id": id, "error": ["message": error.localizedDescription]]) }
        }
    }

    private func dispatch(_ method: String, _ params: [String: Any]) async throws -> Any {
        switch method {
        case "initialize":
            let configuration: AgentConfiguration
            do { configuration = try AgentConfiguration.load(from: directory) ?? AgentConfiguration() }
            catch {
                configuration = AgentConfiguration()
                event("warning", ["message": "无法读取 agent 设置，已显示默认值。原设置文件未被覆盖：\(error.localizedDescription)"])
            }
            var reader: [String: Any]
            do { reader = try readerState() }
            catch {
                var defaults = AgentConfiguration()
                defaults.basePrompt = ""
                reader = ["configured": false, "configuration": try json(defaults), "error": error.localizedDescription]
                event("warning", ["message": "无法读取临时读图设置，原文件未被覆盖：\(error.localizedDescription)"])
            }
            return ["protocolVersion": 1, "directory": directory.path, "permissions": permissions(),
                    "configuration": try json(configuration), "reader": reader]
        case "permissions/status": return permissions()
        case "context/set":
            let text = try string("text", in: params)
            guard text.utf8.count <= 1_024 * 1_024 else { throw AgentError("个人上下文过大。") }
            personalContext = text
            return [:] as [String: String]
        case "permissions/request":
            #if os(macOS)
            switch try string("kind", in: params) {
            case "accessibility": MacOSPermissions.requestAccessibility()
            case "screenCapture": MacOSPermissions.requestScreenCapture()
            default: throw AgentError("未知权限类型。")
            }
            return permissions()
            #else
            throw AgentError("当前平台尚未提供窗口截图适配。")
            #endif
        case "capture": return try json(await capture())
        case "library/list": return try json(await store.list())
        case "library/content":
            let id = try string("id", in: params)
            var item = try await store.item(id)
            if item.state == .ready { item.summary = try await store.summary(for: id) }
            var result: [String: Any] = ["item": try json(item), "path": try await store.contentURL(for: id).path]
            if let summary = try await store.summaryURL(for: id) { result["summaryPath"] = summary.path }
            if item.kind == .text { result["text"] = try await store.text(for: id) }
            return result
        case "library/addText":
            let item = try await store.addText(string("text", in: params))
            added(item)
            return try json(item)
        case "library/addImage":
            let item = try await store.addImage(URL(fileURLWithPath: string("path", in: params)))
            added(item)
            return try json(item)
        case "library/summarize":
            return try json(await ensureIndexer().summarize(string("id", in: params), force: params["force"] as? Bool ?? false))
        case "reader/configure":
            let data = try JSONSerialization.data(withJSONObject: params["configuration"] ?? [:])
            var configuration = try JSONDecoder().decode(AgentConfiguration.self, from: data)
            configuration.basePrompt = ""
            try configuration.validate()
            try configuration.save(to: directory, filename: "reader-settings.json")
            stopReader()
            readerConfiguration = configuration
            readerLoaded = true
            return try readerState()
        case "agent/start":
            let data = try JSONSerialization.data(withJSONObject: params["configuration"] ?? [:])
            let configuration = try JSONDecoder().decode(AgentConfiguration.self, from: data)
            try configuration.validate()
            try configuration.save(to: directory)
            try await startAgent(configuration)
            return ["ready": true]
        case "agent/stop": stopAgent(); return [:] as [String: String]
        case "chat/ask":
            guard let assistant else { throw AgentError("请先启动 agent 会话。") }
            return try json(await assistant.ask(string("text", in: params)))
        case "interaction/respond":
            try respond(params)
            return [:] as [String: String]
        case "shutdown": shutdown(); return [:] as [String: String]
        default: throw AgentError("未知方法：\(method)")
        }
    }

    private func added(_ item: KnowledgeItem) {
        event("libraryChanged", [:])
        Task {
            do {
                guard try loadReaderConfiguration() != nil else {
                    event("readerStatus", ["message": "资料已保存 · 在设置中配置临时读图 Agent 后可生成概述"])
                    return
                }
                _ = try await ensureIndexer().summarize(item.id)
            }
            catch { event("warning", ["message": "资料已保存，概述未完成：\(error.localizedDescription)"]) }
        }
    }

    private func loadReaderConfiguration() throws -> AgentConfiguration? {
        if readerLoaded { return readerConfiguration }
        // Seed older installations from their saved launch settings once; later edits are independent.
        var configuration = try AgentConfiguration.load(from: directory, filename: "reader-settings.json")
        if configuration == nil, var legacy = try AgentConfiguration.load(from: directory) {
            legacy.basePrompt = ""
            try legacy.save(to: directory, filename: "reader-settings.json")
            configuration = legacy
        }
        configuration?.basePrompt = ""
        try configuration?.validate()
        readerConfiguration = configuration
        readerLoaded = true
        return configuration
    }

    private func readerState() throws -> [String: Any] {
        let configuration = try loadReaderConfiguration()
        var defaults = AgentConfiguration()
        defaults.basePrompt = ""
        return ["configured": configuration != nil, "configuration": try json(configuration ?? defaults),
                "prompt": KnowledgeIndexer.imagePrompt]
    }

    private func ensureIndexer() throws -> KnowledgeIndexer {
        guard !isClosing else { throw AgentError("服务正在退出，新的概述任务未启动。") }
        if let indexer { return indexer }
        guard let configuration = try loadReaderConfiguration() else {
            throw AgentError("请先在设置中保存临时读图 Agent 配置；无需启动持久 Agent。")
        }
        let run = readerGeneration
        let directory = self.directory
        let worker = KnowledgeIndexer(store: store, provider: configuration.provider.rawValue) { [weak self] in
            self?.makeSession(configuration, run: run, primary: false)
                ?? ProcessAgentSession(configuration: configuration, directory: directory)
        }
        worker.onLibraryChanged = { [weak self] in
            guard let self, self.readerGeneration == run else { return }
            self.event("libraryChanged", [:])
        }
        worker.onStatus = { [weak self] message in
            guard let self, self.readerGeneration == run else { return }
            self.event("readerStatus", ["message": message])
        }
        worker.onWarning = { [weak self] message in self?.event("warning", ["message": message]) }
        indexer = worker
        return worker
    }

    private func screenshotQueue() throws -> ScreenshotAgentQueue {
        if let screenshots { return screenshots }
        let indexer = try ensureIndexer()
        guard let configuration = readerConfiguration else { throw AgentError("临时读图配置未加载。") }
        let queue = ScreenshotAgentQueue(session: indexer, provider: configuration.provider, failurePolicy: .continueWithNextImage)
        queue.onResult = { [weak self] result in
            guard let self else { return }
            do { self.emit(["event": "screenshotResult", "data": try self.json(result)]) }
            catch { self.event("warning", ["message": error.localizedDescription]) }
        }
        queue.onStorageError = { [weak self] in self?.event("warning", ["message": $0.localizedDescription]) }
        screenshots = queue
        return queue
    }

    private func stopReader() {
        let run = readerGeneration
        readerGeneration = UUID()
        screenshots?.stop()
        indexer?.stop()
        screenshots = nil
        indexer = nil
        cancelInteractions(group: run)
    }

    private func startAgent(_ configuration: AgentConfiguration) async throws {
        stopAgent()
        let run = UUID()
        generation = run
        let session = makeSession(configuration, run: run, primary: true)
        let knowledge = KnowledgeAssistant(store: store, conversation: session, provider: configuration.provider.rawValue)
        assistant = knowledge
        knowledge.personalContext = { [weak self] in self?.personalContext ?? "" }
        knowledge.onWarning = { [weak self] in self?.event("warning", ["message": $0]) }
        knowledge.onStatus = { [weak self] text in
            guard let self, self.generation == run else { return }
            self.event("status", ["message": text])
        }
        event("agentState", ["state": "starting"])
        do {
            try await knowledge.start()
            guard generation == run else { throw AgentError("启动已取消。") }
            event("agentState", ["state": "ready"])
        } catch {
            if generation == run { stopAgent() }
            throw error
        }
    }

    private func makeSession(_ config: AgentConfiguration, run: UUID, primary: Bool) -> ProcessAgentSession {
        let session = ProcessAgentSession(configuration: config, directory: directory)
        let owner = UUID()
        session.onInteraction = { [weak self] request, answer in
            guard let self, (primary ? self.generation : self.readerGeneration) == run, !self.isClosing else { answer(.cancelled); return }
            let id = UUID().uuidString
            self.interactions[id] = (owner, run, request, answer)
            self.event("interaction", ["id": id, "title": request.title, "detail": request.detail,
                                      "choices": request.choices.map { ["id": $0.id, "title": $0.title] },
                                      "acceptsText": request.acceptsText, "initialText": request.initialText])
        }
        session.onDisconnect = { [weak self] error in
            guard let self else { return }
            self.cancelInteractions(owner: owner)
            if primary, self.generation == run {
                self.stopAgent()
                self.event("warning", ["message": error.localizedDescription])
            }
        }
        if primary {
            session.onProgress = { [weak self] text in
                guard let self, self.generation == run else { return }
                self.event("progress", ["text": text])
            }
        }
        return session
    }

    private func stopAgent() {
        let run = generation
        generation = UUID()
        assistant?.stop()
        assistant = nil
        cancelInteractions(group: run)
        event("agentState", ["state": "stopped"])
    }

    private func respond(_ params: [String: Any]) throws {
        let id = try string("id", in: params)
        guard let pending = interactions[id] else { throw AgentError("该交互已结束。") }
        let answer: AgentAnswer
        switch try string("kind", in: params) {
        case "cancelled": answer = .cancelled
        case "text":
            guard pending.request.acceptsText else { throw AgentError("该交互不接受文本。") }
            answer = .text(try string("value", in: params))
        case "choice":
            let value = try string("value", in: params)
            guard pending.request.choices.contains(where: { $0.id == value }) else { throw AgentError("无效选项。") }
            answer = .choice(value)
        default: throw AgentError("无效交互回复。")
        }
        interactions.removeValue(forKey: id)
        pending.answer(answer)
    }

    private func cancelInteractions(owner: UUID? = nil, group: UUID? = nil) {
        let ids = interactions.filter { (owner == nil || $0.value.owner == owner) && (group == nil || $0.value.group == group) }.map(\.key)
        for id in ids { interactions.removeValue(forKey: id)?.answer(.cancelled) }
        if !ids.isEmpty { event("interactionCancelled", ["ids": ids]) }
    }

    private func capture() async throws -> ScreenshotReceipt {
        try await beginCapture().value
    }

    private func beginCapture() throws -> Task<ScreenshotReceipt, Error> {
        #if os(macOS)
        guard let task = try captureBackend.captureFocusedWindow() else { throw AgentError("正在截图，请稍后重试。") }
        return Task {
            let receipt = try await task.value
            do {
                _ = try await store.addImage(receipt.fileURL, source: receipt.appName, deduplicateScreenshot: true)
                event("libraryChanged", [:])
            } catch { event("warning", ["message": "截图已保存，但归档失败：\(error.localizedDescription)"]) }
            emit(["event": "captured", "data": try json(receipt)])
            do {
                if try loadReaderConfiguration() != nil {
                    let queue = try screenshotQueue()
                    await queue.start()
                    queue.enqueue(receipt)
                } else { event("readerStatus", ["message": "截图已保存 · 配置临时读图 Agent 后可生成概述"]) }
            } catch { event("warning", ["message": "截图已保存，但概述未启动：\(error.localizedDescription)"]) }
            return receipt
        }
        #else
        throw AgentError("当前平台尚未提供窗口截图适配，可使用文本和图片导入。")
        #endif
    }

    private func permissions() -> [String: Any] {
        #if os(macOS)
        let value = MacOSPermissions.status()
        return ["platform": "macOS", "captureSupported": true, "accessibility": value.accessibility,
                "screenCapture": value.screenCapture, "shortcutRegistered": hotKey != nil, "shortcutError": shortcutError ?? ""]
        #else
        return ["platform": "other", "captureSupported": false, "shortcutRegistered": false]
        #endif
    }

    func shutdown() {
        guard !isClosing else { return }
        isClosing = true
        stopAgent()
        stopReader()
        #if os(macOS)
        hotKey = nil
        #endif
        Task {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            finish()
        }
    }

    private func event(_ name: String, _ data: [String: Any]) { emit(["event": name, "data": data]) }

    private func string(_ name: String, in params: [String: Any]) throws -> String {
        guard let value = params[name] as? String else { throw AgentError("缺少参数：\(name)") }
        return value
    }

    private func json<T: Encodable>(_ value: T) throws -> Any {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try JSONSerialization.jsonObject(with: encoder.encode(value), options: [.fragmentsAllowed])
    }
}
