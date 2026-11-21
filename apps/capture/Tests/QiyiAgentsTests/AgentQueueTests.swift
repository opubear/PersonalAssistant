import Foundation
import Testing
import QiyiCaptureCore
@testable import QiyiAgents

@MainActor
private final class ControlledSession: ScreenshotAgentSession {
    var images: [URL] = []
    var completion: CheckedContinuation<String, Error>?
    func start() async throws {}
    func analyze(image: URL, appName: String) async throws -> String {
        images.append(image)
        return try await withCheckedThrowingContinuation { completion = $0 }
    }
    func stop() { complete(.failure(AgentError("stopped"))) }
    func complete(_ result: Result<String, Error>) {
        let callback = completion
        completion = nil
        callback?.resume(with: result)
    }
}

@MainActor
struct AgentQueueTests {
    @Test func aDisposableReaderFailureDoesNotDiscardTheNextScreenshot() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FileScreenshotStore(directory: directory)
        let first = try await store.save(Screenshot(pngData: Data([1]), appName: "Test", capturedAt: Date()))
        let second = try await store.save(Screenshot(pngData: Data([2]), appName: "Test", capturedAt: Date()))
        let session = ControlledSession()
        let queue = ScreenshotAgentQueue(session: session, provider: .codex, failurePolicy: .continueWithNextImage)
        var finished: [ScreenshotAgentResult] = []
        queue.onResult = { if $0.finishedAt != nil { finished.append($0) } }
        await queue.start()
        queue.enqueue(first); queue.enqueue(second)
        try await waitUntil { session.images.count == 1 }
        session.complete(.failure(AgentError("one image failed")))
        try await waitUntil { session.images.count == 2 }
        session.complete(.success("第二张概述"))
        try await waitUntil { finished.count == 2 }
        #expect(!queue.isStopped)
        #expect(finished.map(\.status) == ["failed", "completed"])
        #expect(FileManager.default.fileExists(atPath: second.fileURL.path))
        queue.stop()
    }

    @Test func serializesImagesPersistsResponsesAndKeepsImagesOnFailure() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FileScreenshotStore(directory: directory)
        var screenshots: [ScreenshotReceipt] = []
        for _ in 0..<3 {
            screenshots.append(try await store.save(Screenshot(pngData: Data([1, 2, 3]), appName: "Test", capturedAt: Date())))
        }
        let session = ControlledSession()
        let queue = ScreenshotAgentQueue(session: session, provider: .codex)
        var finished: [ScreenshotAgentResult] = []
        queue.onResult = { if $0.finishedAt != nil { finished.append($0) } }
        await queue.start()
        screenshots.forEach { queue.enqueue($0) }
        try await waitUntil { session.images.count == 1 }
        #expect(session.images == [screenshots[0].fileURL])
        session.complete(.success("第一张的回复"))
        try await waitUntil { session.images.count == 2 }
        session.complete(.failure(AgentError("agent crashed")))
        try await waitUntil { finished.count == 3 }
        #expect(session.images.count == 2)
        #expect(queue.isStopped)
        #expect(finished.filter { $0.status == "completed" }.count == 1)
        #expect(finished.filter { $0.status == "failed" }.count == 2)
        try await waitUntil { finished.allSatisfy { FileManager.default.fileExists(atPath: $0.resultURL.path) } }
        for screenshot in screenshots { #expect(try Data(contentsOf: screenshot.fileURL) == Data([1, 2, 3])) }
        let saved = try #require(finished.first { $0.status == "completed" })
        let json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: saved.resultURL)) as? [String: Any])
        #expect(json["response"] as? String == "第一张的回复")
    }
}
