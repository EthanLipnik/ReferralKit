# ReferralKit

Build a secure, Apple-native referral program for your subscription app.

ReferralKit gives you the pieces behind a polished “give a month, get a month” experience: shareable referral links, recipient rewards, sender credits, signed device registration, purchase reconciliation, and reusable account state for your SwiftUI interface.

It includes:

- A Swift 6 client for iOS, macOS, and visionOS
- A deployable Cloudflare Worker with a D1 referral ledger
- RevenueCat customer verification and webhook reconciliation
- Encrypted App Store offer-code inventory
- App Store Connect setup automation powered by `asc`
- Staging and production isolation with independent rollout controls

## Installation

Add `https://github.com/EthanLipnik/ReferralKit.git` in Xcode through **File → Add Package Dependencies**, then link the `ReferralKit` product to your app target.

You can also add it to `Package.swift`:

```swift
dependencies: [
    .package(
        url: "https://github.com/EthanLipnik/ReferralKit.git",
        branch: "main"
    )
]
```

ReferralKit supports iOS 17+, macOS 14+, and visionOS 2+. The Swift client has no third-party package dependencies.

## Quick start

Create a configuration for your referral service and public link domain:

```swift
import ReferralKit

let referralConfiguration = ReferralConfiguration(
    baseURL: URL(string: "https://referrals.example.com")!,
    publicReferralHost: "example.com",
    keychainService: "com.example.app.referrals.signing-key",
    snapshotCacheKey: "com.example.app.referrals.snapshot.v1"
)
```

ReferralKit binds each installation to a stable subscriber through a short-lived challenge. Connect that challenge to the subscriber-attribute system used by your RevenueCat integration:

```swift
struct SubscriberAttributeSynchronizer: ReferralChallengeSynchronizing {
    func setAndSynchronize(key: String, value: String) async throws {
        // Set the RevenueCat subscriber attribute, then wait for it to sync.
        try await subscriptionService.setSubscriberAttribute(key: key, value: value)
        try await subscriptionService.syncSubscriberAttributes()
    }
}
```

Create the API client and observable manager:

```swift
@MainActor
func makeReferralManager() -> ReferralManager {
    let client = ReferralAPIClient(
        configuration: referralConfiguration,
        challengeSynchronizer: SubscriberAttributeSynchronizer()
    )

    return ReferralManager(
        api: client,
        configuration: referralConfiguration,
        identityProvider: {
            ReferralIdentity(
                customerID: subscriptionService.stableCustomerID,
                source: "account"
            )
        }
    )
}
```

The identity should be stable across launches and match the RevenueCat customer updated by your challenge synchronizer.

## Build the referral experience

`ReferralManager` is `@Observable` and `@MainActor`, so it fits directly into a SwiftUI state model.

Refresh the customer’s referral balance:

```swift
await referralManager.refresh()

let credits = referralManager.snapshot?.availableCredits ?? 0
let pendingRewards = referralManager.snapshot?.pendingRewards ?? 0
```

Create a shareable invite:

```swift
let invite = try await referralManager.createShareLink()
shareLink = invite.url
```

Accept a universal link and redeem its code:

```swift
if referralManager.handle(url: incomingURL),
   let code = referralManager.pendingCode {
    let fulfillment = try await referralManager.claim(code: code)
    await present(fulfillment)
}
```

Redeem an earned sender credit:

```swift
let fulfillment = try await referralManager.redeemCredit()
await present(fulfillment)
```

`ReferralFulfillment` tells your app how to complete the reward:

- `.offerCode` provides an App Store offer-code URL for the recipient.
- `.promotionalOffer` provides the product and promotional-offer identifiers for the sender.

After the purchase sheet completes, refresh your subscription state and call `refresh()` to update the referral balance.

## Universal links

Referral links use this shape:

```text
https://example.com/r/EXAMPLECODE
```

Set `publicReferralHost` to your domain, add the Associated Domains entitlement to your app, and serve an `apple-app-site-association` file that routes `/r/*` to the app. Pass incoming URLs to `ReferralManager.handle(url:)` from your SwiftUI `onOpenURL` handler or application delegate.

## Deploy the backend

The included Worker provides the referral API, signed device registration, credit ledger, offer inventory, and RevenueCat webhook handler.

```sh
cd Worker
npm ci
npm test
npm run build
```

To configure it:

1. Create separate Cloudflare D1 databases for staging and production.
2. Replace the example application, product, entitlement, offer, and database values in `Worker/wrangler.toml`.
3. Install the RevenueCat, hashing, encryption, and inventory-import secrets with Wrangler.
4. Apply the D1 migrations.
5. Deploy staging and connect a RevenueCat sandbox webhook to `/v1/revenuecat/webhooks`.
6. Import a batch of App Store offer codes and complete a sandbox referral end to end.

The Worker starts with enrollment and redemption disabled. Use the guarded
production promotion command in [Worker/README.md](Worker/README.md) only after
the disabled Worker reports that its code inventory is enrollment-ready.

See [Worker/README.md](Worker/README.md) for secrets, migration commands, offer-code imports, webhook setup, and rollout guidance.

## Configure App Store offers

ReferralKit includes a setup tool for creating recipient offer-code configurations and sender promotional offers through the App Store Connect CLI.

Start with the example configuration:

```sh
cp Examples/referral-program.example.json referral-program.json

# Preview the desired App Store configuration without contacting Apple.
python3 Scripts/setup-referrals.py \
  --config referral-program.json \
  --offline-plan

# Compare the plan with App Store Connect.
python3 Scripts/setup-referrals.py \
  --config referral-program.json \
  --profile your-asc-profile

# Create missing resources after reviewing the plan.
python3 Scripts/setup-referrals.py \
  --config referral-program.json \
  --profile your-asc-profile \
  --state private/referral-setup-state.json \
  --apply
```

The tool is safe to rerun: matching resources become no-ops, immutable-field drift is reported, and generated one-time code batches are recorded in the private state file.

## How rewards stay consistent

ReferralKit is designed around retry-safe, auditable operations:

- Clients sign requests with a device-bound P-256 key.
- Registration verifies ownership through a RevenueCat subscriber attribute.
- Logical operation IDs recover successful claims when a response is lost.
- Credits use an append-only ledger with compensating entries.
- Offer codes are encrypted at rest and reserved before fulfillment.
- Webhooks are idempotent, alias-aware, and scoped to the configured transaction environment.
- Enrollment and redemption have separate kill switches, allowing new referrals to pause without stranding earned rewards.

## Test your integration

Run the complete project test suite:

```sh
swift test
python3 -m unittest Tests/test_setup_referrals.py

cd Worker
npm ci
npm test
npm run build
```

Before launch, exercise new and returning recipients, active and expired subscribers, lifetime customers, duplicate claims, depleted inventory, delayed webhooks, refunds, lost responses, and strict sandbox/production isolation.

## Security

Keep RevenueCat credentials, webhook secrets, encryption keys, hashing keys, Apple offer-code batches, and setup state out of source control. Avoid logging raw customer identifiers or referral codes, and review the Worker’s rate limits and reward ceilings for your product economics.

Please report suspected vulnerabilities privately to the repository owner.

## Project status

ReferralKit is currently distributed from the `main` branch while its public API settles. Versioned releases will follow.

## License

Copyright © Ethan Lipnik. No license is granted at this time.
