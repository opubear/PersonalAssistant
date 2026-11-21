import Foundation
import QiyiCaptureCore

public struct ScreenshotAgentResult: Codable, Sendable {
    public let screenshot: ScreenshotReceipt
    public let provider: AgentProvider
    public let session: UUID
    public var status: String
    public var response: String
    public var error: String?
    public var finishedAt: Date?

    public var resultURL: URL { screenshot.fileURL.deletingPathExtension().appendingPathExtension("agent.json") }
}

/// Serializes jobs independently of capture. Persistent sessions stop on failure;
/// disposable readers may continue with a fresh worker for the next screenshot.
@MainActor
public final class ScreenshotAgentQueue {
    public enum FailurePolicy { case stopSession, continueWithNextImage }
    public var onResult: ((ScreenshotAgentResult) -> Void)?
    public var onStatus: ((String) -> Void)?
    public var onStorageError: ((Error) -> Void)?
    public private(set) var isStopped = false
    private let session: any ScreenshotAgentSession
    private let provider: AgentProvider
    private let failurePolicy: FailurePolicy
    private let sessionID = UUID()
    private var pending: [ScreenshotAgentResult] = []
    private var working = false
    private var ready = false
    private var started = false
    private let limit = 20

    public init(session: any ScreenshotAgentSession, provider: AgentProvider, failurePolicy: FailurePolicy = .stopSession) {
        self.session = session
        self.provider = provider
        self.failurePolicy = failurePolicy
    }

    public func start() async {
        guard !started, !isStopped else { return }
        started = true
        onStatus?("正在启动 agent…")
        do {
            try await session.start()
            guard !isStopped else { return }
            ready = true
            onStatus?("Agent 已就绪")
            drain()
        } catch { stop(reason: error.localizedDescription) }
    }

    public func enqueue(_ screenshot: ScreenshotReceipt) {
        var result = ScreenshotAgentResult(screenshot: screenshot, provider: provider, session: sessionID, status: "queued", response: "")
        if isStopped || pending.count >= limit {
            result.status = "failed"
            result.error = isStopped ? "会话已停止；请重新启动 agent 后再截图。" : "等待队列已满（20 张）；本张图片已保存但未发送。"
            result.finishedAt = Date()
            publishAndSave(result)
            return
        }
        pending.append(result)
        onResult?(result)
        onStatus?("等待 agent · \(pending.count) 张")
        drain()
    }

    public func stop(reason: String = "会话已由用户停止。") {
        guard !isStopped else { return }
        isStopped = true
        ready = false
        session.stop()
        failPending(reason)
        onStatus?("Agent 已停止：\(reason)")
    }

    private func drain() {
        guard ready, !working, !isStopped, !pending.isEmpty else { return }
        working = true
        Task {
            defer { working = false }
            while !pending.isEmpty, !isStopped {
                var result = pending.removeFirst()
                result.status = "running"
                onResult?(result)
                onStatus?("Agent 正在分析 · 等待 \(pending.count) 张")
                do {
                    result.response = try await session.analyze(image: result.screenshot.fileURL, appName: result.screenshot.appName)
                    result.status = "completed"
                } catch {
                    result.status = "failed"
                    result.error = error.localizedDescription
                    if failurePolicy == .stopSession { stop(reason: error.localizedDescription) }
                }
                result.finishedAt = Date()
                await save(result)
                onResult?(result)
            }
            if !isStopped { onStatus?("Agent 已就绪 · 回复已保存") }
        }
    }

    private func failPending(_ reason: String) {
        let waiting = pending
        pending.removeAll()
        for var result in waiting {
            result.status = "failed"
            result.error = "未发送：\(reason)"
            result.finishedAt = Date()
            publishAndSave(result)
        }
    }

    private func publishAndSave(_ result: ScreenshotAgentResult) {
        onResult?(result)
        Task { await save(result) }
    }

    private func save(_ result: ScreenshotAgentResult) async {
        do {
            try await Task.detached {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
                encoder.dateEncodingStrategy = .iso8601
                try encoder.encode(result).write(to: result.resultURL, options: .atomic)
            }.value
        } catch { onStorageError?(AgentError("Agent 回复未能保存：\(error.localizedDescription)")) }
    }
}
