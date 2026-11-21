import Foundation

@MainActor
public final class ScreenshotBackend<Provider: WindowCaptureProvider> {
    private let provider: Provider
    private let store: any ScreenshotStore
    public private(set) var isCapturing = false

    public init(provider: Provider, store: any ScreenshotStore) {
        self.provider = provider
        self.store = store
    }

    /// Start one capture; return nil while another capture/write is in flight.
    /// Returning a Task keeps focus resolution synchronous for hotkey callers
    /// and lets any frontend await or cancel the same operation.
    public func captureFocusedWindow() throws -> Task<ScreenshotReceipt, Error>? {
        guard !isCapturing else { return nil }
        let capturedAt = Date()
        let target = try provider.focusedWindow()
        isCapturing = true

        return Task {
            defer { isCapturing = false }
            try Task.checkCancellation()
            let pngData = try await provider.capturePNG(target.handle)
            try Task.checkCancellation()
            return try await store.save(Screenshot(
                pngData: pngData, appName: target.appName, capturedAt: capturedAt
            ))
        }
    }
}
