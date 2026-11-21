import Foundation
import QiyiCaptureCore
import QiyiMacOS

@main
enum QiyiCaptureCLI {
    private static let usage = """
    用法：
      qiyi-capture-cli capture [--output 文件夹]  截取聚焦窗口，输出 JSON 结果
      qiyi-capture-cli status                    读取权限状态，不申请权限
      qiyi-capture-cli --help

    默认保存到命令行可执行文件所在文件夹。
    """

    @MainActor
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        if args.isEmpty || args == ["--help"] {
            print(usage)
            return
        }
        do {
            if args == ["status"] {
                try printJSON(MacOSPermissions.status())
                return
            }
            guard args == ["capture"]
                || (args.count == 3 && args[0] == "capture" && args[1] == "--output" && !args[2].isEmpty)
            else {
                writeError(usage)
                exit(2)
            }
            let directory = args.count == 3
                ? URL(fileURLWithPath: args[2], isDirectory: true)
                : Bundle.main.executableURL!.deletingLastPathComponent()
            let backend = ScreenshotBackend(
                provider: MacOSCaptureProvider(), store: FileScreenshotStore(directory: directory)
            )
            // A fresh backend has no in-flight operation.
            let operation = try backend.captureFocusedWindow()!
            try printJSON(await operation.value)
        } catch {
            writeError(error.localizedDescription)
            exit(1)
        }
    }

    private static func printJSON<T: Encodable>(_ value: T) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        print(String(decoding: try encoder.encode(value), as: UTF8.self))
    }

    private static func writeError(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}
