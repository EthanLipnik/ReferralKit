import assert from "node:assert/strict";
import test from "node:test";
import {ReferralConfig, Env} from "../src/env";
import {
    claimWebhookEvent,
    operationAllowed,
    processRevenueCatEvent,
    resolveRegistrationAccount,
    resolveWebhookAccount,
    route,
    verifyRevenueCatWebhookSignature
} from "../src/index";
import {registeredDevicesForIdentity} from "../src/auth";
import {HTTPError} from "../src/http";
import {RCEvent} from "../src/revenuecat";
import {decryptOfferCode, encryptOfferCode, hmac, sha256} from "../src/crypto";
import {activeReservationByID, referralHistory} from "../src/domain";

const baseConfig: ReferralConfig = {
    schemaVersion: 1,
    enabled: true,
    redemptionEnabled: true,
    renewalProduct: "monthly",
    senderCreditDays: 30,
    recipientFreeDays: 30,
    maxBankedCredits: 24,
    maxCreditsPerRedemption: 12,
    extensionWindowDays: 7,
    maxRewardedReferralsPerRolling30Days: 10,
    maxOutstandingClaims: 20,
    reservationMinutes: 30,
    hidePolicy: "proOnly",
    copyVariant: "giftMonthV1",
    localizedCopy: {}
};

function testEnv(database: unknown, config: Partial<ReferralConfig> = {}): Env {
    return {
        DB: database as D1Database,
        ENVIRONMENT: "staging",
        PUBLIC_SITE_URL: "https://staging.example.com",
        ASSOCIATED_APP_IDS: "TEAMID.com.example.App",
        APP_STORE_URL: "https://apps.apple.com/app/id123",
        APP_STORE_ID: "123",
        APP_NAME: "Example",
        PRO_NAME: "Example Pro",
        CODE_PREFIX: "DEMO",
        AUTH_HEADER_PREFIX: "Demo",
        REGISTRATION_ATTRIBUTE_KEY: "example_challenge",
        REVENUECAT_API_BASE: "https://api.revenuecat.test/v1",
        REVENUECAT_SECRET_KEY: "test-secret",
        REVENUECAT_WEBHOOK_SECRET: "test-webhook-secret",
        REVENUECAT_WEBHOOK_SIGNING_SECRET: "test-signing-secret",
        REVENUECAT_TRANSACTION_ENVIRONMENT: "SANDBOX",
        REVENUECAT_ENTITLEMENT: "Example Pro",
        MONTHLY_PRODUCT_ID: "example_pro_monthly",
        YEARLY_PRODUCT_ID: "example_pro_yearly",
        LIFETIME_PRODUCT_IDS: "example_pro_lifetime",
        RECIPIENT_MONTHLY_OFFER_ID: "recipient-monthly",
        RECIPIENT_YEARLY_OFFER_ID: "recipient-yearly",
        RECIPIENT_MONTHLY_OFFER_REFERENCE_NAME: "Recipient Monthly Reference",
        RECIPIENT_YEARLY_OFFER_REFERENCE_NAME: "Recipient Yearly Reference",
        SENDER_MONTHLY_PROMOTIONAL_OFFER_ID: "sender-monthly-1",
        SENDER_YEARLY_PROMOTIONAL_OFFER_ID: "sender-yearly-1",
        SENDER_MONTHLY_PROMOTIONAL_OFFER_2_MONTHS_ID: "sender-monthly-2",
        SENDER_YEARLY_PROMOTIONAL_OFFER_2_MONTHS_ID: "sender-yearly-2",
        SENDER_MONTHLY_PROMOTIONAL_OFFER_3_MONTHS_ID: "sender-monthly-3",
        SENDER_YEARLY_PROMOTIONAL_OFFER_3_MONTHS_ID: "sender-yearly-3",
        SENDER_MONTHLY_PROMOTIONAL_OFFER_6_MONTHS_ID: "sender-monthly-6",
        SENDER_YEARLY_PROMOTIONAL_OFFER_6_MONTHS_ID: "sender-yearly-6",
        SENDER_MONTHLY_PROMOTIONAL_OFFER_12_MONTHS_ID: "sender-monthly-12",
        SENDER_YEARLY_PROMOTIONAL_OFFER_12_MONTHS_ID: "sender-yearly-12",
        SENDER_NEW_MONTHLY_OFFER_ID: "sender-new-monthly",
        SENDER_NEW_YEARLY_OFFER_ID: "sender-new-yearly",
        CODE_HASH_SECRET: "code-hash-secret",
        IDENTITY_HASH_SECRET: "identity-hash-secret",
        OFFER_CODE_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        OFFER_CODE_IMPORT_SECRET: "import-secret",
        CONFIG_JSON: JSON.stringify({...baseConfig, ...config})
    };
}

function event(overrides: Partial<RCEvent> = {}): RCEvent {
    return {
        id: "event-1",
        type: "INITIAL_PURCHASE",
        app_user_id: "recipient-rc-id",
        transaction_id: "transaction-1",
        product_id: "example_pro_monthly",
        offer_code: "Recipient Monthly Reference",
        environment: "SANDBOX",
        ...overrides
    };
}

test("production kill switches block enrollment while allowing earned-credit redemption", () => {
    const productionPosture = {...baseConfig, enabled: false, redemptionEnabled: true};
    assert.equal(operationAllowed("/v1/codes", productionPosture), false);
    assert.equal(operationAllowed("/v1/referrals/claim", productionPosture), false);
    assert.equal(operationAllowed("/v1/credits/redeem", productionPosture), true);

    const fullStop = {...baseConfig, enabled: false, redemptionEnabled: false};
    assert.equal(operationAllowed("/v1/codes", fullStop), false);
    assert.equal(operationAllowed("/v1/referrals/claim", fullStop), false);
    assert.equal(operationAllowed("/v1/credits/redeem", fullStop), false);
});

test("staging can serve referral Universal Link association without a redirect", async () => {
    const response = await route(
        new Request("https://staging.example.com/.well-known/apple-app-site-association"),
        testEnv({})
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.deepEqual(await response.json(), {
        applinks: {
            details: [{
                appIDs: ["TEAMID.com.example.App"],
                components: [{"/": "/r/*", comment: "Referral links"}]
            }]
        }
    });
});

test("RevenueCat webhook signatures require a valid fresh HMAC", async () => {
    const raw = JSON.stringify({event: {id: "event-1"}});
    const timestamp = "1784044800";
    const signature = await hmac("signing-secret", `${timestamp}.${raw}`);
    const header = `t=${timestamp},v1=${signature}`;
    const now = Number(timestamp) * 1_000;
    assert.equal(await verifyRevenueCatWebhookSignature(raw, header, "signing-secret", now), true);
    assert.equal(await verifyRevenueCatWebhookSignature(`${raw} `, header, "signing-secret", now), false);
    assert.equal(await verifyRevenueCatWebhookSignature(raw, header, "wrong-secret", now), false);
    assert.equal(await verifyRevenueCatWebhookSignature(raw, header, "signing-secret", now + 300_001), false);
    assert.equal(await verifyRevenueCatWebhookSignature(raw, null, "signing-secret", now), false);
});

test("referral history reports roles, codes, and privacy-safe statuses", async () => {
    const database = {
        prepare: (sql: string) => new TestStatement(sql, {
            all: async parameters => {
                assert.deepEqual(parameters, ["account-1", "account-1"]);
                return {results: [
                    {
                        id: "referral-sent",
                        sender_account_id: "account-1",
                        status: "redeemed",
                        display_code: "DEMO-SENT",
                        claimed_at: "2026-07-16T10:00:00.000Z",
                        redeemed_at: "2026-07-16T10:05:00.000Z"
                    },
                    {
                        id: "referral-received",
                        sender_account_id: "account-2",
                        status: "offer_reserved",
                        display_code: "DEMO-RECEIVED",
                        claimed_at: "2026-07-15T10:00:00.000Z",
                        redeemed_at: null
                    }
                ]};
            }
        })
    };

    assert.deepEqual(await referralHistory(testEnv(database), "account-1"), [
        {
            id: "referral-sent",
            role: "sent",
            status: "redeemed",
            code: "DEMO-SENT",
            claimedAt: "2026-07-16T10:00:00.000Z",
            redeemedAt: "2026-07-16T10:05:00.000Z"
        },
        {
            id: "referral-received",
            role: "received",
            status: "pending",
            code: "DEMO-RECEIVED",
            claimedAt: "2026-07-15T10:00:00.000Z"
        }
    ]);
});

test("active offer-code reservations resume with the same code", async () => {
    const encryptedCode = await encryptOfferCode(
        testEnv({}).OFFER_CODE_ENCRYPTION_KEY,
        "SAME-OFFER-CODE"
    );
    const database = {
        prepare: (sql: string) => new TestStatement(sql, {
            first: async parameters => {
                if (sql.includes("FROM redemptions r LEFT JOIN credit_ledger")) {
                    assert.equal(parameters[0], "reservation-1");
                    assert.equal(parameters[1], "account-1");
                    return {
                        id: "reservation-1",
                        fulfillment_type: "offer_code",
                        configured_product: "monthly",
                        apple_offer_reference: "recipient-monthly",
                        status: "presented",
                        expires_at: "2030-01-01T00:00:00Z",
                        credit_quantity: 1
                    };
                }
                if (sql.includes("SELECT encrypted_code FROM offer_code_inventory")) {
                    assert.equal(parameters[0], "reservation-1");
                    return {encrypted_code: encryptedCode};
                }
                return null;
            }
        })
    };

    const first = await activeReservationByID(testEnv(database), "account-1", "reservation-1");
    const second = await activeReservationByID(testEnv(database), "account-1", "reservation-1");
    assert.equal(first.offerCode, "SAME-OFFER-CODE");
    assert.equal(second.offerCode, first.offerCode);
});

test("failed webhook events are reacquired, processed events deduplicate, and payload drift is rejected", async () => {
    const failed = new WebhookClaimDatabase({
        payload_hash: "payload-hash",
        processing_status: "failed",
        processed_at: "2026-01-01T00:00:00Z"
    });
    const retried = await claimWebhookEvent(testEnv(failed), event(), "payload-hash", "2026-07-14T00:00:00Z");
    assert.equal(retried.state, "acquired");
    assert.equal(failed.updateCount, 1);

    const processed = new WebhookClaimDatabase({
        payload_hash: "payload-hash",
        processing_status: "processed",
        processed_at: "2026-07-14T00:00:00Z"
    });
    assert.deepEqual(
        await claimWebhookEvent(testEnv(processed), event(), "payload-hash", "2026-07-14T00:00:00Z"),
        {state: "processed"}
    );

    const mismatch = new WebhookClaimDatabase({
        payload_hash: "original-hash",
        processing_status: "failed",
        processed_at: "2026-01-01T00:00:00Z"
    });
    await assert.rejects(
        claimWebhookEvent(testEnv(mismatch), event(), "different-hash", "2026-07-14T00:00:00Z"),
        (error: unknown) => error instanceof HTTPError && error.code === "webhook_payload_mismatch"
    );
});

test("webhook account resolution accepts aliases and rejects ambiguous identity families", async () => {
    const aliasOnly = new AccountResolutionDatabase([], [{id: "account-1"}]);
    assert.deepEqual(
        await resolveWebhookAccount(testEnv(aliasOnly), event({aliases: ["legacy-recipient-id"]})),
        {id: "account-1"}
    );

    const ambiguous = new AccountResolutionDatabase([{id: "account-1"}], [{id: "account-2"}]);
    await assert.rejects(
        resolveWebhookAccount(testEnv(ambiguous), event({aliases: ["other-family"]})),
        (error: unknown) => error instanceof HTTPError && error.code === "ambiguous_customer_identity"
    );

    const originalIdentity = new AccountResolutionDatabase([{id: "account-3"}], []);
    assert.deepEqual(
        await resolveWebhookAccount(testEnv(originalIdentity), event({
            app_user_id: "rotated-recipient-id",
            original_app_user_id: "original-recipient-id",
            aliases: []
        })),
        {id: "account-3"}
    );
    assert(originalIdentity.directParameters.includes("original-recipient-id"));

    assert.equal(
        await processRevenueCatEvent(
            testEnv(new AccountResolutionDatabase([], [])),
            event({
                type: "BILLING_ISSUE",
                app_user_id: "unregistered-customer",
                transaction_id: undefined,
                offer_code: undefined
            }),
            "2026-07-14T00:00:00Z"
        ),
        "unregistered_customer"
    );
    await assert.rejects(
        processRevenueCatEvent(
            testEnv(new AccountResolutionDatabase([{id: "account-1"}], [{id: "account-2"}])),
            event({type: "BILLING_ISSUE", aliases: ["other-family"]}),
            "2026-07-14T00:00:00Z"
        ),
        (error: unknown) => error instanceof HTTPError && error.code === "ambiguous_customer_identity"
    );
    await assert.rejects(
        processRevenueCatEvent(
            testEnv(new AccountResolutionDatabase([], [])),
            event({app_user_id: "unregistered-customer"}),
            "2026-07-14T00:00:00Z"
        ),
        (error: unknown) => error instanceof HTTPError && error.code === "unknown_customer"
    );
    await assert.rejects(
        processRevenueCatEvent(
            testEnv(new AccountResolutionDatabase([], [], true)),
            event({
                type: "REFUND",
                app_user_id: "rotated-customer",
                offer_code: undefined
            }),
            "2026-07-14T00:00:00Z"
        ),
        (error: unknown) => error instanceof HTTPError && error.code === "unknown_customer"
    );
});

test("registration adopts one alias family and rejects ambiguity before writing", async () => {
    const adopted = new RegistrationResolutionDatabase(
        [],
        [{alias_hash: "mapped-hash", id: "existing-account"}]
    );
    const resolution = await resolveRegistrationAccount(
        testEnv(adopted),
        "rotated-recipient-id",
        "original-recipient-id",
        ["legacy-recipient-id"]
    );
    assert.equal(resolution.accountID, "existing-account");
    assert.equal(adopted.writeAttempts, 0);

    const ambiguous = new RegistrationResolutionDatabase(
        [{id: "direct-account"}],
        [{alias_hash: "mapped-hash", id: "different-account"}]
    );
    await assert.rejects(
        resolveRegistrationAccount(
            testEnv(ambiguous),
            "rotated-recipient-id",
            "original-recipient-id",
            []
        ),
        (error: unknown) => error instanceof HTTPError && error.code === "ambiguous_customer_identity"
    );
    assert.equal(ambiguous.writeAttempts, 0);
});

test("signed authentication resolves aliases and rejects cross-account ambiguity", async () => {
    const aliasDevice = {id: "device-1", account_id: "account-1", public_key_jwk: "key"};
    const aliasOnly = new AuthenticationResolutionDatabase([aliasDevice]);
    assert.deepEqual(
        await registeredDevicesForIdentity(testEnv(aliasOnly), "rotated-recipient-id"),
        [aliasDevice]
    );
    assert.equal(aliasOnly.boundIdentity, "rotated-recipient-id");
    assert.notEqual(aliasOnly.boundIdentityHash, "rotated-recipient-id");

    const ambiguous = new AuthenticationResolutionDatabase([
        aliasDevice,
        {id: "device-2", account_id: "account-2", public_key_jwk: "key"}
    ]);
    await assert.rejects(
        registeredDevicesForIdentity(testEnv(ambiguous), "shared-alias"),
        (error: unknown) => error instanceof HTTPError && error.code === "ambiguous_customer_identity"
    );
});

test("RevenueCat dashboard test events are acknowledged without customer lookup", async () => {
    const database = {
        prepare() {
            throw new Error("TEST events must not query customer state");
        }
    };
    assert.equal(
        await processRevenueCatEvent(
            testEnv(database),
            event({type: "TEST", app_user_id: "dashboard-test-customer"}),
            "2026-07-14T00:00:00Z"
        ),
        "test_event"
    );
});

test("authenticated unregistered RevenueCat customers are acknowledged as ignored", async () => {
    const raw = JSON.stringify({event: event({
        id: "unregistered-event",
        type: "BILLING_ISSUE",
        app_user_id: "unregistered-customer",
        transaction_id: undefined,
        offer_code: undefined
    })});
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = await hmac("test-signing-secret", `${timestamp}.${raw}`);
    const database = new UnregisteredWebhookDatabase();
    const response = await route(new Request("https://staging.example.com/v1/revenuecat/webhooks", {
        method: "POST",
        headers: {
            authorization: "Bearer test-webhook-secret",
            "content-type": "application/json",
            "x-revenuecat-webhook-signature": `t=${timestamp},v1=${signature}`
        },
        body: raw
    }), testEnv(database));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        ok: true,
        ignored: true,
        reason: "unregistered_customer"
    });
    assert.equal(database.processedUpdates, 1);
});

test("promotional offer redemption matches RevenueCat discount identifier", async () => {
    const database = new EventProcessingDatabase({
        purchase: true,
        fulfillmentType: "promotional_offer",
        configuredProduct: "yearly",
        offerReference: "sender-yearly-1",
        referralID: null
    });
    const processingResult = await processRevenueCatEvent(
        testEnv(database),
        event({
            type: "RENEWAL",
            product_id: "example_pro_yearly",
            offer_code: undefined,
            discount_identifier: "sender-yearly-1",
            presented_offering_id: "default"
        }),
        "2026-07-14T00:00:00Z"
    );
    assert.equal(processingResult, "processed");
    assert.equal(database.confirmedRedemptionCount, 1);
});

test("an unrelated purchase does not consume an active redemption", async () => {
    const database = new EventProcessingDatabase({purchase: true});
    await assert.rejects(
        processRevenueCatEvent(
            testEnv(database),
            event({offer_code: "unrelated-offer"}),
            "2026-07-14T00:00:00Z"
        ),
        (error: unknown) => error instanceof HTTPError && error.code === "redemption_event_mismatch"
    );
    assert.equal(database.confirmedRedemptionCount, 0);
});

test("unsubscribe and billing errors preserve credit while support refunds reverse conditionally", async () => {
    const unsubscribe = new EventProcessingDatabase({earned: true});
    await processRevenueCatEvent(
        testEnv(unsubscribe),
        event({type: "CANCELLATION", cancel_reason: "UNSUBSCRIBE"}),
        "2026-07-14T00:00:00Z"
    );
    assert.equal(unsubscribe.reversalInsertAttempts, 0);

    const billingError = new EventProcessingDatabase({earned: true});
    await processRevenueCatEvent(
        testEnv(billingError),
        event({type: "BILLING_ISSUE", cancel_reason: "BILLING_ERROR"}),
        "2026-07-14T00:00:00Z"
    );
    assert.equal(billingError.reversalInsertAttempts, 0);

    const refund = new EventProcessingDatabase({earned: true});
    const refundEvent = event({type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT"});
    await processRevenueCatEvent(testEnv(refund), refundEvent, "2026-07-14T00:00:00Z");
    await processRevenueCatEvent(testEnv(refund), refundEvent, "2026-07-14T00:01:00Z");
    assert.equal(refund.reversalInsertAttempts, 2);
    assert.equal(refund.reversalCount, 1);

    const cappedWithoutEarn = new EventProcessingDatabase({earned: false});
    await processRevenueCatEvent(
        testEnv(cappedWithoutEarn),
        refundEvent,
        "2026-07-14T00:00:00Z"
    );
    assert.equal(cappedWithoutEarn.reversalCount, 0);
});

test("refund reversal compensates once only after an actual credit reversal", async () => {
    const ledger = new EventProcessingDatabase({earned: true});
    await processRevenueCatEvent(
        testEnv(ledger),
        event({type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT"}),
        "2026-07-14T00:00:00Z"
    );
    await processRevenueCatEvent(
        testEnv(ledger),
        event({type: "REFUND_REVERSED"}),
        "2026-07-14T00:01:00Z"
    );
    await processRevenueCatEvent(
        testEnv(ledger),
        event({type: "REFUND_REVERSED"}),
        "2026-07-14T00:02:00Z"
    );
    assert.equal(ledger.reversalCount, 1);
    assert.equal(ledger.refundRestorationCount, 1);

    const neverReversed = new EventProcessingDatabase({earned: true});
    await processRevenueCatEvent(
        testEnv(neverReversed),
        event({type: "REFUND_REVERSED"}),
        "2026-07-14T00:01:00Z"
    );
    assert.equal(neverReversed.refundRestorationCount, 0);
});

test("lifetime and reward caps suppress sender credit while confirming the referral", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({subscriber: {
        first_seen: "2026-01-01T00:00:00Z",
        non_subscriptions: {
            example_pro_lifetime: [{purchase_date: "2026-01-01", environment: "SANDBOX"}]
        }
    }}), {status: 200});
    try {
        const lifetime = new EventProcessingDatabase({purchase: true, senderLifetime: true});
        await processRevenueCatEvent(testEnv(lifetime), event(), "2026-07-14T00:00:00Z");
        assert.equal(lifetime.confirmedRedemptionCount, 1);
        assert.equal(lifetime.redeemedReferralCount, 1);
        assert.equal(lifetime.earnedInsertCount, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }

    globalThis.fetch = async () => new Response(JSON.stringify({subscriber: {
        first_seen: "2026-01-01T00:00:00Z",
        subscriptions: {}
    }}), {status: 200});
    try {
        const bankCap = new EventProcessingDatabase({purchase: true, balance: 24});
        await processRevenueCatEvent(testEnv(bankCap), event(), "2026-07-14T00:00:00Z");
        assert.equal(bankCap.earnedInsertCount, 0);

        const rollingCap = new EventProcessingDatabase({purchase: true, recentEarned: 10});
        await processRevenueCatEvent(testEnv(rollingCap), event(), "2026-07-14T00:00:00Z");
        assert.equal(rollingCap.earnedInsertCount, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("lost response recovery persists an encrypted fulfillment and rejects operation payload drift", async () => {
    const keyPair = await crypto.subtle.generateKey(
        {name: "ECDSA", namedCurve: "P-256"},
        true,
        ["sign", "verify"]
    );
    const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keyPair.publicKey)).toString("base64");
    const database = new RouteRecoveryDatabase(publicKey);
    const env = testEnv(database, {enabled: false, redemptionEnabled: true});
    database.inventoryCiphertext = await encryptOfferCode(env.OFFER_CODE_ENCRYPTION_KEY, "KNOWN-OFFER-CODE");

    const first = await route(await signedClaimRequest(
        keyPair.privateKey,
        "operation-recovery-1",
        "request-nonce-first-0001",
        "DEMO-2345-6789-ABCD"
    ), env);
    assert.equal(first.status, 201);
    const firstValue = await first.json<any>();
    assert.equal(firstValue.offerCode, "KNOWN-OFFER-CODE");
    assert.equal(database.reservationReadCount, 1);
    assert.ok(database.persistedResponse?.startsWith("v1."));
    assert.equal(database.persistedResponse?.includes("KNOWN-OFFER-CODE"), false);
    const decrypted = JSON.parse(await decryptOfferCode(
        env.OFFER_CODE_ENCRYPTION_KEY,
        database.persistedResponse!
    ));
    assert.deepEqual(decrypted, firstValue);

    const retry = await route(await signedClaimRequest(
        keyPair.privateKey,
        "operation-recovery-1",
        "request-nonce-retry-0002",
        "DEMO-2345-6789-ABCD"
    ), env);
    assert.equal(retry.status, 201);
    assert.deepEqual(await retry.json(), firstValue);
    assert.equal(database.reservationReadCount, 1);

    const retryWithNewOperation = await route(await signedClaimRequest(
        keyPair.privateKey,
        "operation-retry-after-app-store-back-2",
        "request-nonce-retry-after-back-0003",
        "DEMO-2345-6789-ABCD"
    ), env);
    assert.equal(retryWithNewOperation.status, 201);
    assert.deepEqual(await retryWithNewOperation.json(), firstValue);
    assert.equal(database.pendingReservationReadCount, 1);

    await assert.rejects(
        route(await signedClaimRequest(
            keyPair.privateKey,
            "operation-recovery-1",
            "request-nonce-drift-0003",
            "DEMO-BCDE-FGHJ-KMNP"
        ), env),
        (error: unknown) => error instanceof HTTPError && error.code === "idempotency_key_reused"
    );
});

test("device revocation is self-only at the public route", async () => {
    const keyPair = await crypto.subtle.generateKey(
        {name: "ECDSA", namedCurve: "P-256"},
        true,
        ["sign", "verify"]
    );
    const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keyPair.publicKey)).toString("base64");
    const env = testEnv(new RouteRecoveryDatabase(publicKey));

    await assert.rejects(
        route(await signedDeviceRevocationRequest(
            keyPair.privateKey,
            {deviceID: "another-device"},
            "request-nonce-device-target-0001"
        ), env),
        (error: unknown) => error instanceof HTTPError && error.code === "device_target_not_supported"
    );
    const response = await route(await signedDeviceRevocationRequest(
        keyPair.privateKey,
        {},
        "request-nonce-device-self-0002"
    ), env);
    assert.equal(response.status, 200);
});

type WebhookRow = {payload_hash: string; processing_status: string; processed_at: string | null};

class WebhookClaimDatabase {
    updateCount = 0;

    constructor(private row: WebhookRow | null) {}

    prepare(sql: string) {
        return new TestStatement(sql, {
            first: async () => sql.includes("SELECT payload_hash") ? this.row : null,
            run: async (parameters) => {
                if (sql.includes("INSERT INTO webhook_events")) {
                    this.row = {
                        payload_hash: String(parameters[3]),
                        processing_status: "processing",
                        processed_at: String(parameters[6])
                    };
                    return result(1);
                }
                if (sql.includes("UPDATE webhook_events SET processing_status='processing'")) {
                    this.updateCount += 1;
                    if (this.row) {
                        this.row.processing_status = "processing";
                        this.row.processed_at = String(parameters[0]);
                    }
                    return result(1);
                }
                return result(0);
            }
        });
    }
}

class UnregisteredWebhookDatabase {
    processedUpdates = 0;
    private row: WebhookRow | null = null;

    prepare(sql: string) {
        return new TestStatement(sql, {
            all: async () => ({results: []}),
            first: async () => {
                if (sql.includes("SELECT payload_hash")) return this.row;
                if (sql.includes("SELECT 1 present")) return this.row ? {present: 1} : null;
                return null;
            },
            run: async parameters => {
                if (sql.includes("INSERT INTO webhook_events")) {
                    this.row = {
                        payload_hash: String(parameters[3]),
                        processing_status: "processing",
                        processed_at: String(parameters[6])
                    };
                    return result(1);
                }
                if (sql.includes("SET processing_status='processed'")) {
                    this.processedUpdates += 1;
                    if (this.row) {
                        this.row.processing_status = "processed";
                        this.row.processed_at = String(parameters[0]);
                    }
                    return result(1);
                }
                return result(0);
            }
        });
    }
}

class AccountResolutionDatabase {
    directParameters: unknown[] = [];

    constructor(
        private direct: Array<{id: string}>,
        private aliases: Array<{id: string}>,
        private knownTransaction = false
    ) {}

    prepare(sql: string) {
        return new TestStatement(sql, {
            all: async parameters => {
                if (sql.includes("FROM referral_accounts")) {
                    this.directParameters = parameters;
                    return {results: this.direct};
                }
                return {results: this.aliases};
            },
            first: async () => sql.includes("FROM redemptions") && this.knownTransaction
                ? {present: 1}
                : null
        });
    }
}

class RegistrationResolutionDatabase {
    writeAttempts = 0;

    constructor(
        private direct: Array<{id: string}>,
        private aliases: Array<{alias_hash: string; id: string}>
    ) {}

    prepare(sql: string) {
        if (!sql.startsWith("SELECT")) this.writeAttempts += 1;
        return {
            bind: (..._parameters: unknown[]) => ({
                all: async () => ({
                    results: sql.includes("FROM referral_accounts") ? this.direct : this.aliases
                })
            })
        };
    }
}

class AuthenticationResolutionDatabase {
    boundIdentity = "";
    boundIdentityHash = "";

    constructor(private devices: Array<{id: string; account_id: string; public_key_jwk: string}>) {}

    prepare(_sql: string) {
        return {
            bind: (identity: string, identityHash: string) => {
                this.boundIdentity = identity;
                this.boundIdentityHash = identityHash;
                return {all: async () => ({results: this.devices})};
            }
        };
    }
}

class EventProcessingDatabase {
    reversalInsertAttempts = 0;
    reversalCount = 0;
    refundRestorationCount = 0;
    confirmedRedemptionCount = 0;
    redeemedReferralCount = 0;
    earnedInsertCount = 0;
    private reversed = false;
    private restored = false;
    private adjustmentState: string | null = null;
    private options: {
        earned: boolean;
        purchase: boolean;
        senderLifetime: boolean;
        balance: number;
        recentEarned: number;
        fulfillmentType: "offer_code" | "promotional_offer";
        configuredProduct: "monthly" | "yearly";
        offerReference: string;
        referralID: string | null;
    };

    constructor(options: Partial<EventProcessingDatabase["options"]> = {}) {
        this.options = {
            earned: false,
            purchase: false,
            senderLifetime: false,
            balance: 0,
            recentEarned: 0,
            fulfillmentType: "offer_code",
            configuredProduct: "monthly",
            offerReference: "recipient-monthly",
            referralID: "referral-1",
            ...options
        };
    }

    prepare(sql: string) {
        return new TestStatement(sql, {
            all: async () => {
                if (sql.includes("SELECT DISTINCT r.* FROM redemptions")) {
                    return {results: this.options.purchase ? [{
                        id: "redemption-1",
                        fulfillment_type: this.options.fulfillmentType,
                        configured_product: this.options.configuredProduct,
                        apple_offer_reference: this.options.offerReference,
                        referral_id: this.options.referralID
                    }] : []};
                }
                return {results: sql.includes("FROM referral_accounts") ? [{id: "recipient-account"}] : []};
            },
            first: async () => {
                if (sql.includes("SELECT state FROM transaction_adjustments")) {
                    return this.adjustmentState ? {state: this.adjustmentState} : null;
                }
                if (sql.includes("JOIN referral_accounts")) {
                    return {
                        id: "sender-account",
                        revenuecat_customer_id: "sender-rc-id",
                        lifetime_status: this.options.senderLifetime ? 1 : 0
                    };
                }
                if (sql.includes("COALESCE(SUM(quantity)")) return {balance: this.options.balance};
                if (sql.includes("SELECT COUNT(*) count FROM credit_ledger")) {
                    return {count: this.options.recentEarned};
                }
                if (sql.includes("WHERE revenuecat_transaction_id")) {
                    return {id: "redemption-1", referral_id: "referral-1"};
                }
                if (sql.includes("SELECT sender_account_id FROM referrals")) {
                    return {sender_account_id: "sender-account"};
                }
                return null;
            },
            run: async parameters => {
                if (sql.includes("INSERT INTO transaction_adjustments")) {
                    this.adjustmentState = String(parameters[1]);
                    return result(1);
                }
                if (sql.includes("entry_type,quantity") && sql.includes("SELECT ?,?,?,?,-1")) {
                    this.reversalInsertAttempts += 1;
                    if (this.options.earned && !this.reversed) {
                        this.reversed = true;
                        this.reversalCount += 1;
                        return result(1);
                    }
                    return result(0);
                }
                if (sql.includes("entry_type,quantity") && sql.includes("SELECT ?,?,?,?,1")) {
                    if (this.reversed && !this.restored) {
                        this.restored = true;
                        this.refundRestorationCount += 1;
                        return result(1);
                    }
                    return result(0);
                }
                if (sql.includes("entry_type,quantity") && sql.includes("VALUES(?,?,?,?,?,?,?)")) {
                    this.earnedInsertCount += 1;
                }
                if (sql.includes("UPDATE redemptions SET status='confirmed'")) {
                    this.confirmedRedemptionCount += 1;
                }
                if (sql.includes("UPDATE referrals SET status='redeemed'")) {
                    this.redeemedReferralCount += 1;
                }
                return result(1);
            }
        });
    }

    async batch(statements: Array<{run(): Promise<unknown>}>) {
        return Promise.all(statements.map(statement => statement.run()));
    }
}

class RouteRecoveryDatabase {
    inventoryCiphertext = "";
    persistedResponse: string | undefined;
    reservationReadCount = 0;
    pendingReservationReadCount = 0;
    private idempotencyResponses = new Map<string, {requestHash: string; status: number; response: string}>();

    constructor(private publicKey: string) {}

    prepare(sql: string) {
        return new TestStatement(sql, {
            all: async () => {
                if (sql.includes("FROM registered_devices")) {
                    return {results: [{id: "device-1", account_id: "recipient-account", public_key_jwk: this.publicKey}]};
                }
                return {results: []};
            },
            first: async parameters => {
                if (sql.includes("SELECT revenuecat_customer_id FROM referral_accounts")) {
                    return {revenuecat_customer_id: "recipient-rc-id"};
                }
                if (sql.includes("SELECT request_hash,status,response_json FROM idempotency_responses")) {
                    const response = this.idempotencyResponses.get(String(parameters[1]));
                    return response ? {
                        request_hash: response.requestHash,
                        status: response.status,
                        response_json: response.response
                    } : null;
                }
                if (sql.includes("FROM redemptions r LEFT JOIN credit_ledger")) {
                    if (sql.includes("r.status IN ('reserved','presented')")) {
                        this.pendingReservationReadCount += 1;
                    } else {
                        this.reservationReadCount += 1;
                        if (parameters[1] !== "operation-recovery-1") return null;
                    }
                    return {
                        id: "reservation-recovered",
                        fulfillment_type: "offer_code",
                        configured_product: "monthly",
                        apple_offer_reference: "recipient-monthly",
                        status: "reserved",
                        expires_at: "2030-01-01T00:00:00Z",
                        credit_quantity: 1
                    };
                }
                if (sql.includes("SELECT encrypted_code FROM offer_code_inventory")) {
                    return {encrypted_code: this.inventoryCiphertext};
                }
                return null;
            },
            run: async (parameters) => {
                if (sql.includes("INSERT OR IGNORE INTO idempotency_responses")) {
                    const response = String(parameters[4]);
                    this.persistedResponse = response;
                    this.idempotencyResponses.set(String(parameters[1]), {
                        requestHash: String(parameters[2]),
                        status: Number(parameters[3]),
                        response
                    });
                }
                return result(1);
            }
        });
    }
}

async function signedClaimRequest(
    privateKey: CryptoKey,
    operationID: string,
    nonce: string,
    code: string
): Promise<Request> {
    const url = "https://staging.example.com/v1/referrals/claim";
    const body = JSON.stringify({code});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const canonical = ["POST", "/v1/referrals/claim", await sha256(body), timestamp, nonce].join("\n");
    const signature = await crypto.subtle.sign(
        {name: "ECDSA", hash: "SHA-256"},
        privateKey,
        new TextEncoder().encode(canonical)
    );
    return new Request(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": operationID,
            "X-Demo-Identity": "recipient-rc-id",
            "X-Demo-Timestamp": timestamp,
            "X-Demo-Nonce": nonce,
            "X-Demo-Signature": Buffer.from(signature).toString("base64")
        },
        body
    });
}

async function signedDeviceRevocationRequest(
    privateKey: CryptoKey,
    value: Record<string, string>,
    nonce: string
): Promise<Request> {
    const url = "https://staging.example.com/v1/devices/revoke";
    const body = JSON.stringify(value);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const canonical = ["POST", "/v1/devices/revoke", await sha256(body), timestamp, nonce].join("\n");
    const signature = await crypto.subtle.sign(
        {name: "ECDSA", hash: "SHA-256"},
        privateKey,
        new TextEncoder().encode(canonical)
    );
    return new Request(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Demo-Identity": "recipient-rc-id",
            "X-Demo-Timestamp": timestamp,
            "X-Demo-Nonce": nonce,
            "X-Demo-Signature": Buffer.from(signature).toString("base64")
        },
        body
    });
}

type StatementHandlers = {
    first?: (parameters: unknown[]) => Promise<unknown>;
    all?: (parameters: unknown[]) => Promise<{results: unknown[]}>;
    run?: (parameters: unknown[]) => Promise<unknown>;
};

class TestStatement {
    private parameters: unknown[] = [];

    constructor(readonly sql: string, private handlers: StatementHandlers) {}

    bind(...parameters: unknown[]) {
        this.parameters = parameters;
        return this;
    }

    async first<T>(): Promise<T | null> {
        return (await this.handlers.first?.(this.parameters) ?? null) as T | null;
    }

    async all<T>(): Promise<{results: T[]}> {
        return (await this.handlers.all?.(this.parameters) ?? {results: []}) as {results: T[]};
    }

    async run() {
        return await this.handlers.run?.(this.parameters) ?? result(0);
    }
}

function result(changes: number) {
    return {success: true, meta: {changes}};
}
