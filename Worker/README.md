# ReferralKit Worker

This Cloudflare Worker is the reference backend for ReferralKit. It owns referral codes, device registration, the immutable credit ledger, reward reservations, one-time Apple offer-code inventory, and RevenueCat webhook reconciliation.

It is a starting point, not a hosted service. You are responsible for deploying it, reviewing its policy for your product, securing its secrets, and validating purchases end to end.

## Configure

1. Replace every example value in `wrangler.toml`.
2. Create separate staging and production D1 databases and put their IDs in the matching bindings.
3. Keep both `enabled` and `redemptionEnabled` false initially.
4. Copy `.dev.vars.example` to `.dev.vars` for local development only.
5. Install seven independent secrets in each Cloudflare environment:

```sh
npx wrangler secret put REVENUECAT_SECRET_KEY --env staging
npx wrangler secret put REVENUECAT_WEBHOOK_SECRET --env staging
npx wrangler secret put REVENUECAT_WEBHOOK_SIGNING_SECRET --env staging
npx wrangler secret put CODE_HASH_SECRET --env staging
npx wrangler secret put IDENTITY_HASH_SECRET --env staging
npx wrangler secret put OFFER_CODE_ENCRYPTION_KEY --env staging
npx wrangler secret put OFFER_CODE_IMPORT_SECRET --env staging
```

`OFFER_CODE_ENCRYPTION_KEY` must be a Base64-encoded 32-byte key. `REVENUECAT_WEBHOOK_SIGNING_SECRET` is the HMAC signing secret configured in the matching RevenueCat webhook integration. Never reuse one secret for another purpose or share databases, code inventory, or secrets between staging and production.

## Develop and test

```sh
npm ci
npm test
npm run build
npm run db:migrate:local
npm run dev
```

For staging, run `npm run db:migrate:staging` and `npm run deploy:staging`. Configure a sandbox-only RevenueCat webhook at `/v1/revenuecat/webhooks` with `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>`, enable RevenueCat HMAC signing, and install the resulting signing secret as `REVENUECAT_WEBHOOK_SIGNING_SECRET`.

Import an Apple one-time-code batch with `POST /v1/admin/offer-codes/import`, authenticated by `OFFER_CODE_IMPORT_SECRET`. The JSON body contains `offerReference`, `product`, and `codes`. Do not commit or log the plaintext file. Delete it after you verify encrypted inventory in D1.
The product must match the offer reference's configured monthly or yearly product; mismatched imports are rejected.

## Deploy a product configuration

From the ReferralKit repository root, `wrangler.toml` is a generic template and is intentionally not deployable. A product
must provide a concrete non-secret Worker manifest with its own D1 IDs, public
domains, product identifiers, offer IDs, and App Store Connect offer reference
names. Validate that manifest before any D1 migration or deploy:

```sh
python3 Scripts/validate-worker-config.py \
  --config /secure/path/product-wrangler.toml \
  --environment staging

bash Scripts/deploy-worker.sh staging \
  --config /secure/path/product-wrangler.toml \
  --base-url https://referrals-staging.example.com
```

The deploy command runs the Worker tests and build, verifies all seven deployed
secret names (including RevenueCat HMAC signing), applies the matching D1
migrations, deploys that environment, and verifies `/health`. Production is
always rejected unless `CONFIG_JSON.enabled` is `false`; enable enrollment only
after a separate canary.

After inventory is loaded, repeat the production deploy verification with
`--require-enrollment-ready`. This keeps the initial disabled-first deployment
possible while making the final canary fail unless `/health` confirms correctly
partitioned inventory for every configured recipient and new-sender offer.

## Configuration notes

- `CODE_PREFIX` is the visible prefix before three groups of four random characters.
- `AUTH_HEADER_PREFIX` must match the Swift client's configured `X-<prefix>-Identity`, timestamp, nonce, and signature headers.
- `ASSOCIATED_APP_IDS` is a comma-separated list of Apple App Site Association IDs served from `/.well-known/apple-app-site-association`. Include the exact App Store or TestFlight application identifier for each app that should open referral links on this Worker host.
- `REGISTRATION_ATTRIBUTE_KEY` is written to the current RevenueCat subscriber during device binding.
- `LIFETIME_PRODUCT_IDS` is a comma-separated exact list. Lifetime status is never inferred from a product name.
- `RECIPIENT_*_OFFER_ID` is the App Store Connect resource ID used to partition imported code inventory. `RECIPIENT_*_OFFER_REFERENCE_NAME` is the offer's exact reference name from App Store Connect, which RevenueCat sends in webhook `offer_code` fields. Do not put the resource ID in both settings.
- `SENDER_NEW_*_OFFER_ID` is the App Store Connect resource ID used to partition new-sender offer-code inventory. `SENDER_NEW_*_OFFER_REFERENCE_NAME` is the offer's exact reference name from App Store Connect, which RevenueCat sends in webhook `offer_code` fields. Do not put the resource ID in both settings.
- This reference policy models monthly and yearly subscriptions and 1, 2, 3, 6, and 12-month sender rewards. Supporting other products requires deliberate policy and schema changes.
- `senderCreditDays` and `recipientFreeDays` are display/configuration metadata. Apple offer definitions determine the actual purchase terms.

## Activation checklist

Before enabling staging enrollment, verify challenge expiry/replay/key binding, self-referral and duplicate rejection, sandbox-only webhook filtering, code inventory encryption and reservation release, cancellation/refund behavior, and ledger reconciliation. Then complete actual sandbox purchases for new, active, expired, and lifetime customer histories.

Deploy production with enrollment disabled. Enable a small cohort only after staging passes. If an incident occurs, disable enrollment first; keep redemption available when safe so earned value is not stranded. Never correct balances by deleting ledger rows—append an audited adjustment.

`enabled` controls new code creation and recipient enrollment. `redemptionEnabled` independently controls fulfillment, including redemption of already-earned sender credits. Setting `enabled` to false while leaving `redemptionEnabled` true is the normal enrollment rollback posture.

Customer purchase history is evaluated only in `REVENUECAT_TRANSACTION_ENVIRONMENT`. Transactions with missing environment metadata fail closed for new-recipient eligibility. Webhook identity resolution checks the current App User ID, original App User ID, and aliases; ambiguous identity families are rejected.

Mutation retries use a logical operation ID in the signed JSON body and the matching `Idempotency-Key` header. Older clients fall back to the signed request nonce. Successful fulfillment responses are encrypted before entering the idempotency cache, and the scheduled Worker removes cached responses after 30 days.

`POST /v1/devices/revoke` revokes only the device signing that request. It does
not accept a target device ID and is intentionally a self-revocation endpoint;
lost-device administration remains an operator action rather than exposing an
account-wide device directory.

Once an Apple one-time code has been disclosed, its inventory assignment is
permanent. Recovery UI is bounded, but signed RevenueCat transactions continue
to reconcile against the durable assigned inventory record after that recovery
window so a still-valid Apple code cannot grant value without consuming its
corresponding referral reward.

For RevenueCat lifecycle events, an ordinary `CANCELLATION` does not revoke sender credit. A cancellation reverses credit only when `cancel_reason` is `CUSTOMER_SUPPORT`; `REFUND_REVERSED` appends one audited compensating adjustment. Dashboard `TEST` events are acknowledged without requiring a registered customer.
