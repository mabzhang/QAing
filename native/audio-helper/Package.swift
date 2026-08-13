// swift-tools-version: 6.0
import PackageDescription
import Foundation

let packageDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let embeddedInfoPlist = packageDirectory
    .appendingPathComponent("Sources/QAingAudioHelper/Info.plist")
    .path

let package = Package(
    name: "QAingAudioHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "qaing-audio-helper", targets: ["QAingAudioHelper"]),
        .executable(name: "audio-helper-core-checks", targets: ["AudioHelperCoreChecks"]),
        .library(name: "AudioHelperCore", targets: ["AudioHelperCore"]),
    ],
    targets: [
        .target(name: "AudioHelperCore"),
        .executableTarget(
            name: "QAingAudioHelper",
            dependencies: ["AudioHelperCore"],
            exclude: ["Info.plist"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("ScreenCaptureKit"),
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", embeddedInfoPlist]),
            ]
        ),
        .executableTarget(name: "AudioHelperCoreChecks", dependencies: ["AudioHelperCore"]),
    ],
    swiftLanguageModes: [.v5]
)
