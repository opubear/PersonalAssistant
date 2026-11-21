import AppKit
import ApplicationServices

public struct MacOSPermissionStatus: Codable, Sendable {
    public let accessibility: Bool
    public let screenCapture: Bool
}

@MainActor
public enum MacOSPermissions {
    /// Read-only. Checking availability never prompts or opens system settings.
    public static func status() -> MacOSPermissionStatus {
        MacOSPermissionStatus(
            accessibility: AXIsProcessTrusted(), screenCapture: CGPreflightScreenCaptureAccess()
        )
    }

    public static func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
        openSettings("Privacy_Accessibility")
    }

    public static func requestScreenCapture() {
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        openSettings("Privacy_ScreenCapture")
    }

    private static func openSettings(_ pane: String) {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!
        NSWorkspace.shared.open(url)
    }
}
