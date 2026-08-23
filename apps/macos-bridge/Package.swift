// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodexPulseBridge",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "CodexPulseBridgeCore", targets: ["CodexPulseBridgeCore"]),
        .executable(name: "codex-pulse-bridge", targets: ["CodexPulseBridge"]),
        .executable(name: "codex-pulse-bridge-self-test", targets: ["CodexPulseBridgeSelfTest"])
    ],
    targets: [
        .target(
            name: "CodexPulseBridgeCore",
            path: "Sources/CodexPulseBridgeCore"
        ),
        .executableTarget(
            name: "CodexPulseBridge",
            dependencies: ["CodexPulseBridgeCore"],
            path: "Sources/CodexPulseBridge"
        ),
        .executableTarget(
            name: "CodexPulseBridgeSelfTest",
            dependencies: ["CodexPulseBridgeCore"],
            path: "Sources/CodexPulseBridgeSelfTest"
        ),
        .testTarget(
            name: "CodexPulseBridgeCoreTests",
            dependencies: ["CodexPulseBridgeCore"],
            path: "Tests/CodexPulseBridgeCoreTests"
        )
    ],
    swiftLanguageModes: [.v5]
)
