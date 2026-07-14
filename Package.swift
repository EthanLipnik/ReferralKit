// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "ReferralKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
        .visionOS(.v2),
    ],
    products: [
        .library(name: "ReferralKit", targets: ["ReferralKit"]),
    ],
    targets: [
        .target(name: "ReferralKit"),
        .testTarget(name: "ReferralKitTests", dependencies: ["ReferralKit"]),
    ],
    swiftLanguageModes: [.v6]
)
