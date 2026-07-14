# ReferralKit

ReferralKit is an early, reusable referral-program foundation for subscription apps on Apple platforms. It contains:

- A Swift client for signed referral requests, device registration, account state, deep links, and reward fulfillment models.
- A Cloudflare Worker reference backend with a D1 ledger, reservations, encrypted Apple offer-code inventory, and RevenueCat webhook reconciliation.
- A parameterized `asc` setup tool for App Store Connect subscription offer codes and promotional offers.

> **Pre-release status:** this extraction comes from a referral implementation that is still being tested. It has not received a stable release, production-readiness review, or license grant. Keep enrollment disabled until your own staging end-to-end tests pass.

## What it does—and does not do

ReferralKit provides attribution, secure client registration, referral state, and a reference reward ledger. App Store Connect and StoreKit still make the final offer-eligibility decision. RevenueCat is used by the reference backend to inspect customer history and reconcile purchase webhooks.

The setup tool creates Apple offer definitions and optional one-time code batches. It cannot configure Cloudflare, RevenueCat keys/webhooks, associated domains, App Site Association files, fraud policy, or your application UI.

## Swift package

Add this repository as a Swift package and link the `ReferralKit` product. During local development:

```swift
.package(path: "../ReferralKit")
```

The package supports iOS 17+, macOS 14+, and visionOS 2+. It has no third-party Swift dependencies. The app supplies its own subscriber identity and challenge synchronization adapter, so RevenueCat is not forced on all users.

```swift
import ReferralKit

let configuration = ReferralConfiguration(
    baseURL: URL(string: "https://referrals.example.com")!,
    publicReferralHost: "example.com",
    headers: .init(
        identity: "X-Example-Identity",
        timestamp: "X-Example-Timestamp",
        nonce: "X-Example-Nonce",
        signature: "X-Example-Signature"
    ),
    keychainService: "com.example.app.referrals.signing-key",
    snapshotCacheKey: "com.example.app.referrals.snapshot.v1"
)

let client = ReferralAPIClient(
    configuration: configuration,
    challengeSynchronizer: revenueCatChallengeSynchronizer
)

let manager = ReferralManager(
    api: client,
    configuration: configuration,
    identityProvider: {
        ReferralIdentity(customerID: stableCustomerID, source: "keychain")
    }
)
```

Your `ReferralChallengeSynchronizing` implementation must write the key/value returned by the backend to the same RevenueCat subscriber represented by `ReferralIdentity`, then wait for synchronization. If the customer can change, serialize identity changes with referral registration. Never use an anonymous identifier that can silently rotate between requests.

Offer-code URLs and promotional-offer identifiers are returned as `ReferralFulfillment`. Your app remains responsible for presenting StoreKit/RevenueCat purchase UI and synchronizing entitlement state afterward.

## App Store Connect setup

The setup tool follows the installed `asc` 2.6 command surface and uses explicit flags, JSON output, and paginated reads. Start from the example:

```sh
cp Examples/referral-program.example.json referral-program.json
python3 Scripts/setup-referrals.py --config referral-program.json --offline-plan
python3 Scripts/setup-referrals.py --config referral-program.json
```

The first command validates and prints an offline plan. The second authenticates through `asc`, lists existing resources, and prints a read-only reconciliation plan. Only `--apply` mutates App Store Connect:

```sh
python3 Scripts/setup-referrals.py \
  --config referral-program.json \
  --profile your-asc-profile \
  --state private/referral-setup-state.json \
  --apply
```

The script:

- Creates missing subscription offer-code configurations and promotional offers.
- Treats matching resources as no-ops.
- Refuses detected immutable-field drift rather than creating duplicates.
- Records generated one-time batches so a rerun does not intentionally generate another batch.
- Creates code and state files with owner-only permissions and never prints code values.

App Store Connect does not offer a transaction across these operations, and the relevant `asc` surface does not advertise deletion. An interrupted apply may require manual inspection or deactivation before retrying. Save the JSON summary and state file securely. Before trusting reconciliation in production, capture sanitized `asc` JSON fixtures from your account because Apple resource shapes can evolve.

Run `asc auth login` first if needed. For exact key-role coverage, the current CLI exposes the experimental `asc web auth capabilities` command; it requires an Apple web session and is intentionally not run automatically.

## Reference backend

See [Worker/README.md](Worker/README.md). The reference backend deliberately ships with production and staging enrollment disabled. Its core invariants are:

- Referral codes contain no customer or device identifiers.
- Signed requests use a P-256 device key, timestamp, and one-time nonce.
- First registration binds the device key through a RevenueCat subscriber attribute challenge.
- Credits are an append-only ledger; reservations append negative entries and releases append compensating positive entries.
- Offer codes are encrypted at rest and isolated by environment.
- Production rejects sandbox transactions and staging rejects production transactions.
- Subscriber history, lifetime state, and active-product selection are scoped to the configured transaction environment.
- Mutation operation IDs recover lost responses without reusing signed-request nonces or storing offer codes in plaintext.
- Webhook retries are payload-bound, alias-aware, and safe after transient processing failures.

The current reference reward policy models monthly/yearly subscriptions and supported Apple durations of 1, 2, 3, 6, and 12 months. Treat policy changes as backend design work, not configuration-only edits.

## Universal links

Host referral links at `https://<public-host>/r/<code>`. Configure the Associated Domains entitlement and an `apple-app-site-association` file restricted to `/r/*`. The Swift package parses only HTTPS links matching the configured host and path. It does not change app entitlements or host the association file for you.

## Verification

```sh
swift test
python3 -m unittest Tests/test_setup_referrals.py

cd Worker
npm ci
npm test
npm run build
```

Before enabling referrals, test at least: a new recipient, previous trial, active subscriber, expired subscriber, lifetime owner, self-referral, duplicate claim, missing inventory, cancelled purchase, expired reservation, duplicate/delayed webhook, refund, wrong transaction environment, and registration challenge expiry/replay/key mismatch.

## Security and privacy

Do not put RevenueCat secret keys, webhook secrets, code hashing keys, encryption keys, import secrets, Apple code batches, or setup state in Git. Do not log referral codes or raw customer identifiers. Review rate limits and abuse ceilings for your economics. The reference Worker avoids application-level IP storage; infrastructure providers may still process network metadata under their own policies.

Report suspected vulnerabilities privately to the repository owner rather than opening a public issue with exploit details or secrets.

## License

No license is granted yet. The source is currently provided for evaluation while the extracted program is tested. Choose and add a license before publishing or inviting outside reuse.
