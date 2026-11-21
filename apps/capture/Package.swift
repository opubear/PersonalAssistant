// swift-tools-version: 5.9
import PackageDescription

var products: [Product] = [
    .library(name: "QiyiCaptureCore", targets: ["QiyiCaptureCore"]),
    .library(name: "QiyiAgents", targets: ["QiyiAgents"]),
    .library(name: "QiyiKnowledge", targets: ["QiyiKnowledge"]),
    .executable(name: "qiyi-capture-service", targets: ["QiyiCaptureService"]),
]

var serviceDependencies: [Target.Dependency] = ["QiyiCaptureCore", "QiyiAgents", "QiyiKnowledge"]
#if os(macOS)
serviceDependencies.append("QiyiMacOS")
#endif
var targets: [Target] = [
    .target(name: "QiyiCaptureCore"),
    .testTarget(name: "QiyiCaptureCoreTests", dependencies: ["QiyiCaptureCore"]),
    .target(name: "QiyiAgents", dependencies: ["QiyiCaptureCore"]),
    .testTarget(name: "QiyiAgentsTests", dependencies: ["QiyiAgents"]),
    .target(name: "QiyiKnowledge", dependencies: ["QiyiAgents", "QiyiCaptureCore"]),
    .testTarget(name: "QiyiKnowledgeTests", dependencies: ["QiyiKnowledge"]),
    .executableTarget(name: "QiyiCaptureService", dependencies: serviceDependencies),
]

// Non-macOS hosts build the portable service and its tests. Native
// frameworks must never enter the Linux/Windows dependency graph.
#if os(macOS)
products += [
    .library(name: "QiyiMacOS", targets: ["QiyiMacOS"]),
    .executable(name: "qiyi-capture-cli", targets: ["QiyiCaptureCLI"]),
]
targets += [
    .target(name: "QiyiMacOS", dependencies: ["QiyiCaptureCore"]),
    .executableTarget(name: "QiyiCaptureCLI", dependencies: ["QiyiCaptureCore", "QiyiMacOS"]),
    .testTarget(name: "QiyiMacOSTests", dependencies: ["QiyiMacOS"]),
]
#endif

let package = Package(
    name: "QiyiCapture",
    platforms: [.macOS(.v14)],
    products: products,
    targets: targets
)
