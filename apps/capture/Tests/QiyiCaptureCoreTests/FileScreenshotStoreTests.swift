import Foundation
import Testing
@testable import QiyiCaptureCore

struct FileScreenshotStoreTests {
    private let png = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )!

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("qiyi-capture-test-\(UUID())")
    }

    @Test func createsOutputDirectoryAndPreservesBytesWithoutOverwriting() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let output = root.appendingPathComponent("nested/output")
        let store = FileScreenshotStore(directory: output)
        let screenshot = Screenshot(pngData: png, appName: "Editor", capturedAt: Date())
        let first = try await store.save(screenshot)
        let second = try await store.save(screenshot)

        #expect(first.fileURL != second.fileURL)
        #expect(first.fileURL.deletingLastPathComponent().standardizedFileURL == output.standardizedFileURL)
        #expect(try Data(contentsOf: first.fileURL) == png)
        #expect(try Data(contentsOf: second.fileURL) == png)
        #expect(first.byteCount == png.count)
        #expect(first.capturedAt == screenshot.capturedAt)
        #expect(try FileManager.default.contentsOfDirectory(atPath: output.path).count == 2)
    }

    @Test func emptyImageFailsWithoutCreatingFiles() async throws {
        let output = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: output) }
        let store = FileScreenshotStore(directory: output)
        await #expect(throws: ScreenshotStoreError.self) {
            try await store.save(Screenshot(pngData: Data(), appName: "Editor", capturedAt: Date()))
        }
        #expect(!FileManager.default.fileExists(atPath: output.path))
    }

    @Test func invalidOutputPathPropagatesWriteFailure() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("not-a-directory")
        try Data("existing content".utf8).write(to: file)
        let store = FileScreenshotStore(directory: file)
        await #expect(throws: (any Error).self) {
            try await store.save(Screenshot(pngData: png, appName: "Editor", capturedAt: Date()))
        }
        #expect(try String(contentsOf: file, encoding: .utf8) == "existing content")
    }

    @Test func fileNameCannotEscapeDirectoryAndBurstNamesAreUnique() {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let name = ScreenshotFile.name(appName: "../../应用:Editor\n", date: date)
        #expect(!name.contains("/"))
        #expect(!name.contains("\\"))
        #expect(!name.contains(":"))
        #expect(!name.contains("\n"))
        #expect(name.hasSuffix(".png"))
        #expect(name != ScreenshotFile.name(appName: "../../应用:Editor\n", date: date))
    }
}
