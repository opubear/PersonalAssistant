import Foundation
import Testing
@testable import QiyiAgents

@MainActor
struct JSONLineProcessTests {
    #if !os(Windows)
    @Test func realChildHandlesFragmentedUnicodeRecordsAndDrainsStderr() async throws {
        let process = JSONLineProcess()
        let connection = AgentConnection(transport: process)
        var configuration = AgentConfiguration(provider: .pi)
        configuration.executable = "/usr/bin/python3"
        configuration.arguments = ["-u", "-c", #"""
import sys,json
for line in sys.stdin.buffer:
    r=json.loads(line)
    sys.stderr.write('diagnostic\n'*20000)
    sys.stderr.flush()
    output=(json.dumps({'id':r['id'],'result':{'text':'你好\u2028世界'}},ensure_ascii=False)+'\r\n').encode()
    sys.stdout.buffer.write(output[:9]);sys.stdout.buffer.flush()
    sys.stdout.buffer.write(output[9:]);sys.stdout.buffer.flush()
"""#]
        try connection.start(configuration: configuration, directory: FileManager.default.temporaryDirectory)
        defer { connection.stop() }
        for _ in 0..<2 {
            let reply = try await connection.rpc("test", [:], timeout: 5)
            #expect(reply["text"] as? String == "你好\u{2028}世界")
        }
    }

    @Test func closedAgentInputFailsWithoutCrashingHost() async throws {
        let process = JSONLineProcess()
        let connection = AgentConnection(transport: process)
        var configuration = AgentConfiguration(provider: .pi)
        configuration.executable = "/usr/bin/python3"
        configuration.arguments = ["-u", "-c", #"""
import sys,json,os,time
r=json.loads(sys.stdin.buffer.readline())
os.close(0)
print(json.dumps({'id':r['id'],'result':{}}),flush=True)
time.sleep(10)
"""#]
        try connection.start(configuration: configuration, directory: FileManager.default.temporaryDirectory)
        defer { connection.stop() }
        _ = try await connection.rpc("ready", [:], timeout: 5)
        await #expect(throws: (any Error).self) {
            try await connection.rpc("closed", ["payload": String(repeating: "a", count: 100_000)], timeout: 5)
        }
    }
    #endif

    @Test func missingExecutableFailsClearly() throws {
        let process = JSONLineProcess()
        var configuration = AgentConfiguration()
        configuration.executable = "qiyi-capture-nonexistent-executable-\(UUID())"
        #expect(throws: AgentError.self) {
            try process.start(configuration: configuration, directory: FileManager.default.temporaryDirectory)
        }
    }
}
