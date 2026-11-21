import Foundation
import CoreGraphics

struct WindowCandidate {
    let id: UInt32
    let processID: Int32
    let frame: CGRect
    let title: String

    init(id: UInt32, processID: Int32, frame: CGRect, title: String) {
        self.id = id
        self.processID = processID
        self.frame = frame
        self.title = title
    }
}

enum WindowSelectionError: LocalizedError, Equatable {
    case notFound
    case ambiguous

    var errorDescription: String? {
        switch self {
        case .notFound:
            return "找不到聚焦窗口对应的可截图窗口。窗口可能已关闭、最小化，或不支持截图。请聚焦一个普通窗口后重试。"
        case .ambiguous:
            return "有多个窗口的位置、大小和标题相同，无法确定截图对象。请移动目标窗口后重试。"
        }
    }
}

enum WindowSelection {
    // AX and ScreenCaptureKit both use global display coordinates. Match the
    // focused AX window, rather than assuming an application's first window
    // is focused. Never fall back to capturing an entire display.
    static func select(
        processID: Int32, frame: CGRect, title: String, candidates: [WindowCandidate]
    ) throws -> UInt32 {
        let matches = candidates.filter {
            $0.processID == processID && sameBounds($0.frame, frame)
        }
        if matches.count == 1 { return matches[0].id }
        if matches.isEmpty { throw WindowSelectionError.notFound }

        let titled = matches.filter { !$0.title.isEmpty && $0.title == title }
        guard titled.count == 1 else { throw WindowSelectionError.ambiguous }
        return titled[0].id
    }

    private static func sameBounds(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        guard lhs.width > 0, lhs.height > 0, rhs.width > 0, rhs.height > 0 else {
            return false
        }
        return abs(lhs.minX - rhs.minX) <= 2
            && abs(lhs.minY - rhs.minY) <= 2
            && abs(lhs.width - rhs.width) <= 2
            && abs(lhs.height - rhs.height) <= 2
    }
}
