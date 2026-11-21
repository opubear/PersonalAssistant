import Foundation
#if os(macOS)
import AppKit
#elseif canImport(Glibc)
import Glibc
#endif

@main
enum ServiceMain {
    @MainActor
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        if args == ["--help"] {
            print("qiyi-capture-service --directory <data directory> [--no-hotkey]\nJSONL requests on stdin; replies/events on stdout.")
            return
        }
        guard args.count >= 2, args[0] == "--directory", !args[1].isEmpty,
              args.count == 2 || (args.count == 3 && args[2] == "--no-hotkey") else {
            FileHandle.standardError.write(Data("用法：qiyi-capture-service --directory <文件夹> [--no-hotkey]\n".utf8))
            exit(2)
        }
        #if !os(Windows)
        // This executable owns its signal policy. A closed UI pipe is normal
        // shutdown, not a reason to crash before stopping child agents.
        signal(SIGPIPE, SIG_IGN)
        #endif
        let directory = URL(fileURLWithPath: args[1], isDirectory: true).standardizedFileURL
        do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        catch { FileHandle.standardError.write(Data(error.localizedDescription.utf8)); exit(1) }
        #if os(macOS)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        #endif
        let writer = DispatchQueue(label: "qiyi-capture.service.stdout")
        let service = SnapService(directory: directory, emit: { record in
            writer.async {
                do {
                    var data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
                    data.append(10)
                    try FileHandle.standardOutput.write(contentsOf: data)
                } catch { /* stdin EOF owns shutdown after a disconnected UI */ }
            }
        }, finish: { exit(0) })
        if !args.contains("--no-hotkey") { service.registerShortcut() }
        DispatchQueue(label: "qiyi-capture.service.stdin").async {
            var buffer = Data()
            while true {
                let data = FileHandle.standardInput.availableData
                if data.isEmpty { break }
                buffer.append(data)
                while let newline = buffer.firstIndex(of: 10) {
                    let line = Data(buffer[..<newline])
                    buffer.removeSubrange(...newline)
                    do {
                        guard let record = try JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                        DispatchQueue.main.async { service.receive(record) }
                    } catch {
                        FileHandle.standardError.write(Data("无效 JSON 请求。\n".utf8))
                    }
                }
                if buffer.count > 2 * 1_024 * 1_024 { break }
            }
            DispatchQueue.main.async { service.shutdown() }
        }
        #if os(macOS)
        withExtendedLifetime(service) { app.run() }
        #else
        dispatchMain()
        #endif
    }
}
