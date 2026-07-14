//
//  ReferralModels.swift
//  ReferralKit
//
//  Created by Ethan Lipnik on 7/13/26.
//

import Foundation

public struct ReferralIdentity: Codable, Equatable, Sendable {
    public var customerID: String
    public var source: String

    public init(customerID: String, source: String) {
        self.customerID = customerID
        self.source = source
    }
}

public struct ReferralShare: Codable, Equatable, Sendable {
    public var code: String
    public var url: URL

    public init(code: String, url: URL) {
        self.code = code
        self.url = url
    }
}

public enum ReferralRedemptionState: String, Codable, Sendable {
    case ready
    case activeReward = "active_reward"
}

public struct ReferralRedemptionStatus: Codable, Equatable, Sendable {
    public var state: ReferralRedemptionState
    public var nextEligibleAt: Date?
    public var activeRewardEndsAt: Date?

    public init(state: ReferralRedemptionState, nextEligibleAt: Date? = nil, activeRewardEndsAt: Date? = nil) {
        self.state = state
        self.nextEligibleAt = nextEligibleAt
        self.activeRewardEndsAt = activeRewardEndsAt
    }
}

public struct ReferralAccountSnapshot: Codable, Equatable, Sendable {
    public var availableCredits: Int
    public var reservedCredits: Int
    public var pendingRewards: Int
    public var canEarnCredits: Bool
    public var isLifetime: Bool
    public var share: ReferralShare?
    public var redemption: ReferralRedemptionStatus?

    public init(
        availableCredits: Int,
        reservedCredits: Int,
        pendingRewards: Int,
        canEarnCredits: Bool,
        isLifetime: Bool,
        share: ReferralShare?,
        redemption: ReferralRedemptionStatus? = nil
    ) {
        self.availableCredits = availableCredits
        self.reservedCredits = reservedCredits
        self.pendingRewards = pendingRewards
        self.canEarnCredits = canEarnCredits
        self.isLifetime = isLifetime
        self.share = share
        self.redemption = redemption
    }

    public var displayCreditCount: Int? {
        isLifetime ? nil : availableCredits
    }
}

public enum ReferralFulfillmentKind: String, Codable, Sendable {
    case offerCode = "offer_code"
    case promotionalOffer = "promotional_offer"
}

public struct ReferralFulfillment: Codable, Equatable, Sendable {
    public var reservationID: String
    public var kind: ReferralFulfillmentKind
    public var offerCode: String?
    public var offerURL: URL?
    public var productIdentifier: String
    public var promotionalOfferIdentifier: String?
    public var freeMonths: Int?
    public var expiresAt: Date

    public init(
        reservationID: String,
        kind: ReferralFulfillmentKind,
        offerCode: String? = nil,
        offerURL: URL? = nil,
        productIdentifier: String,
        promotionalOfferIdentifier: String? = nil,
        freeMonths: Int? = nil,
        expiresAt: Date
    ) {
        self.reservationID = reservationID
        self.kind = kind
        self.offerCode = offerCode
        self.offerURL = offerURL
        self.productIdentifier = productIdentifier
        self.promotionalOfferIdentifier = promotionalOfferIdentifier
        self.freeMonths = freeMonths
        self.expiresAt = expiresAt
    }

    public var rewardMonths: Int {
        max(1, freeMonths ?? 1)
    }
}

public enum ReferralError: LocalizedError, Equatable, Sendable {
    case identityUnavailable
    case invalidCode
    case invalidLink
    case recipientIneligible
    case serviceUnavailable
    case server(statusCode: Int, code: String?, message: String?)

    public var errorDescription: String? {
        switch self {
        case .identityUnavailable:
            "A secure referral identity is not available."
        case .invalidCode:
            "That referral code isn't valid."
        case .invalidLink:
            "That referral link isn't valid."
        case .recipientIneligible:
            "This account isn't eligible for the referral."
        case .serviceUnavailable:
            "Referrals aren't available right now."
        case let .server(_, _, message):
            message ?? "The referral request couldn't be completed."
        }
    }
}
