import AppKit
import ApplicationServices
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import QiyiCaptureCore

enum CaptureError: LocalizedError {
    case accessibilityPermission
    case screenPermission
    case noFocusedWindow
    case accessibilityRead(String, AXError)
    case invalidWindowGeometry
    case pngEncoding

    var errorDescription: String? {
        switch self {
        case .accessibilityPermission:
            return "缺少辅助功能权限，无法识别聚焦窗口。请在系统设置的隐私与安全性中授权当前运行的应用或终端。"
        case .screenPermission:
            return "缺少屏幕录制权限。请在系统设置的隐私与安全性中授权当前运行的应用或终端，再重新启动。"
        case .noFocusedWindow:
            return "当前应用没有可读取的聚焦窗口。请先点击要截图的窗口。"
        case let .accessibilityRead(attribute, code):
            return "无法读取窗口属性 \(attribute)（系统错误 \(code.rawValue)）。请确认目标应用支持辅助功能。"
        case .invalidWindowGeometry:
            return "聚焦窗口的位置或大小无效，请重新聚焦窗口后重试。"
        case .pngEncoding:
            return "PNG 图片编码失败。"
        }
    }
}

public struct MacOSWindowHandle {
    let element: AXUIElement
    let processID: pid_t
}

@MainActor
public final class MacOSCaptureProvider: WindowCaptureProvider {
    public init() {}

    public func focusedWindow() throws -> FocusedWindowTarget<MacOSWindowHandle> {
        guard AXIsProcessTrusted() else { throw CaptureError.accessibilityPermission }
        guard CGPreflightScreenCaptureAccess() else { throw CaptureError.screenPermission }
        guard let app = NSWorkspace.shared.frontmostApplication else {
            throw CaptureError.noFocusedWindow
        }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 1)
        let value = try attribute(kAXFocusedWindowAttribute, of: application)
        guard CFGetTypeID(value) == AXUIElementGetTypeID() else {
            throw CaptureError.noFocusedWindow
        }
        let window = value as! AXUIElement
        AXUIElementSetMessagingTimeout(window, 1)
        return FocusedWindowTarget(
            handle: MacOSWindowHandle(element: window, processID: app.processIdentifier),
            appName: app.localizedName ?? "Window"
        )
    }

    public func capturePNG(_ focused: MacOSWindowHandle) async throws -> Data {
        let content = try await SCShareableContent.excludingDesktopWindows(
            true, onScreenWindowsOnly: true
        )
        // Keep the AX element captured at keypress, even if focus changes while
        // the asynchronous window list is being fetched.
        let frame = try bounds(of: focused.element)
        let title = (try? attribute(kAXTitleAttribute, of: focused.element)) as? String ?? ""
        let candidates = content.windows.map {
            WindowCandidate(
                id: $0.windowID, processID: $0.owningApplication?.processID ?? -1,
                frame: $0.frame, title: $0.title ?? ""
            )
        }
        let id = try WindowSelection.select(
            processID: focused.processID, frame: frame, title: title, candidates: candidates
        )
        guard let window = content.windows.first(where: { $0.windowID == id }) else {
            throw WindowSelectionError.notFound
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        let size = filter.contentRect.size
        guard scale.isFinite, scale > 0, size.width.isFinite, size.height.isFinite,
              size.width > 0, size.height > 0 else {
            throw CaptureError.invalidWindowGeometry
        }
        config.width = Int((size.width * scale).rounded(.up))
        config.height = Int((size.height * scale).rounded(.up))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.ignoreGlobalClipSingleWindow = true
        config.captureResolution = .best
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: config
        )
        // Native image conversion stays in the adapter; storage receives only
        // portable PNG bytes and never needs CoreGraphics or ImageIO.
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data, UTType.png.identifier as CFString, 1, nil
        ) else { throw CaptureError.pngEncoding }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw CaptureError.pngEncoding }
        return data as Data
    }

    private func attribute(_ name: String, of element: AXUIElement) throws -> CFTypeRef {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        guard result == .success, let value else {
            throw CaptureError.accessibilityRead(name, result)
        }
        return value
    }

    private func bounds(of window: AXUIElement) throws -> CGRect {
        let positionValue = try attribute(kAXPositionAttribute, of: window)
        let sizeValue = try attribute(kAXSizeAttribute, of: window)
        guard CFGetTypeID(positionValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID() else {
            throw CaptureError.invalidWindowGeometry
        }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size),
              position.x.isFinite, position.y.isFinite,
              size.width.isFinite, size.height.isFinite,
              size.width > 0, size.height > 0 else {
            throw CaptureError.invalidWindowGeometry
        }
        return CGRect(origin: position, size: size)
    }
}
