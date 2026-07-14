//
//  ReferralRequestSigner.swift
//  ReferralKit
//
//  Created by Ethan Lipnik on 7/13/26.
//

import CryptoKit
import Foundation
import Security

public protocol ReferralRequestSigning: Sendable {
    func publicKey() throws -> Data
    func signature(method: String, path: String, body: Data, timestamp: Int, nonce: String) throws -> Data
}

public struct ReferralRequestSigner: ReferralRequestSigning, @unchecked Sendable {
    private let service: String
    private let account: String

    public init(service: String, account: String = "p256-v1") {
        self.service = service
        self.account = account
    }

    public func publicKey() throws -> Data {
        try privateKey().publicKey.x963Representation
    }

    public func signature(method: String, path: String, body: Data, timestamp: Int, nonce: String) throws -> Data {
        let bodyHash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        let canonical = [method.uppercased(), path, bodyHash, String(timestamp), nonce].joined(separator: "\n")
        return try privateKey().signature(for: Data(canonical.utf8)).derRepresentation
    }

    private func privateKey() throws -> P256.Signing.PrivateKey {
        if let data = loadKey() {
            return try P256.Signing.PrivateKey(rawRepresentation: data)
        }
        let key = P256.Signing.PrivateKey()
        guard saveKey(key.rawRepresentation) else {
            throw ReferralError.identityUnavailable
        }
        return key
    }

    private func loadKey() -> Data? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    private func saveKey(_ data: Data) -> Bool {
        var query = baseQuery()
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        return status == errSecSuccess || status == errSecDuplicateItem
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
