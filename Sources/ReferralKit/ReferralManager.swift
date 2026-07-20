//
//  ReferralManager.swift
//  ReferralKit
//
//  Created by Ethan Lipnik on 7/13/26.
//

import Foundation
import Observation

@Observable
@MainActor
public final class ReferralManager {
    private struct CachedSnapshot: Codable {
        var customerID: String
        var snapshot: ReferralAccountSnapshot
        var storedAt: Date
    }

    private let api: any ReferralAPIClientProtocol
    private let configuration: ReferralConfiguration
    private let identityProvider: @MainActor () -> ReferralIdentity?
    private let defaults: UserDefaults
    private let toolbarHiddenProvider: @MainActor () -> Bool
    private let toolbarHiddenSetter: @MainActor (Bool) -> Void
    private let now: @MainActor () -> Date

    public private(set) var snapshot: ReferralAccountSnapshot?
    public private(set) var isLoading = false
    public private(set) var lastError: ReferralError?
    public var pendingCode: String?

    public var isToolbarHidden: Bool {
        toolbarHiddenProvider()
    }

    public init(
        api: any ReferralAPIClientProtocol,
        configuration: ReferralConfiguration,
        identityProvider: @escaping @MainActor () -> ReferralIdentity?,
        defaults: UserDefaults = .standard,
        toolbarHiddenProvider: @escaping @MainActor () -> Bool = { false },
        toolbarHiddenSetter: @escaping @MainActor (Bool) -> Void = { _ in },
        now: @escaping @MainActor () -> Date = Date.init
    ) {
        self.api = api
        self.configuration = configuration
        self.identityProvider = identityProvider
        self.defaults = defaults
        self.toolbarHiddenProvider = toolbarHiddenProvider
        self.toolbarHiddenSetter = toolbarHiddenSetter
        self.now = now
        snapshot = Self.loadCachedSnapshot(
            defaults: defaults,
            key: configuration.snapshotCacheKey,
            customerID: identityProvider()?.customerID,
            lifetime: configuration.snapshotCacheLifetime,
            now: now()
        )
    }

    public func refresh() async {
        guard !isLoading else { return }
        guard let identity = identityProvider() else {
            lastError = .identityUnavailable
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let next = try await api.account(identity: identity)
            updateSnapshot(next)
            lastError = nil
        } catch {
            lastError = Self.referralError(error)
        }
    }

    public func createShareLink() async throws -> ReferralShare {
        let identity = try requireIdentity()
        do {
            let share = try await api.createShare(identity: identity)
            if var current = snapshot {
                current.share = share
                updateSnapshot(current)
            }
            lastError = nil
            return share
        } catch {
            let referralError = Self.referralError(error)
            lastError = referralError
            throw referralError
        }
    }

    public func claim(code: String) async throws -> ReferralFulfillment {
        guard let normalizedCode = configuration.normalizedCode(code) else {
            throw ReferralError.invalidCode
        }
        let identity = try requireIdentity()
        do {
            let fulfillment = try await api.claim(code: normalizedCode, identity: identity)
            pendingCode = nil
            lastError = nil
            await refresh()
            return fulfillment
        } catch {
            let referralError = Self.referralError(error)
            lastError = referralError
            throw referralError
        }
    }

    public func redeemCredit() async throws -> ReferralFulfillment {
        let identity = try requireIdentity()
        do {
            let fulfillment = try await api.redeemCredit(identity: identity)
            lastError = nil
            await refresh()
            return fulfillment
        } catch {
            let referralError = Self.referralError(error)
            lastError = referralError
            throw referralError
        }
    }

    public func markPresented(reservationID: String) async throws {
        let identity = try requireIdentity()
        do {
            try await api.markPresented(reservationID: reservationID, identity: identity)
            lastError = nil
            await refresh()
        } catch {
            let referralError = Self.referralError(error)
            lastError = referralError
            throw referralError
        }
    }

    public func resumeRedemption(reservationID: String) async throws -> ReferralFulfillment {
        let identity = try requireIdentity()
        do {
            let fulfillment = try await api.resumeRedemption(
                reservationID: reservationID,
                identity: identity
            )
            lastError = nil
            return fulfillment
        } catch {
            let referralError = Self.referralError(error)
            lastError = referralError
            throw referralError
        }
    }

    @discardableResult
    public func handle(url: URL) -> Bool {
        guard let code = configuration.referralCode(from: url) else { return false }
        pendingCode = code
        return true
    }

    public func setToolbarHidden(_ hidden: Bool) {
        toolbarHiddenSetter(hidden)
    }

    private func requireIdentity() throws -> ReferralIdentity {
        guard let identity = identityProvider() else { throw ReferralError.identityUnavailable }
        return identity
    }

    private func updateSnapshot(_ next: ReferralAccountSnapshot) {
        snapshot = next
        guard let customerID = identityProvider()?.customerID else { return }
        let cached = CachedSnapshot(customerID: customerID, snapshot: next, storedAt: now())
        if let data = try? JSONEncoder().encode(cached) {
            defaults.set(data, forKey: configuration.snapshotCacheKey)
        }
    }

    private static func loadCachedSnapshot(
        defaults: UserDefaults,
        key: String,
        customerID: String?,
        lifetime: TimeInterval,
        now: Date
    ) -> ReferralAccountSnapshot? {
        guard let customerID,
              let data = defaults.data(forKey: key),
              let cached = try? JSONDecoder().decode(CachedSnapshot.self, from: data),
              cached.customerID == customerID,
              now.timeIntervalSince(cached.storedAt) <= lifetime else { return nil }
        return cached.snapshot
    }

    private static func referralError(_ error: Error) -> ReferralError {
        if let error = error as? ReferralError { return error }
        return .serviceUnavailable
    }
}
