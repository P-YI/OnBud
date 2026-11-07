// swift-tools-version:6.0
// AFM Spotlight: a Spotlight-style launcher for the local OnBud controller.
// Builds with the Command Line Tools only (no Xcode project): `make app`.
import PackageDescription

let package = Package(
    name: "AFMSpotlight",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "AFMSpotlight", targets: ["AFMSpotlight"]),
        .executable(name: "spotlight-smoke", targets: ["SpotlightSmoke"]),
    ],
    targets: [
        // UI-free logic (backend probing, controller client, SSE, OpenCode config merge), shared with the smoke tool.
        .target(name: "SpotlightCore", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "AFMSpotlight", dependencies: ["SpotlightCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "SpotlightSmoke", dependencies: ["SpotlightCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
