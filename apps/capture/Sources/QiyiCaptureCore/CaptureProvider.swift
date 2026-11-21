import Foundation

/// The native handle is owned by the platform adapter; the backend never
/// inspects AXUIElement, HWND, X11 window IDs, or other OS-specific types.
public struct FocusedWindowTarget<Handle> {
    public let handle: Handle
    public let appName: String

    public init(handle: Handle, appName: String) {
        self.handle = handle
        self.appName = appName
    }
}

@MainActor
public protocol WindowCaptureProvider {
    associatedtype WindowHandle

    /// Pin the focused window synchronously at the trigger, before any await.
    /// Throw if permissions or window identity cannot be established.
    func focusedWindow() throws -> FocusedWindowTarget<WindowHandle>

    /// Capture the pinned window as a complete PNG, without writing files or
    /// showing UI. A later focus change must not change the capture target.
    func capturePNG(_ window: WindowHandle) async throws -> Data
}

public struct Screenshot: Sendable {
    public let pngData: Data
    public let appName: String
    public let capturedAt: Date

    public init(pngData: Data, appName: String, capturedAt: Date) {
        self.pngData = pngData
        self.appName = appName
        self.capturedAt = capturedAt
    }
}

public struct ScreenshotReceipt: Codable, Sendable {
    public let fileURL: URL
    public let appName: String
    public let capturedAt: Date
    public let byteCount: Int

    public init(fileURL: URL, appName: String, capturedAt: Date, byteCount: Int) {
        self.fileURL = fileURL
        self.appName = appName
        self.capturedAt = capturedAt
        self.byteCount = byteCount
    }
}

public protocol ScreenshotStore: Sendable {
    func save(_ screenshot: Screenshot) async throws -> ScreenshotReceipt
}
