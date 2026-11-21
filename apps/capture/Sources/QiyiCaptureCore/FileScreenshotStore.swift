import Foundation

public enum ScreenshotStoreError: LocalizedError {
    case emptyImage
    case nonFileDirectory

    public var errorDescription: String? {
        switch self {
        case .emptyImage: return "截图结果为空，未写入文件。"
        case .nonFileDirectory: return "截图保存位置必须是本地文件夹。"
        }
    }
}

public actor FileScreenshotStore: ScreenshotStore {
    public nonisolated let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    public func save(_ screenshot: Screenshot) async throws -> ScreenshotReceipt {
        try Task.checkCancellation()
        guard directory.isFileURL else { throw ScreenshotStoreError.nonFileDirectory }
        guard !screenshot.pngData.isEmpty else { throw ScreenshotStoreError.emptyImage }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(ScreenshotFile.name(
            appName: screenshot.appName, date: screenshot.capturedAt
        ))
        try Task.checkCancellation()
        // Publish only the complete PNG. Once committed, return its receipt
        // even if the caller cancels immediately after the atomic write.
        try screenshot.pngData.write(to: url, options: .atomic)
        return ScreenshotReceipt(
            fileURL: url, appName: screenshot.appName,
            capturedAt: screenshot.capturedAt, byteCount: screenshot.pngData.count
        )
    }
}
