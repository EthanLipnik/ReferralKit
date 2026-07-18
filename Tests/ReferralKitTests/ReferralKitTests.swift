//
//  ReferralKitTests.swift
//  ReferralKit
//
//  Created by Ethan Lipnik on 7/13/26.
//

import CryptoKit
import Foundation
import Testing
@testable import ReferralKit

@Suite("ReferralKit")
@MainActor
struct ReferralKitTests {
    @Test("Account snapshots decode referral history and remain compatible without it")
    func accountSnapshotHistoryDecoding() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let snapshot = try decoder.decode(
            ReferralAccountSnapshot.self,
            from: Data(
                """
                {"availableCredits":0,"reservedCredits":1,"pendingRewards":0,"canEarnCredits":true,"isLifetime":false,"share":null,"pendingActivation":{"reservationID":"reservation-1","kind":"promotional_offer","state":"presented","expiresAt":"2026-07-18T03:23:23Z"},"history":[{"id":"referral-1","role":"received","status":"redeemed","code":"DEMO-7K4P","claimedAt":"2026-07-16T10:00:00Z","redeemedAt":"2026-07-16T10:05:00Z"}]}
                """.utf8
            )
        )
        #expect(snapshot.history?.first?.code == "DEMO-7K4P")
        #expect(snapshot.history?.first?.role == .received)
        #expect(snapshot.history?.first?.status == .redeemed)
        #expect(snapshot.pendingActivation?.reservationID == "reservation-1")
        #expect(snapshot.pendingActivation?.kind == .promotionalOffer)
        #expect(snapshot.pendingActivation?.state == .presented)

        let legacySnapshot = try decoder.decode(
            ReferralAccountSnapshot.self,
            from: Data(
                """
                {"availableCredits":0,"reservedCredits":0,"pendingRewards":0,"canEarnCredits":true,"isLifetime":false,"share":null}
                """.utf8
            )
        )
        #expect(legacySnapshot.history == nil)
        #expect(legacySnapshot.pendingActivation == nil)
    }

    @Test("Codes and public links use application configuration")
    func codeAndLinkParsing() throws {
        let configuration = try testConfiguration()
        #expect(configuration.normalizedCode("demo-7k4p-q9tx") == "DEMO7K4PQ9TX")
        #expect(configuration.normalizedCode("short") == nil)
        #expect(configuration.referralCode(from: URL(string: "https://example.com/r/demo-7k4p-q9tx")!) == "DEMO7K4PQ9TX")
        #expect(configuration.referralCode(from: URL(string: "https://other.example/r/demo-7k4p-q9tx")!) == nil)
        #expect(configuration.referralCode(from: URL(string: "http://example.com/r/demo-7k4p-q9tx")!) == nil)
    }

    @Test("Manager holds a deep-linked code until redemption")
    func managerHandlesDeepLink() throws {
        let configuration = try testConfiguration()
        let manager = ReferralManager(
            api: ReferralAPIMock(),
            configuration: configuration,
            identityProvider: { nil },
            defaults: isolatedDefaults()
        )
        #expect(manager.handle(url: URL(string: "https://example.com/r/demo-7k4p-q9tx")!))
        #expect(manager.pendingCode == "DEMO7K4PQ9TX")
    }

    @Test("Concurrent requests share one device registration")
    func concurrentRequestsShareRegistration() async throws {
        var configuration = try testConfiguration()
        configuration.registrationRetryDelays = [.zero]
        let transport = ReferralHTTPTransportMock()
        let synchronizer = ReferralChallengeSynchronizerMock()
        let client = ReferralAPIClient(
            configuration: configuration,
            transport: transport,
            signer: ReferralRequestSignerMock(),
            challengeSynchronizer: synchronizer,
            registrationCoordinator: ReferralRegistrationCoordinator()
        )
        let identity = ReferralIdentity(customerID: "customer-referral-test", source: "test")

        async let account = client.account(identity: identity)
        await synchronizer.waitUntilStarted()
        async let share = client.createShare(identity: identity)
        await transport.waitForSignedRequestCount(2)
        await synchronizer.release()

        let (snapshot, createdShare) = try await (account, share)
        #expect(snapshot.availableCredits == 0)
        #expect(createdShare.code == "DEMO7K4PQ9TX")
        #expect(await transport.challengeRequestCount == 1)
        #expect(await transport.registrationRequestCount == 1)
        #expect(await synchronizer.synchronizationCount == 1)
    }

    @Test("Registration verification retries reuse one challenge")
    func registrationRetriesReuseChallenge() async throws {
        var configuration = try testConfiguration()
        configuration.registrationRetryDelays = [.zero, .zero, .zero]
        let transport = ReferralHTTPTransportMock(pendingRegistrationResponses: 2)
        let synchronizer = ReferralChallengeSynchronizerMock(startsBlocked: false)
        let client = ReferralAPIClient(
            configuration: configuration,
            transport: transport,
            signer: ReferralRequestSignerMock(),
            challengeSynchronizer: synchronizer,
            registrationCoordinator: ReferralRegistrationCoordinator()
        )

        _ = try await client.account(identity: ReferralIdentity(customerID: "customer-retry-test", source: "test"))

        #expect(await transport.challengeRequestCount == 1)
        #expect(await transport.registrationRequestCount == 3)
        #expect(await synchronizer.synchronizationCount == 1)
    }

    @Test("Signed headers and canonical input are configurable and deterministic")
    func signedRequestContract() async throws {
        let transport = CapturingTransport()
        let signer = CapturingSigner()
        let client = ReferralAPIClient(
            configuration: try testConfiguration(),
            transport: transport,
            signer: signer,
            challengeSynchronizer: ReferralChallengeSynchronizerMock(startsBlocked: false),
            now: { Date(timeIntervalSince1970: 1_700_000_000) },
            makeNonce: { "fixed_nonce_123456" }
        )

        _ = try await client.account(identity: ReferralIdentity(customerID: "customer-12345678", source: "test"))

        let request = try #require(await transport.request)
        #expect(request.value(forHTTPHeaderField: "X-Demo-Identity") == "customer-12345678")
        #expect(request.value(forHTTPHeaderField: "X-Demo-Timestamp") == "1700000000")
        #expect(request.value(forHTTPHeaderField: "X-Demo-Nonce") == "fixed_nonce_123456")
        let input = try #require(signer.input)
        #expect(input.method == "GET")
        #expect(input.path == "/v1/account")
        #expect(input.body.isEmpty)
        #expect(input.timestamp == 1_700_000_000)
        #expect(input.nonce == "fixed_nonce_123456")
    }

    @Test("Claim registration retry preserves operation ID and rotates signature nonce")
    func claimRegistrationRetryPreservesOperationID() async throws {
        let transport = ClaimRegistrationRetryTransport()
        let nonces = NonceSequence(values: ["claim_nonce_first", "claim_nonce_retry"])
        let client = ReferralAPIClient(
            configuration: try testConfiguration(),
            transport: transport,
            signer: ReferralRequestSignerMock(),
            challengeSynchronizer: ReferralChallengeSynchronizerMock(startsBlocked: false),
            registrationCoordinator: ReferralRegistrationCoordinator(),
            makeNonce: { nonces.next() }
        )

        let fulfillment = try await client.claim(
            code: "DEMO7K4PQ9TX",
            identity: ReferralIdentity(customerID: "customer-operation-retry", source: "test")
        )

        #expect(fulfillment.reservationID == "reservation-1")
        let requests = await transport.claimRequests
        #expect(requests.count == 2)
        #expect(requests.map(\.nonce) == ["claim_nonce_first", "claim_nonce_retry"])
        let firstOperationID = try #require(requests.first?.operationID)
        #expect(!firstOperationID.isEmpty)
        #expect(requests.last?.operationID == firstOperationID)
        #expect(firstOperationID != requests.first?.nonce)
    }

    @Test("Separate logical claims receive unique operation IDs")
    func separateClaimsReceiveUniqueOperationIDs() async throws {
        let transport = SuccessfulClaimCapturingTransport()
        let client = ReferralAPIClient(
            configuration: try testConfiguration(),
            transport: transport,
            signer: ReferralRequestSignerMock(),
            challengeSynchronizer: ReferralChallengeSynchronizerMock(startsBlocked: false)
        )
        let identity = ReferralIdentity(customerID: "customer-operation-unique", source: "test")

        _ = try await client.claim(code: "DEMO7K4PQ9TX", identity: identity)
        _ = try await client.claim(code: "DEMO7K4PQ9TX", identity: identity)

        let operationIDs = await transport.operationIDs
        #expect(operationIDs.count == 2)
        #expect(operationIDs.allSatisfy { !$0.isEmpty })
        #expect(Set(operationIDs).count == 2)
    }

    @Test("Pending redemptions resume through the dedicated endpoint")
    func resumePendingRedemption() async throws {
        let transport = ResumeRedemptionTransport()
        let client = ReferralAPIClient(
            configuration: try testConfiguration(),
            transport: transport,
            signer: ReferralRequestSignerMock(),
            challengeSynchronizer: ReferralChallengeSynchronizerMock(startsBlocked: false)
        )

        let fulfillment = try await client.resumeRedemption(
            reservationID: "reservation-1",
            identity: ReferralIdentity(customerID: "customer-resume", source: "test")
        )

        #expect(fulfillment.reservationID == "reservation-1")
        #expect(await transport.requestPath == "/v1/redemptions/resume")
        #expect(await transport.reservationID == "reservation-1")
    }

    @Test("Lost mutation response retries the same operation with a fresh signature nonce")
    func lostMutationResponseRetriesStableOperation() async throws {
        let transport = LostResponseClaimTransport()
        let nonces = NonceSequence(values: ["lost_response_first", "lost_response_retry"])
        let client = ReferralAPIClient(
            configuration: try testConfiguration(),
            transport: transport,
            signer: ReferralRequestSignerMock(),
            challengeSynchronizer: ReferralChallengeSynchronizerMock(startsBlocked: false),
            makeNonce: { nonces.next() }
        )

        let fulfillment = try await client.claim(
            code: "DEMO7K4PQ9TX",
            identity: ReferralIdentity(customerID: "customer-lost-response", source: "test")
        )

        #expect(fulfillment.reservationID == "reservation-lost-response")
        let requests = await transport.requests
        #expect(requests.count == 2)
        #expect(requests[0].operationID == requests[1].operationID)
        #expect(requests[0].body == requests[1].body)
        #expect(requests.map(\.nonce) == ["lost_response_first", "lost_response_retry"])
    }

    @Test("Expired manager snapshots are not restored")
    func cacheExpiry() async throws {
        let defaults = isolatedDefaults()
        let start = Date(timeIntervalSince1970: 10_000)
        var configuration = try testConfiguration()
        configuration.snapshotCacheLifetime = 60
        let api = ReferralAPIMock()
        let first = ReferralManager(
            api: api,
            configuration: configuration,
            identityProvider: { ReferralIdentity(customerID: "customer", source: "test") },
            defaults: defaults,
            now: { start }
        )
        await first.refresh()
        #expect(first.snapshot != nil)

        let restored = ReferralManager(
            api: api,
            configuration: configuration,
            identityProvider: { nil },
            defaults: defaults,
            now: { start.addingTimeInterval(61) }
        )
        #expect(restored.snapshot == nil)
    }

    private func testConfiguration() throws -> ReferralConfiguration {
        ReferralConfiguration(
            baseURL: try #require(URL(string: "https://api.example.com")),
            publicReferralHost: "example.com",
            headers: .init(
                identity: "X-Demo-Identity",
                timestamp: "X-Demo-Timestamp",
                nonce: "X-Demo-Nonce",
                signature: "X-Demo-Signature"
            ),
            keychainService: "com.example.ReferralKitTests",
            snapshotCacheKey: "com.example.ReferralKitTests.snapshot"
        )
    }

    private func isolatedDefaults() -> UserDefaults {
        let suite = "ReferralKitTests.\(UUID().uuidString)"
        return UserDefaults(suiteName: suite)!
    }
}

private enum ReferralTestError: Error {
    case invalidResponse
}

private struct ReferralRequestSignerMock: ReferralRequestSigning {
    func publicKey() throws -> Data { Data([1, 2, 3]) }

    func signature(method _: String, path _: String, body _: Data, timestamp _: Int, nonce _: String) throws -> Data {
        Data([4, 5, 6])
    }
}

private final class CapturingSigner: ReferralRequestSigning, @unchecked Sendable {
    struct Input: Sendable {
        var method: String
        var path: String
        var body: Data
        var timestamp: Int
        var nonce: String
    }

    private let lock = NSLock()
    private var storedInput: Input?

    var input: Input? {
        lock.withLock { storedInput }
    }

    func publicKey() throws -> Data { Data([1, 2, 3]) }

    func signature(method: String, path: String, body: Data, timestamp: Int, nonce: String) throws -> Data {
        lock.withLock {
            storedInput = Input(method: method, path: path, body: body, timestamp: timestamp, nonce: nonce)
        }
        return Data([4, 5, 6])
    }
}

private actor CapturingTransport: ReferralHTTPTransport {
    private(set) var request: URLRequest?

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        self.request = request
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
            throw ReferralTestError.invalidResponse
        }
        return (Data("{\"availableCredits\":0,\"reservedCredits\":0,\"pendingRewards\":0,\"canEarnCredits\":true,\"isLifetime\":false,\"share\":null}".utf8), response)
    }
}

private final class NonceSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String]

    init(values: [String]) {
        self.values = values
    }

    func next() -> String {
        lock.withLock {
            values.isEmpty ? UUID().uuidString.lowercased() : values.removeFirst()
        }
    }
}

private actor ClaimRegistrationRetryTransport: ReferralHTTPTransport {
    struct CapturedClaim: Sendable {
        var operationID: String?
        var nonce: String?
    }

    private(set) var claimRequests: [CapturedClaim] = []
    private var isRegistered = false

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        guard let url = request.url else { throw ReferralTestError.invalidResponse }
        switch url.path {
        case "/v1/referrals/claim":
            claimRequests.append(CapturedClaim(
                operationID: request.value(forHTTPHeaderField: "Idempotency-Key"),
                nonce: request.value(forHTTPHeaderField: "X-Demo-Nonce")
            ))
            guard isRegistered else {
                return try response(url: url, status: 401, body: "{}")
            }
            return try response(url: url, status: 201, body: Self.fulfillmentBody)
        case "/v1/devices/registration-challenges":
            return try response(
                url: url,
                status: 201,
                body: "{\"challengeID\":\"challenge-1\",\"attributeKey\":\"referral_registration_challenge\",\"attributeValue\":\"value-1\"}"
            )
        case "/v1/devices/register":
            isRegistered = true
            return try response(url: url, status: 201, body: "{}")
        default:
            throw ReferralTestError.invalidResponse
        }
    }

    private func response(url: URL, status: Int, body: String) throws -> (Data, URLResponse) {
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ) else {
            throw ReferralTestError.invalidResponse
        }
        return (Data(body.utf8), response)
    }

    private static let fulfillmentBody = """
    {"reservationID":"reservation-1","kind":"offer_code","offerCode":"TEST-CODE","offerURL":"https://apps.apple.com/redeem?code=TEST-CODE","productIdentifier":"example_pro_monthly","freeMonths":1,"expiresAt":"2030-01-01T00:00:00Z"}
    """
}

private actor SuccessfulClaimCapturingTransport: ReferralHTTPTransport {
    private(set) var operationIDs: [String] = []

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        guard let url = request.url, url.path == "/v1/referrals/claim" else {
            throw ReferralTestError.invalidResponse
        }
        operationIDs.append(request.value(forHTTPHeaderField: "Idempotency-Key") ?? "")
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: 201,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ) else {
            throw ReferralTestError.invalidResponse
        }
        let body = """
        {"reservationID":"reservation-1","kind":"offer_code","offerCode":"TEST-CODE","offerURL":"https://apps.apple.com/redeem?code=TEST-CODE","productIdentifier":"example_pro_monthly","freeMonths":1,"expiresAt":"2030-01-01T00:00:00Z"}
        """
        return (Data(body.utf8), response)
    }
}

private actor ResumeRedemptionTransport: ReferralHTTPTransport {
    private(set) var requestPath: String?
    private(set) var reservationID: String?

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        guard let url = request.url else { throw ReferralTestError.invalidResponse }
        requestPath = url.path
        if let body = request.httpBody,
           let value = try? JSONSerialization.jsonObject(with: body) as? [String: String] {
            reservationID = value["reservationID"]
        }
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ) else {
            throw ReferralTestError.invalidResponse
        }
        let body = """
        {"reservationID":"reservation-1","kind":"offer_code","offerCode":"TEST-CODE","offerURL":"https://apps.apple.com/redeem?code=TEST-CODE","productIdentifier":"example_pro_monthly","freeMonths":1,"expiresAt":"2030-01-01T00:00:00Z"}
        """
        return (Data(body.utf8), response)
    }
}

private actor LostResponseClaimTransport: ReferralHTTPTransport {
    struct CapturedRequest: Sendable {
        var operationID: String?
        var nonce: String?
        var body: Data?
    }

    private(set) var requests: [CapturedRequest] = []

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        guard let url = request.url, url.path == "/v1/referrals/claim" else {
            throw ReferralTestError.invalidResponse
        }
        requests.append(CapturedRequest(
            operationID: request.value(forHTTPHeaderField: "Idempotency-Key"),
            nonce: request.value(forHTTPHeaderField: "X-Demo-Nonce"),
            body: request.httpBody
        ))
        if requests.count == 1 {
            throw URLError(.networkConnectionLost)
        }
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: 201,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ) else {
            throw ReferralTestError.invalidResponse
        }
        let body = """
        {"reservationID":"reservation-lost-response","kind":"offer_code","offerCode":"TEST-CODE","offerURL":"https://apps.apple.com/redeem?code=TEST-CODE","productIdentifier":"example_pro_monthly","freeMonths":1,"expiresAt":"2030-01-01T00:00:00Z"}
        """
        return (Data(body.utf8), response)
    }
}

private actor ReferralChallengeSynchronizerMock: ReferralChallengeSynchronizing {
    private let startsBlocked: Bool
    private var continuation: CheckedContinuation<Void, Never>?
    private var didStart = false
    private(set) var synchronizationCount = 0

    init(startsBlocked: Bool = true) {
        self.startsBlocked = startsBlocked
    }

    func setAndSynchronize(key _: String, value _: String) async throws {
        synchronizationCount += 1
        didStart = true
        guard startsBlocked else { return }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func waitUntilStarted() async {
        while !didStart {
            await Task.yield()
        }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private actor ReferralHTTPTransportMock: ReferralHTTPTransport {
    private var isRegistered = false
    private var signedRequestCount = 0
    private var remainingPendingRegistrationResponses: Int
    private(set) var challengeRequestCount = 0
    private(set) var registrationRequestCount = 0

    init(pendingRegistrationResponses: Int = 0) {
        remainingPendingRegistrationResponses = pendingRegistrationResponses
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        guard let url = request.url else { throw ReferralTestError.invalidResponse }
        switch url.path {
        case "/v1/devices/registration-challenges":
            challengeRequestCount += 1
            return try response(
                url: url,
                status: 200,
                body: "{\"challengeID\":\"challenge-1\",\"attributeKey\":\"referral_registration_challenge\",\"attributeValue\":\"value-1\"}"
            )
        case "/v1/devices/register":
            registrationRequestCount += 1
            if remainingPendingRegistrationResponses > 0 {
                remainingPendingRegistrationResponses -= 1
                return try response(
                    url: url,
                    status: 409,
                    body: "{\"error\":{\"code\":\"unverified_registration_challenge\"}}"
                )
            }
            isRegistered = true
            return try response(url: url, status: 200, body: "{}")
        case "/v1/account":
            signedRequestCount += 1
            guard isRegistered else { return try response(url: url, status: 401, body: "{}") }
            return try response(
                url: url,
                status: 200,
                body: "{\"availableCredits\":0,\"reservedCredits\":0,\"pendingRewards\":0,\"canEarnCredits\":true,\"isLifetime\":false,\"share\":null}"
            )
        case "/v1/codes":
            signedRequestCount += 1
            guard isRegistered else { return try response(url: url, status: 401, body: "{}") }
            return try response(
                url: url,
                status: 200,
                body: "{\"code\":\"DEMO7K4PQ9TX\",\"url\":\"https://example.com/r/DEMO7K4PQ9TX\"}"
            )
        default:
            throw ReferralTestError.invalidResponse
        }
    }

    func waitForSignedRequestCount(_ count: Int) async {
        while signedRequestCount < count {
            await Task.yield()
        }
    }

    private func response(url: URL, status: Int, body: String) throws -> (Data, URLResponse) {
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ) else {
            throw ReferralTestError.invalidResponse
        }
        return (Data(body.utf8), response)
    }
}

@MainActor
private final class ReferralAPIMock: ReferralAPIClientProtocol {
    func account(identity _: ReferralIdentity) async throws -> ReferralAccountSnapshot {
        ReferralAccountSnapshot(
            availableCredits: 0,
            reservedCredits: 0,
            pendingRewards: 0,
            canEarnCredits: true,
            isLifetime: false,
            share: nil
        )
    }

    func createShare(identity _: ReferralIdentity) async throws -> ReferralShare {
        ReferralShare(code: "DEMO7K4PQ9TX", url: URL(string: "https://example.com/r/DEMO7K4PQ9TX")!)
    }

    func claim(code _: String, identity _: ReferralIdentity) async throws -> ReferralFulfillment {
        throw ReferralError.serviceUnavailable
    }

    func redeemCredit(identity _: ReferralIdentity) async throws -> ReferralFulfillment {
        throw ReferralError.serviceUnavailable
    }

    func resumeRedemption(
        reservationID _: String,
        identity _: ReferralIdentity
    ) async throws -> ReferralFulfillment {
        throw ReferralError.serviceUnavailable
    }

    func markPresented(reservationID _: String, identity _: ReferralIdentity) async throws {}
}
