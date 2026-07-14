# ReferralKit Worker

This Cloudflare Worker is the reference backend for ReferralKit. It owns referral codes, device registration, the immutable credit ledger, reward reservations, one-time Apple offer-code inventory, and RevenueCat webhook reconciliation.

It is a starting point, not a hosted service. You are responsible for deploying it, reviewing its policy for your product, securing its secrets, and validating purchases end to end.

## Configure

1. Replace every example value in `wrangler.toml`.
2. Create separate staging and production D1 databases and put their IDs in the matching bindings.
3. Keep both `enabled` and `redemptionEnabled` false initially.
4. Copy `.dev.vars.example` to `.dev.vars` for local development only.
5. Install six independent secrets in each Cloudflare environment:

```sh
npx wrangler secret put REVENUECAT_SECRET_KEY --env staging
npx wrangler secret put REVENUECAT_WEBHOOK_SECRET --env staging
npx wrangler secret put CODE_HASH_SECRET --env staging
npx wrangler secret put IDENTITY_HASH_SECRET --env staging
npx wrangler secret put OFFER_CODE_ENCRYPTION_KEY --env staging
npx wrangler secret put OFFER_CODE_IMPORT_SECRET --env staging
```

`OFFER_CODE_ENCRYPTION_KEY` must be a Base64-encoded 32-byte key. Never reuse one secret for another purpose or share databases, code inventory, or secrets between staging and production.

## Develop and test

```sh
npm ci
npm test
npm run build
npm run db:migrate:local
npm run dev
```

For staging, run `npm run db:migrate:staging` and `npm run deploy:staging`. Configure a RevenueCat webhook for sandbox events at `/v1/revenuecat/webhooks` with `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>`.

Import an Apple one-time-code batch with `POST /v1/admin/offer-codes/import`, authenticated by `OFFER_CODE_IMPORT_SECRET`. The JSON body contains `offerReference`, `product`, and `codes`. Do not commit or log the plaintext file. Delete it after you verify encrypted inventory in D1.

## Configuration notes

- `CODE_PREFIX` is the visible prefix before three groups of four random characters.
- `AUTH_HEADER_PREFIX` must match the Swift client's configured `X-<prefix>-Identity`, timestamp, nonce, and signature headers.
- `REGISTRATION_ATTRIBUTE_KEY` is written to the current RevenueCat subscriber during device binding.
- `LIFETIME_PRODUCT_IDS` is a comma-separated exact list. Lifetime status is never inferred from a product name.
- This reference policy models monthly and yearly subscriptions and 1, 2, 3, 6, and 12-month sender rewards. Supporting other products requires deliberate policy and schema changes.
- `senderCreditDays` and `recipientFreeDays` are display/configuration metadata. Apple offer definitions determine the actual purchase terms.

## Activation checklist

Before enabling staging enrollment, verify challenge expiry/replay/key binding, self-referral and duplicate rejection, sandbox-only webhook filtering, code inventory encryption and reservation release, cancellation/refund behavior, and ledger reconciliation. Then complete actual sandbox purchases for new, active, expired, and lifetime customer histories.

Deploy production with enrollment disabled. Enable a small cohort only after staging passes. If an incident occurs, disable enrollment first; keep redemption available when safe so earned value is not stranded. Never correct balances by deleting ledger rows—append an audited adjustment.

`enabled` controls new code creation and recipient enrollment. `redemptionEnabled` independently controls fulfillment, including redemption of already-earned sender credits. Setting `enabled` to false while leaving `redemptionEnabled` true is the normal enrollment rollback posture.

Customer purchase history is evaluated only in `REVENUECAT_TRANSACTION_ENVIRONMENT`. Transactions with missing environment metadata fail closed for new-recipient eligibility. Webhook identity resolution checks the current App User ID, original App User ID, and aliases; ambiguous identity families are rejected.

Mutation retries use a logical operation ID in the signed JSON body and the matching `Idempotency-Key` header. Older clients fall back to the signed request nonce. Successful fulfillment responses are encrypted before entering the idempotency cache, and the scheduled Worker removes cached responses after 30 days.

For RevenueCat lifecycle events, an ordinary `CANCELLATION` does not revoke sender credit. A cancellation reverses credit only when `cancel_reason` is `CUSTOMER_SUPPORT`; `REFUND_REVERSED` appends one audited compensating adjustment. Dashboard `TEST` events are acknowledged without requiring a registered customer.
