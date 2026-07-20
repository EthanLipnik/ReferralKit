//
//  ReferralConfiguration.swift
//  ReferralKit
//
//  Created by Ethan Lipnik on 7/13/26.
//

import Foundation

public struct ReferralConfiguration: Sendable {
    public struct HeaderNames: Sendable {
        public var identity: String
        public var timestamp: String
        public var nonce: String
        public var signature: String

        public init(
            identity: String = "X-Referral-Identity",
            timestamp: String = "X-Referral-Timestamp",
            nonce: String = "X-Referral-Nonce",
            signature: String = "X-Referral-Signature"
        ) {
            self.identity = identity
            self.timestamp = timestamp
            self.nonce = nonce
            self.signature = signature
        }
    }

    public var baseURL: URL
    public var publicReferralHost: String
    public var additionalPublicReferralHosts: Set<String>
    public var referralPathComponent: String
    public var codeLengthRange: ClosedRange<Int>
    public var headers: HeaderNames
    public var keychainService: String
    public var keychainAccount: String
    public var snapshotCacheKey: String
    public var snapshotCacheLifetime: TimeInterval
    public var registrationRetryDelays: [Duration]

    public init(
        baseURL: URL,
        publicReferralHost: String,
        additionalPublicReferralHosts: Set<String> = [],
        referralPathComponent: String = "r",
        codeLengthRange: ClosedRange<Int> = 8 ... 24,
        headers: HeaderNames = HeaderNames(),
        keychainService: String,
        keychainAccount: String = "p256-v1",
        snapshotCacheKey: String,
        snapshotCacheLifetime: TimeInterval = 15 * 60,
        registrationRetryDelays: [Duration] = [
            .zero,
            .milliseconds(500),
            .seconds(1),
            .seconds(2),
            .seconds(4),
            .seconds(6),
        ]
    ) {
        self.baseURL = baseURL
        self.publicReferralHost = publicReferralHost.lowercased()
        self.additionalPublicReferralHosts = Set(additionalPublicReferralHosts.map { $0.lowercased() })
        self.referralPathComponent = referralPathComponent
        self.codeLengthRange = codeLengthRange
        self.headers = headers
        self.keychainService = keychainService
        self.keychainAccount = keychainAccount
        self.snapshotCacheKey = snapshotCacheKey
        self.snapshotCacheLifetime = snapshotCacheLifetime
        self.registrationRetryDelays = registrationRetryDelays
    }

    public func normalizedCode(_ value: String) -> String? {
        let characters = value.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        guard codeLengthRange.contains(characters.count) else { return nil }
        return String(characters)
    }

    public func referralCode(from url: URL) -> String? {
        let allowedHosts = additionalPublicReferralHosts.union([publicReferralHost])
        guard url.scheme?.lowercased() == "https",
              url.host.map({ allowedHosts.contains($0.lowercased()) }) == true else { return nil }
        let components = url.pathComponents.filter { $0 != "/" }
        guard components.count == 2,
              components[0].lowercased() == referralPathComponent.lowercased() else { return nil }
        return normalizedCode(components[1])
    }
}
