import Foundation
import Testing
@testable import QiyiCaptureCore

private enum TestFailure: Error { case focus, capture, storage }

@MainActor
private final class FakeCaptureProvider: WindowCaptureProvider {
    var focusedID = 1
    var focusFails = false
    var captureFails = false
    var capturedIDs: [Int] = []

    func focusedWindow() throws -> FocusedWindowTarget<Int> {
        if focusFails { throw TestFailure.focus }
        return FocusedWindowTarget(handle: focusedID, appName: "Test Editor")
    }

    func capturePNG(_ window: Int) async throws -> Data {
        capturedIDs.append(window)
        if captureFails { throw TestFailure.capture }
        return Data([1, 2, 3])
    }
}

private actor MemoryScreenshotStore: ScreenshotStore {
    var screenshots: [Screenshot] = []
    var fails = false

    func setFailure(_ value: Bool) { fails = value }

    func save(_ screenshot: Screenshot) async throws -> ScreenshotReceipt {
        if fails { throw TestFailure.storage }
        screenshots.append(screenshot)
        return ScreenshotReceipt(
            fileURL: URL(fileURLWithPath: "/test/screenshot.png"),
            appName: screenshot.appName, capturedAt: screenshot.capturedAt,
            byteCount: screenshot.pngData.count
        )
    }
}

@MainActor
struct ScreenshotBackendTests {
    @Test func pinsFocusBeforeAsyncWorkAndIgnoresDuplicateTriggers() async throws {
        let provider = FakeCaptureProvider()
        let store = MemoryScreenshotStore()
        let backend = ScreenshotBackend(provider: provider, store: store)
        let before = Date()
        let operation = try #require(try backend.captureFocusedWindow())
        #expect(backend.isCapturing)
        provider.focusedID = 2
        let after = Date()
        #expect(try backend.captureFocusedWindow() == nil)

        let receipt = try await operation.value
        let saved = await store.screenshots
        #expect(provider.capturedIDs == [1])
        #expect(saved.count == 1)
        #expect(saved[0].pngData == Data([1, 2, 3]))
        #expect(receipt.appName == "Test Editor")
        #expect(receipt.capturedAt >= before && receipt.capturedAt <= after)
        #expect(!backend.isCapturing)

        let next = try #require(try backend.captureFocusedWindow())
        _ = try await next.value
        #expect(provider.capturedIDs == [1, 2])
    }

    @Test func focusFailureDoesNotOccupyCaptureSlot() async throws {
        let provider = FakeCaptureProvider()
        provider.focusFails = true
        let store = MemoryScreenshotStore()
        let backend = ScreenshotBackend(provider: provider, store: store)
        #expect(throws: TestFailure.focus) { try backend.captureFocusedWindow() }
        #expect(!backend.isCapturing)
        #expect(await store.screenshots.isEmpty)

        provider.focusFails = false
        let retry = try #require(try backend.captureFocusedWindow())
        _ = try await retry.value
        #expect(provider.capturedIDs == [1])
    }

    @Test func captureFailureDoesNotWriteAndAllowsRetry() async throws {
        let provider = FakeCaptureProvider()
        provider.captureFails = true
        let store = MemoryScreenshotStore()
        let backend = ScreenshotBackend(provider: provider, store: store)
        let failed = try #require(try backend.captureFocusedWindow())
        await #expect(throws: TestFailure.capture) { try await failed.value }
        #expect(!backend.isCapturing)
        #expect(await store.screenshots.isEmpty)

        provider.captureFails = false
        let retry = try #require(try backend.captureFocusedWindow())
        _ = try await retry.value
        #expect(await store.screenshots.count == 1)
    }

    @Test func storageFailurePropagatesAndAllowsRetry() async throws {
        let provider = FakeCaptureProvider()
        let store = MemoryScreenshotStore()
        await store.setFailure(true)
        let backend = ScreenshotBackend(provider: provider, store: store)
        let failed = try #require(try backend.captureFocusedWindow())
        await #expect(throws: TestFailure.storage) { try await failed.value }
        #expect(!backend.isCapturing)

        await store.setFailure(false)
        let retry = try #require(try backend.captureFocusedWindow())
        _ = try await retry.value
        #expect(await store.screenshots.count == 1)
    }

    @Test func cancellationBeforeCaptureDoesNotWriteAndReleasesSlot() async throws {
        let provider = FakeCaptureProvider()
        let store = MemoryScreenshotStore()
        let backend = ScreenshotBackend(provider: provider, store: store)
        let operation = try #require(try backend.captureFocusedWindow())
        operation.cancel()
        await #expect(throws: CancellationError.self) { try await operation.value }
        #expect(!backend.isCapturing)
        #expect(provider.capturedIDs.isEmpty)
        #expect(await store.screenshots.isEmpty)
    }
}
