//
//  ReferralAPIClient.swift
//  ReferralKit
//
//  Created by Ethan Lipnik on 7/13/26.
//

import Foundation

public protocol ReferralAPIClientProtocol: Sendable {
    func account(identity: ReferralIdentity) async throws -> ReferralAccountSnapshot
    func createShare(identity: ReferralIdentity) async throws -> ReferralShare
    func claim(code: String, identity: ReferralIdentity) async throws -> ReferralFulfillment
    func redeemCredit(identity: ReferralIdentity) async throws -> ReferralFulfillment
    func resumeRedemption(reservationID: String, identity: ReferralIdentity) async throws -> ReferralFulfillment
    func markPresented(reservationID: String, identity: ReferralIdentity) async throws
    func reportOfferCodeIneligible(reservationID: String, identity: ReferralIdentity) async throws
}

public extension ReferralAPIClientProtocol {
    // A default keeps existing test and integration clients source-compatible while
    // older implementations adopt the new server-backed transition independently.
    func reportOfferCodeIneligible(reservationID _: String, identity _: ReferralIdentity) async throws {
        throw ReferralError.serviceUnavailable
    }
}

public protocol ReferralHTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: ReferralHTTPTransport {}

public protocol ReferralChallengeSynchronizing: Sendable {
    func setAndSynchronize(key: String, value: String) async throws
}

public protocol ReferralLogging: Sendable {
    func log(_ message: String)
}

public struct NoopReferralLogger: ReferralLogging {
    public init() {}

    public func log(_: String) {}
}

public actor ReferralRegistrationCoordinator {
    public static let shared = ReferralRegistrationCoordinator()

    private struct InFlight: Sendable {
        var token: UUID
        var identity: String
        var task: Task<Void, Error>
    }

    private var inFlight: InFlight?

    public init() {}

    func perform(identity: String, operation: @escaping @Sendable () async throws -> Void) async throws {
        while let existing = inFlight {
            if existing.identity == identity {
                do {
                    try await existing.task.value
                    clear(token: existing.token)
                    return
                } catch {
                    clear(token: existing.token)
                    throw error
                }
            }

            _ = try? await existing.task.value
            clear(token: existing.token)
        }

        let token = UUID()
        let task = Task {
            try await operation()
        }
        inFlight = InFlight(token: token, identity: identity, task: task)

        do {
            try await task.value
            clear(token: token)
        } catch {
            clear(token: token)
            throw error
        }
    }

    private func clear(token: UUID) {
        guard inFlight?.token == token else { return }
        inFlight = nil
    }
}

public struct ReferralAPIClient: ReferralAPIClientProtocol, Sendable {
    private struct RegistrationChallengeRequest: Codable { var appUserID: String; var publicKey: String }
    private struct RegistrationChallenge: Decodable {
        var challengeID: String
        var attributeKey: String
        var attributeValue: String
    }
    private struct Registration: Codable {
        var appUserID: String
        var identitySource: String
        var publicKey: String
        var challengeID: String
    }
    private struct Claim: Codable {
        var code: String
        var operationID: String
    }
    private struct RedemptionRequest: Codable { var operationID: String }
    private struct PresentedRequest: Codable { var reservationID: String }
    private struct Empty: Codable {}
    private enum RegistrationVerificationError: Error { case pending }
    private struct ErrorResponse: Decodable {
        struct Detail: Decodable { var code: String?; var message: String? }
        var error: Detail?
    }

    private let configuration: ReferralConfiguration
    private let transport: any ReferralHTTPTransport
    private let signer: any ReferralRequestSigning
    private let challengeSynchronizer: any ReferralChallengeSynchronizing
    private let registrationCoordinator: ReferralRegistrationCoordinator
    private let logger: any ReferralLogging
    private let now: @Sendable () -> Date
    private let makeNonce: @Sendable () -> String

    public init(
        configuration: ReferralConfiguration,
        transport: any ReferralHTTPTransport = URLSession.shared,
        challengeSynchronizer: any ReferralChallengeSynchronizing,
        registrationCoordinator: ReferralRegistrationCoordinator = .shared,
        logger: any ReferralLogging = NoopReferralLogger(),
        now: @escaping @Sendable () -> Date = Date.init,
        makeNonce: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.init(
            configuration: configuration,
            transport: transport,
            signer: ReferralRequestSigner(
                service: configuration.keychainService,
                account: configuration.keychainAccount
            ),
            challengeSynchronizer: challengeSynchronizer,
            registrationCoordinator: registrationCoordinator,
            logger: logger,
            now: now,
            makeNonce: makeNonce
        )
    }

    public init(
        configuration: ReferralConfiguration,
        transport: any ReferralHTTPTransport = URLSession.shared,
        signer: any ReferralRequestSigning,
        challengeSynchronizer: any ReferralChallengeSynchronizing,
        registrationCoordinator: ReferralRegistrationCoordinator = .shared,
        logger: any ReferralLogging = NoopReferralLogger(),
        now: @escaping @Sendable () -> Date = Date.init,
        makeNonce: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.configuration = configuration
        self.transport = transport
        self.signer = signer
        self.challengeSynchronizer = challengeSynchronizer
        self.registrationCoordinator = registrationCoordinator
        self.logger = logger
        self.now = now
        self.makeNonce = makeNonce
    }

    public func account(identity: ReferralIdentity) async throws -> ReferralAccountSnapshot {
        try await send(path: "/v1/account", method: "GET", body: Empty(), identity: identity)
    }

    public func createShare(identity: ReferralIdentity) async throws -> ReferralShare {
        try await send(path: "/v1/codes", method: "POST", body: Empty(), identity: identity)
    }

    public func claim(code: String, identity: ReferralIdentity) async throws -> ReferralFulfillment {
        let operationID = UUID().uuidString.lowercased()
        return try await send(
            path: "/v1/referrals/claim",
            method: "POST",
            body: Claim(code: code, operationID: operationID),
            identity: identity,
            idempotencyKey: operationID
        )
    }

    public func redeemCredit(identity: ReferralIdentity) async throws -> ReferralFulfillment {
        let operationID = UUID().uuidString.lowercased()
        return try await send(
            path: "/v1/credits/redeem",
            method: "POST",
            body: RedemptionRequest(operationID: operationID),
            identity: identity,
            idempotencyKey: operationID
        )
    }

    public func markPresented(reservationID: String, identity: ReferralIdentity) async throws {
        let _: Empty = try await send(
            path: "/v1/redemptions/presented",
            method: "POST",
            body: PresentedRequest(reservationID: reservationID),
            identity: identity
        )
    }

    public func reportOfferCodeIneligible(reservationID: String, identity: ReferralIdentity) async throws {
        let operationID = UUID().uuidString.lowercased()
        let _: Empty = try await send(
            path: "/v1/redemptions/offer-code-ineligible",
            method: "POST",
            body: PresentedRequest(reservationID: reservationID),
            identity: identity,
            // The server transition is naturally idempotent; the operation key also
            // lets the transport safely retry a response lost after the mutation.
            idempotencyKey: operationID
        )
    }

    public func resumeRedemption(
        reservationID: String,
        identity: ReferralIdentity
    ) async throws -> ReferralFulfillment {
        try await send(
            path: "/v1/redemptions/resume",
            method: "POST",
            body: PresentedRequest(reservationID: reservationID),
            identity: identity
        )
    }

    private func register(identity: ReferralIdentity) async throws {
        try await registrationCoordinator.perform(identity: identity.customerID) {
            try await performRegistration(identity: identity)
        }
    }

    private func performRegistration(identity: ReferralIdentity) async throws {
        let publicKey = try signer.publicKey().base64EncodedString()
        let challenge: RegistrationChallenge = try await sendUnsigned(
            path: "/v1/devices/registration-challenges",
            method: "POST",
            body: RegistrationChallengeRequest(appUserID: identity.customerID, publicKey: publicKey)
        )
        try await challengeSynchronizer.setAndSynchronize(
            key: challenge.attributeKey,
            value: challenge.attributeValue
        )
        let registration = Registration(
            appUserID: identity.customerID,
            identitySource: identity.source,
            publicKey: publicKey,
            challengeID: challenge.challengeID
        )
        for (attempt, delay) in configuration.registrationRetryDelays.enumerated() {
            if delay != .zero {
                try await Task.sleep(for: delay)
            }
            do {
                let _: Empty = try await sendUnsigned(
                    path: "/v1/devices/register",
                    method: "POST",
                    body: registration
                )
                logger.log("Referral device registration completed attempt=\(attempt + 1)")
                return
            } catch RegistrationVerificationError.pending {
                logger.log("Referral registration verification pending attempt=\(attempt + 1)")
            }
        }
        logger.log("Referral registration verification exhausted attempts=\(configuration.registrationRetryDelays.count)")
        throw ReferralError.serviceUnavailable
    }

    private func send<Body: Encodable, Response: Decodable>(
        path: String,
        method: String,
        body: Body,
        identity: ReferralIdentity,
        idempotencyKey: String? = nil,
        retryRegistration: Bool = true,
        retryTransport: Bool = true
    ) async throws -> Response {
        let encoder = Self.makeEncoder()
        let bodyData = method == "GET" ? Data() : try encoder.encode(body)
        var request = URLRequest(url: configuration.baseURL.appending(path: path))
        request.httpMethod = method
        request.httpBody = bodyData.isEmpty ? nil : bodyData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(identity.customerID, forHTTPHeaderField: configuration.headers.identity)
        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        let timestamp = Int(now().timeIntervalSince1970)
        let nonce = makeNonce()
        let signature = try signer.signature(
            method: method,
            path: path,
            body: bodyData,
            timestamp: timestamp,
            nonce: nonce
        )
        request.setValue(String(timestamp), forHTTPHeaderField: configuration.headers.timestamp)
        request.setValue(nonce, forHTTPHeaderField: configuration.headers.nonce)
        request.setValue(signature.base64EncodedString(), forHTTPHeaderField: configuration.headers.signature)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport.data(for: request)
        } catch {
            guard idempotencyKey != nil, retryTransport else { throw error }
            logger.log("Referral mutation transport failed; retrying operation")
            return try await send(
                path: path,
                method: method,
                body: body,
                identity: identity,
                idempotencyKey: idempotencyKey,
                retryRegistration: retryRegistration,
                retryTransport: false
            )
        }
        guard let http = response as? HTTPURLResponse else { throw ReferralError.serviceUnavailable }
        if http.statusCode == 401, retryRegistration {
            try await register(identity: identity)
            return try await send(
                path: path,
                method: method,
                body: body,
                identity: identity,
                idempotencyKey: idempotencyKey,
                retryRegistration: false,
                retryTransport: retryTransport
            )
        }
        guard 200 ... 299 ~= http.statusCode else {
            logFailure(path: path, status: http.statusCode, data: data)
            throw serverError(status: http.statusCode, data: data)
        }
        return try Self.makeDecoder().decode(Response.self, from: data.isEmpty ? Data("{}".utf8) : data)
    }

    private func sendUnsigned<Body: Encodable, Response: Decodable>(
        path: String,
        method: String,
        body: Body
    ) async throws -> Response {
        var request = URLRequest(url: configuration.baseURL.appending(path: path))
        request.httpMethod = method
        request.httpBody = try Self.makeEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse, 200 ... 299 ~= http.statusCode else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 503
            if path == "/v1/devices/register",
               errorDetail(data)?.code == "unverified_registration_challenge" {
                throw RegistrationVerificationError.pending
            }
            logFailure(path: path, status: status, data: data)
            throw serverError(status: status, data: data)
        }
        return try Self.makeDecoder().decode(Response.self, from: data.isEmpty ? Data("{}".utf8) : data)
    }

    private func serverError(status: Int, data: Data) -> ReferralError {
        let detail = errorDetail(data)
        switch detail?.code {
        case "recipient_not_eligible":
            return .recipientIneligible
        case "unverified_customer", "invalid_registration_challenge", "unverified_registration_challenge":
            return .serviceUnavailable
        default:
            return .server(statusCode: status, code: detail?.code, message: detail?.message)
        }
    }

    private func errorDetail(_ data: Data) -> ErrorResponse.Detail? {
        (try? Self.makeDecoder().decode(ErrorResponse.self, from: data))?.error
    }

    private func logFailure(path: String, status: Int, data: Data) {
        let code = errorDetail(data)?.code ?? "unknown"
        logger.log("Referral request failed path=\(path) status=\(status) code=\(code)")
    }

    private static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
