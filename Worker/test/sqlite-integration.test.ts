import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync, type SQLInputValue} from "node:sqlite";
import test from "node:test";
import {createCode, claim, pendingReservationForAccount, rejectRecipientOfferCodeAsIneligible, releaseExpired} from "../src/domain";
import {encryptOfferCode, hmac, sha256} from "../src/crypto";
import {Env, ReferralConfig} from "../src/env";
import {enforceRegistrationChallengeRateLimit, processRevenueCatEvent, revokeDevice, route} from "../src/index";
import {importOfferCodes, releaseOfferCode, reserveOfferCode} from "../src/inventory";
import {RCEvent} from "../src/revenuecat";

class SQLiteStatement {
    private parameters: SQLInputValue[] = [];

    constructor(private database: DatabaseSync, private sql: string) {}

    bind(...parameters: unknown[]) {
        this.parameters = parameters as SQLInputValue[];
        return this;
    }

    async first<T>(): Promise<T | null> {
        return (this.database.prepare(this.sql).get(...this.parameters) as T | undefined) ?? null;
    }

    async all<T>(): Promise<{results: T[]}> {
        return {results: this.database.prepare(this.sql).all(...this.parameters) as T[]};
    }

    async run() {
        return this.runSynchronously();
    }

    runSynchronously() {
        const result = this.database.prepare(this.sql).run(...this.parameters);
        return {success: true, meta: {changes: Number(result.changes)}};
    }
}

class SQLiteD1 {
    readonly raw = new DatabaseSync(":memory:");

    constructor(migrations = ["0001_initial.sql", "0002_registration_challenges.sql", "0003_launch_hardening.sql", "0004_rolling_upgrade_compatibility.sql"]) {
        for (const migration of migrations) {
            this.raw.exec(readFileSync(join(process.cwd(), "migrations", migration), "utf8"));
        }
        this.raw.exec("PRAGMA foreign_keys = ON");
    }

    prepare(sql: string) {
        return new SQLiteStatement(this.raw, sql);
    }

    async batch(statements: SQLiteStatement[]) {
        this.raw.exec("BEGIN IMMEDIATE");
        try {
            const results = statements.map(statement => statement.runSynchronously());
            this.raw.exec("COMMIT");
            return results;
        } catch (error) {
            this.raw.exec("ROLLBACK");
            throw error;
        }
    }
}

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

function environment(database: SQLiteD1): Env {
    return {
        DB: database as unknown as D1Database,
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
        REVENUECAT_SECRET_KEY: "secret",
        REVENUECAT_WEBHOOK_SECRET: "webhook",
        REVENUECAT_WEBHOOK_SIGNING_SECRET: "signing-secret",
        REVENUECAT_TRANSACTION_ENVIRONMENT: "SANDBOX",
        REVENUECAT_ENTITLEMENT: "Example Pro",
        MONTHLY_PRODUCT_ID: "example_pro_monthly",
        YEARLY_PRODUCT_ID: "example_pro_yearly",
        LIFETIME_PRODUCT_IDS: "example_pro_lifetime",
        RECIPIENT_MONTHLY_OFFER_ID: "recipient-monthly-resource",
        RECIPIENT_YEARLY_OFFER_ID: "recipient-yearly-resource",
        RECIPIENT_MONTHLY_OFFER_REFERENCE_NAME: "Recipient Monthly Reference",
        RECIPIENT_YEARLY_OFFER_REFERENCE_NAME: "Recipient Yearly Reference",
        SENDER_MONTHLY_PROMOTIONAL_OFFER_ID: "sender-m1",
        SENDER_YEARLY_PROMOTIONAL_OFFER_ID: "sender-y1",
        SENDER_MONTHLY_PROMOTIONAL_OFFER_2_MONTHS_ID: "sender-m2",
        SENDER_YEARLY_PROMOTIONAL_OFFER_2_MONTHS_ID: "sender-y2",
        SENDER_MONTHLY_PROMOTIONAL_OFFER_3_MONTHS_ID: "sender-m3",
        SENDER_YEARLY_PROMOTIONAL_OFFER_3_MONTHS_ID: "sender-y3",
        SENDER_MONTHLY_PROMOTIONAL_OFFER_6_MONTHS_ID: "sender-m6",
        SENDER_YEARLY_PROMOTIONAL_OFFER_6_MONTHS_ID: "sender-y6",
        SENDER_MONTHLY_PROMOTIONAL_OFFER_12_MONTHS_ID: "sender-m12",
        SENDER_YEARLY_PROMOTIONAL_OFFER_12_MONTHS_ID: "sender-y12",
        SENDER_NEW_MONTHLY_OFFER_ID: "sender-new-monthly-resource",
        SENDER_NEW_YEARLY_OFFER_ID: "sender-new-yearly-resource",
        SENDER_NEW_MONTHLY_OFFER_REFERENCE_NAME: "Sender New Monthly Reference",
        SENDER_NEW_YEARLY_OFFER_REFERENCE_NAME: "Sender New Yearly Reference",
        CODE_HASH_SECRET: "code-secret",
        IDENTITY_HASH_SECRET: "identity-secret",
        OFFER_CODE_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        OFFER_CODE_IMPORT_SECRET: "import-secret",
        CONFIG_JSON: JSON.stringify(baseConfig)
    };
}

function addAccount(database: SQLiteD1, id: string, revenueCatID = id) {
    database.raw.prepare(
        "INSERT INTO referral_accounts(id,revenuecat_customer_id,identity_family_hash,created_at,updated_at) VALUES(?,?,?,?,?)"
    ).run(id, revenueCatID, `family-${id}`, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
}

async function addCode(database: SQLiteD1, env: Env, id: string, senderID: string, code: string) {
    database.raw.prepare(
        "INSERT INTO referral_codes(id,sender_account_id,code_hash,display_code,display_suffix,created_at) VALUES(?,?,?,?,?,?)"
    ).run(id, senderID, await hmac(env.CODE_HASH_SECRET, code), code, code.slice(-4), "2026-07-01T00:00:00.000Z");
}

async function addInventory(database: SQLiteD1, env: Env, id: string, reference: string, product: string, redemptionID: string, status = "assigned") {
    database.raw.prepare(
        "INSERT INTO offer_code_inventory(id,offer_reference,encrypted_code,product,status,reservation_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
    ).run(id, reference, await encryptOfferCode(env.OFFER_CODE_ENCRYPTION_KEY, `APPLECODE${id}`), product, status, redemptionID, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
}

function purchaseEvent(overrides: Partial<RCEvent> = {}): RCEvent {
    return {
        id: crypto.randomUUID(),
        type: "INITIAL_PURCHASE",
        app_user_id: "recipient-rc",
        transaction_id: crypto.randomUUID(),
        product_id: "example_pro_monthly",
        offer_code: "Recipient Monthly Reference",
        environment: "SANDBOX",
        purchased_at_ms: Date.parse("2026-07-14T10:15:00.000Z"),
        ...overrides
    };
}

async function withActiveSender<T>(operation: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({subscriber: {
        first_seen: "2026-01-01T00:00:00.000Z",
        subscriptions: {}
    }}));
    try { return await operation(); }
    finally { globalThis.fetch = originalFetch; }
}

test("concurrent code creation returns one durable sender code", async () => {
    const database = new SQLiteD1(), env = environment(database);
    addAccount(database, "sender");
    const [first, second] = await Promise.all([createCode(env, "sender"), createCode(env, "sender")]);
    assert.equal(first.code, second.code);
    assert.equal(database.raw.prepare("SELECT COUNT(*) count FROM referral_codes").get()!.count, 1);
});

test("rolling-upgrade triggers fill fields omitted by the previous Worker", () => {
    const database = new SQLiteD1(["0001_initial.sql", "0002_registration_challenges.sql", "0003_launch_hardening.sql"]);
    addAccount(database, "sender");
    addAccount(database, "recipient");
    database.raw.prepare(
        "INSERT INTO referral_codes(id,sender_account_id,code_hash,display_code,display_suffix,created_at) VALUES(?,?,?,?,?,?)"
    ).run("code", "sender", "hash", "DEMO-2345-6789-ABCD", "ABCD", "2026-07-14T10:00:00.000Z");
    database.raw.prepare(
        "INSERT INTO referrals(id,sender_account_id,recipient_account_id,referral_code_id,status,claimed_at) VALUES(?,?,?,?,?,?)"
    ).run("referral", "sender", "recipient", "code", "claimed", "2026-07-14T10:00:00.000Z");
    database.raw.prepare(
        "INSERT INTO redemptions(id,account_id,referral_id,fulfillment_type,configured_product,status,reserved_at,expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?)"
    ).run("redemption", "recipient", "referral", "offer_code", "monthly", "reserved", "2026-07-14T10:00:00.000Z", "2026-07-14T10:30:00.000Z", "operation-old-worker");
    assert.equal(database.raw.prepare("SELECT claim_expires_at FROM referrals WHERE id='referral'").get()!.claim_expires_at, null);

    database.raw.exec(readFileSync(join(process.cwd(), "migrations", "0004_rolling_upgrade_compatibility.sql"), "utf8"));

    assert.equal(
        database.raw.prepare("SELECT claim_expires_at FROM referrals WHERE id='referral'").get()!.claim_expires_at,
        "2026-07-15T10:00:00.000Z"
    );
    assert.equal(
        database.raw.prepare("SELECT reconciliation_expires_at FROM redemptions WHERE id='redemption'").get()!.reconciliation_expires_at,
        "2026-08-13T10:30:00.000Z"
    );

    addAccount(database, "recipient-after-migration");
    database.raw.prepare(
        "INSERT INTO referrals(id,sender_account_id,recipient_account_id,referral_code_id,status,claimed_at) VALUES(?,?,?,?,?,?)"
    ).run("referral-after-migration", "sender", "recipient-after-migration", "code", "claimed", "2026-07-14T11:00:00.000Z");
    database.raw.prepare(
        "INSERT INTO redemptions(id,account_id,referral_id,fulfillment_type,configured_product,status,reserved_at,expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?)"
    ).run("redemption-after-migration", "recipient-after-migration", "referral-after-migration", "offer_code", "monthly", "reserved", "2026-07-14T11:00:00.000Z", "2026-07-14T11:30:00.000Z", "operation-after-migration");
    assert.equal(
        database.raw.prepare("SELECT claim_expires_at FROM referrals WHERE id='referral-after-migration'").get()!.claim_expires_at,
        "2026-07-15T11:00:00.000Z"
    );
    assert.equal(
        database.raw.prepare("SELECT reconciliation_expires_at FROM redemptions WHERE id='redemption-after-migration'").get()!.reconciliation_expires_at,
        "2026-08-13T11:30:00.000Z"
    );
});

test("health permits a disabled-first deployment while reporting inventory readiness", async () => {
    const database = new SQLiteD1(), env = environment(database);
    env.CONFIG_JSON = JSON.stringify({...baseConfig, enabled: false});
    const disabled = await route(new Request("https://staging.example.com/health"), env);
    assert.equal(disabled.status, 200);
    assert.deepEqual(await disabled.json(), {
        ok: true,
        readyForEnrollment: false,
        environment: "staging",
        issues: [],
        readinessIssues: ["offer_code_inventory"]
    });

    const inventory = [
        ["recipient-monthly", env.RECIPIENT_MONTHLY_OFFER_ID, "yearly"],
        ["recipient-yearly", env.RECIPIENT_YEARLY_OFFER_ID, "yearly"],
        ["sender-monthly", env.SENDER_NEW_MONTHLY_OFFER_ID, "monthly"],
        ["sender-yearly", env.SENDER_NEW_YEARLY_OFFER_ID, "yearly"]
    ];
    for (const [id, reference, product] of inventory) {
        database.raw.prepare(
            "INSERT INTO offer_code_inventory(id,offer_reference,encrypted_code,product,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
        ).run(id, reference, "ciphertext", product, "available", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    }
    const wrongProduct = await route(new Request("https://staging.example.com/health"), env);
    assert.equal((await wrongProduct.json<any>()).readyForEnrollment, false);
    database.raw.prepare("UPDATE offer_code_inventory SET product='monthly' WHERE id='recipient-monthly'").run();
    const ready = await route(new Request("https://staging.example.com/health"), env);
    assert.equal((await ready.json<any>()).readyForEnrollment, true);

    env.CONFIG_JSON = JSON.stringify(baseConfig);
    const enabled = await route(new Request("https://staging.example.com/health"), env);
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json<any>()).readyForEnrollment, true);
});

test("registration challenges are rate limited per customer identity", async () => {
    const database = new SQLiteD1(), env = environment(database);
    const request = new Request("https://staging.example.com/v1/devices/registration-challenges", {method: "POST"});
    for (let attempt = 0; attempt < 5; attempt++) {
        await enforceRegistrationChallengeRateLimit(request, env, "customer-1");
    }
    await assert.rejects(
        enforceRegistrationChallengeRateLimit(request, env, "customer-1"),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "registration_rate_limited"
    );
    await enforceRegistrationChallengeRateLimit(request, env, "customer-2");
});

test("device revocation is restricted to the authenticated account", async () => {
    const database = new SQLiteD1(), env = environment(database);
    addAccount(database, "account-1");
    addAccount(database, "account-2");
    database.raw.prepare(
        "INSERT INTO registered_devices(id,account_id,public_key_jwk,key_version,created_at,last_seen_at) VALUES(?,?,?,?,?,?)"
    ).run("device-1", "account-1", "key-1", 1, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    database.raw.prepare(
        "INSERT INTO registered_devices(id,account_id,public_key_jwk,key_version,created_at,last_seen_at) VALUES(?,?,?,?,?,?)"
    ).run("device-2", "account-2", "key-2", 1, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    await assert.rejects(revokeDevice(env, "account-1", "device-2"));
    await revokeDevice(env, "account-1", "device-1");
    assert.equal(database.raw.prepare("SELECT revoked_at FROM registered_devices WHERE id='device-1'").get()!.revoked_at !== null, true);
});

test("abandoned claims expire and no longer permanently lock the recipient", async () => {
    const database = new SQLiteD1(), env = environment(database);
    addAccount(database, "sender-1");
    addAccount(database, "sender-2");
    addAccount(database, "recipient");
    await addCode(database, env, "code-1", "sender-1", "DEMO-2345-6789-ABCD");
    await addCode(database, env, "code-2", "sender-2", "DEMO-BCDE-FGHJ-KMNP");
    database.raw.prepare(
        "INSERT INTO referrals(id,sender_account_id,recipient_account_id,referral_code_id,status,claimed_at,claim_expires_at) VALUES(?,?,?,?,?,?,?)"
    ).run("old-referral", "sender-1", "recipient", "code-1", "claimed", "2026-07-01T00:00:00.000Z", "2026-07-01T01:00:00.000Z");

    const result = await claim(env, baseConfig, "recipient", "DEMO-BCDE-FGHJ-KMNP");
    assert.equal(result.referralID, "old-referral");
    assert.equal(database.raw.prepare("SELECT status FROM referrals WHERE id='old-referral'").get()!.status, "claimed");
    assert.equal(database.raw.prepare("SELECT sender_account_id FROM referrals WHERE id=?").get(result.referralID)!.sender_account_id, "sender-2");
});

test("a disclosed Apple code is never returned to inventory", async () => {
    const database = new SQLiteD1(), env = environment(database);
    addAccount(database, "recipient");
    database.raw.prepare(
        "INSERT INTO redemptions(id,account_id,fulfillment_type,configured_product,apple_offer_reference,status,reserved_at,expires_at,reconciliation_expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?)"
    ).run("redemption", "recipient", "offer_code", "monthly", env.RECIPIENT_MONTHLY_OFFER_ID, "reserved", "2026-07-01T00:00:00.000Z", "2026-07-01T00:30:00.000Z", "2026-08-01T00:30:00.000Z", "operation-1");
    await addInventory(database, env, "inventory", env.RECIPIENT_MONTHLY_OFFER_ID, "monthly", "redemption", "available");
    database.raw.prepare("UPDATE offer_code_inventory SET reservation_id=NULL WHERE id='inventory'").run();

    await reserveOfferCode(env, env.RECIPIENT_MONTHLY_OFFER_ID, "monthly", "redemption");
    database.raw.prepare("UPDATE redemptions SET status='expired' WHERE id='redemption'").run();
    await releaseOfferCode(env, "redemption");
    assert.equal(database.raw.prepare("SELECT status FROM offer_code_inventory WHERE id='inventory'").get()!.status, "assigned");
});

test("an authenticated ineligibility report terminally rejects only its assigned recipient redemption", async () => {
    const database = new SQLiteD1(), env = environment(database);
    addAccount(database, "sender", "sender-rc");
    addAccount(database, "recipient", "recipient-rc");
    await addCode(database, env, "code", "sender", "DEMO-2345-6789-ABCD");
    database.raw.prepare(
        "INSERT INTO referrals(id,sender_account_id,recipient_account_id,referral_code_id,status,claimed_at,claim_expires_at) VALUES(?,?,?,?,?,?,?)"
    ).run("referral", "sender", "recipient", "code", "offer_reserved", "2026-07-14T10:00:00.000Z", "2026-07-15T10:00:00.000Z");
    database.raw.prepare(
        "INSERT INTO redemptions(id,account_id,referral_id,fulfillment_type,configured_product,apple_offer_reference,status,reserved_at,expires_at,reconciliation_expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    ).run("redemption", "recipient", "referral", "offer_code", "monthly", env.RECIPIENT_MONTHLY_OFFER_ID, "presented", "2026-07-14T10:00:00.000Z", "2030-07-14T10:30:00.000Z", "2030-08-13T10:30:00.000Z", "operation-1");
    await addInventory(database, env, "inventory", env.RECIPIENT_MONTHLY_OFFER_ID, "monthly", "redemption");

    const keys = await crypto.subtle.generateKey(
        {name: "ECDSA", namedCurve: "P-256"},
        true,
        ["sign", "verify"]
    );
    const publicKey = await crypto.subtle.exportKey("raw", keys.publicKey);
    database.raw.prepare(
        "INSERT INTO registered_devices(id,account_id,public_key_jwk,key_version,created_at,last_seen_at) VALUES(?,?,?,?,?,?)"
    ).run(
        "device",
        "recipient",
        Buffer.from(publicKey).toString("base64"),
        1,
        "2026-07-14T10:00:00.000Z",
        "2026-07-14T10:00:00.000Z"
    );

    for (const nonce of ["ineligible_report_1", "ineligible_report_2"]) {
        const response = await route(await signedMutationRequest(
            keys.privateKey,
            "/v1/redemptions/offer-code-ineligible",
            {reservationID: "redemption"},
            nonce,
            "recipient-rc"
        ), env);
        assert.equal(response.status, 200);
    }

    const referral = database.raw.prepare(
        "SELECT status,rejection_reason FROM referrals WHERE id='referral'"
    ).get()!;
    assert.equal(referral.status, "rejected");
    assert.equal(referral.rejection_reason, "apple_offer_ineligible");
    assert.equal(database.raw.prepare("SELECT status FROM redemptions WHERE id='redemption'").get()!.status, "failed");
    assert.equal(database.raw.prepare("SELECT status FROM offer_code_inventory WHERE id='inventory'").get()!.status, "assigned");
    assert.equal(await pendingReservationForAccount(env, "recipient", "recipient"), null);

    await assert.rejects(
        rejectRecipientOfferCodeAsIneligible(env, "sender", "redemption"),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "reservation_not_rejectable"
    );
    await releaseOfferCode(env, "redemption");
    assert.equal(database.raw.prepare("SELECT status FROM offer_code_inventory WHERE id='inventory'").get()!.status, "assigned");
});

test("an authoritative purchase webhook supersedes a false client ineligibility report", async () => {
    const database = new SQLiteD1(), env = environment(database);
    addAccount(database, "sender", "sender-rc");
    addAccount(database, "recipient", "recipient-rc");
    await addCode(database, env, "code", "sender", "DEMO-2345-6789-ABCD");
    database.raw.prepare(
        "INSERT INTO referrals(id,sender_account_id,recipient_account_id,referral_code_id,status,claimed_at,claim_expires_at) VALUES(?,?,?,?,?,?,?)"
    ).run("referral", "sender", "recipient", "code", "offer_reserved", "2026-07-14T10:00:00.000Z", "2026-07-15T10:00:00.000Z");
    database.raw.prepare(
        "INSERT INTO redemptions(id,account_id,referral_id,fulfillment_type,configured_product,apple_offer_reference,status,reserved_at,expires_at,reconciliation_expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    ).run("redemption", "recipient", "referral", "offer_code", "monthly", env.RECIPIENT_MONTHLY_OFFER_ID, "presented", "2026-07-14T10:00:00.000Z", "2026-07-14T10:30:00.000Z", "2026-08-13T10:30:00.000Z", "operation-1");
    await addInventory(database, env, "inventory", env.RECIPIENT_MONTHLY_OFFER_ID, "monthly", "redemption");
    await rejectRecipientOfferCodeAsIneligible(env, "recipient", "redemption");

    await withActiveSender(() => processRevenueCatEvent(
        env,
        purchaseEvent(),
        "2026-07-14T10:20:00.000Z"
    ));

    assert.equal(database.raw.prepare("SELECT status FROM redemptions WHERE id='redemption'").get()!.status, "confirmed");
    assert.equal(database.raw.prepare("SELECT status FROM referrals WHERE id='referral'").get()!.status, "redeemed");
    assert.equal(database.raw.prepare("SELECT rejection_reason FROM referrals WHERE id='referral'").get()!.rejection_reason, null);
    assert.equal(database.raw.prepare("SELECT status FROM offer_code_inventory WHERE id='inventory'").get()!.status, "redeemed");
    assert.equal(database.raw.prepare("SELECT COALESCE(SUM(quantity),0) balance FROM credit_ledger WHERE account_id='sender'").get()!.balance, 1);
});

test("offer-code imports reject a product that does not own the reference", async () => {
    const database = new SQLiteD1(), env = environment(database);
    await assert.rejects(
        importOfferCodes(env, {
            offerReference: env.RECIPIENT_MONTHLY_OFFER_ID,
            product: "yearly",
            codes: ["APPLECODE123"]
        }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "offer_product_mismatch"
    );
    assert.equal(database.raw.prepare("SELECT COUNT(*) count FROM offer_code_inventory").get()!.count, 0);
});

test("pending redemption recovery stays within its requested operation kind", async () => {
    const database = new SQLiteD1(), env = environment(database);
    addAccount(database, "sender");
    addAccount(database, "account");
    await addCode(database, env, "code", "sender", "DEMO-2345-6789-ABCD");
    database.raw.prepare(
        "INSERT INTO referrals(id,sender_account_id,recipient_account_id,referral_code_id,status,claimed_at,claim_expires_at) VALUES(?,?,?,?,?,?,?)"
    ).run("referral", "sender", "account", "code", "offer_reserved", "2026-07-14T10:00:00.000Z", "2030-07-15T10:00:00.000Z");
    database.raw.prepare(
        "INSERT INTO redemptions(id,account_id,referral_id,fulfillment_type,configured_product,status,reserved_at,expires_at,reconciliation_expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?)"
    ).run("recipient-redemption", "account", "referral", "offer_code", "monthly", "presented", "2026-07-14T10:00:00.000Z", "2030-07-14T10:30:00.000Z", "2030-08-13T10:30:00.000Z", "recipient-operation");
    await addInventory(database, env, "recipient-inventory", env.RECIPIENT_MONTHLY_OFFER_ID, "monthly", "recipient-redemption");

    assert.equal((await pendingReservationForAccount(env, "account", "recipient"))?.id, "recipient-redemption");
    assert.equal(await pendingReservationForAccount(env, "account", "credit"), null);
});

test("a disclosed code reconciles after the recovery window and survives expiration cleanup", async () => {
    const database = new SQLiteD1(), env = environment(database);
    addAccount(database, "sender", "sender-rc");
    addAccount(database, "recipient", "recipient-rc");
    await addCode(database, env, "code", "sender", "DEMO-2345-6789-ABCD");
    database.raw.prepare(
        "INSERT INTO referrals(id,sender_account_id,recipient_account_id,referral_code_id,status,claimed_at,claim_expires_at) VALUES(?,?,?,?,?,?,?)"
    ).run("referral", "sender", "recipient", "code", "offer_reserved", "2026-07-14T10:00:00.000Z", "2026-07-15T10:00:00.000Z");
    database.raw.prepare(
        "INSERT INTO redemptions(id,account_id,referral_id,fulfillment_type,configured_product,apple_offer_reference,status,reserved_at,expires_at,reconciliation_expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    ).run("redemption", "recipient", "referral", "offer_code", "monthly", env.RECIPIENT_MONTHLY_OFFER_ID, "presented", "2026-07-14T10:00:00.000Z", "2026-07-14T10:30:00.000Z", "2026-08-13T10:30:00.000Z", "operation-1");
    await addInventory(database, env, "inventory", env.RECIPIENT_MONTHLY_OFFER_ID, "monthly", "redemption");

    await releaseExpired(env);
    await withActiveSender(() => processRevenueCatEvent(env, purchaseEvent({
        purchased_at_ms: Date.parse("2026-09-14T10:15:00.000Z")
    }), "2026-09-14T10:16:00.000Z"));
    assert.equal(database.raw.prepare("SELECT status FROM redemptions WHERE id='redemption'").get()!.status, "confirmed");
    assert.equal(database.raw.prepare("SELECT status FROM referrals WHERE id='referral'").get()!.status, "redeemed");
    assert.equal(database.raw.prepare("SELECT COALESCE(SUM(quantity),0) balance FROM credit_ledger WHERE account_id='sender'").get()!.balance, 1);
    assert.equal(database.raw.prepare("SELECT status FROM offer_code_inventory WHERE id='inventory'").get()!.status, "redeemed");
});

test("sender offer-code webhooks match their own monthly and yearly reference names", async () => {
    for (const product of ["monthly", "yearly"] as const) {
        const database = new SQLiteD1(), env = environment(database);
        addAccount(database, "sender", "sender-rc");
        const reference = product === "monthly" ? env.SENDER_NEW_MONTHLY_OFFER_ID : env.SENDER_NEW_YEARLY_OFFER_ID;
        const referenceName = product === "monthly" ? env.SENDER_NEW_MONTHLY_OFFER_REFERENCE_NAME : env.SENDER_NEW_YEARLY_OFFER_REFERENCE_NAME;
        const productID = product === "monthly" ? env.MONTHLY_PRODUCT_ID : env.YEARLY_PRODUCT_ID;
        database.raw.prepare(
            "INSERT INTO credit_ledger(id,account_id,entry_type,quantity,idempotency_key,created_at) VALUES(?,?,?,?,?,?)"
        ).run("earned", "sender", "earned", 1, "earned:seed", "2026-07-01T00:00:00.000Z");
        database.raw.prepare(
            "INSERT INTO redemptions(id,account_id,credit_ledger_reservation_id,fulfillment_type,configured_product,apple_offer_reference,status,reserved_at,expires_at,reconciliation_expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
        ).run("redemption", "sender", "earned", "offer_code", product, reference, "presented", "2026-07-14T10:00:00.000Z", "2026-07-14T10:30:00.000Z", "2026-08-13T10:30:00.000Z", "operation-1");
        await addInventory(database, env, "inventory", reference, product, "redemption");
        await processRevenueCatEvent(env, purchaseEvent({
            app_user_id: "sender-rc",
            product_id: productID,
            offer_code: referenceName
        }), "2026-07-14T10:20:00.000Z");
        assert.equal(database.raw.prepare("SELECT status FROM redemptions WHERE id='redemption'").get()!.status, "confirmed");
    }
});

test("late use of a disclosed sender code consumes the released banked credit", async () => {
    const database = new SQLiteD1(), env = environment(database);
    addAccount(database, "sender", "sender-rc");
    database.raw.prepare(
        "INSERT INTO credit_ledger(id,account_id,entry_type,quantity,idempotency_key,created_at) VALUES(?,?,?,?,?,?)"
    ).run("earned", "sender", "earned", 1, "earned:seed", "2026-07-01T00:00:00.000Z");
    database.raw.prepare(
        "INSERT INTO credit_ledger(id,account_id,redemption_id,entry_type,quantity,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)"
    ).run("reservation", "sender", "redemption", "reserved", -1, "reserve:seed", "2026-07-14T10:00:00.000Z");
    database.raw.prepare(
        "INSERT INTO redemptions(id,account_id,credit_ledger_reservation_id,fulfillment_type,configured_product,apple_offer_reference,status,reserved_at,expires_at,reconciliation_expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    ).run("redemption", "sender", "reservation", "offer_code", "monthly", env.SENDER_NEW_MONTHLY_OFFER_ID, "expired", "2026-07-14T10:00:00.000Z", "2026-07-14T10:30:00.000Z", "2026-08-13T10:30:00.000Z", "operation-1");
    database.raw.prepare(
        "INSERT INTO credit_ledger(id,account_id,redemption_id,entry_type,quantity,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)"
    ).run("released", "sender", "redemption", "reservation_released", 1, "release:redemption", "2026-07-14T10:30:00.000Z");
    await addInventory(database, env, "inventory", env.SENDER_NEW_MONTHLY_OFFER_ID, "monthly", "redemption");

    await processRevenueCatEvent(env, purchaseEvent({
        app_user_id: "sender-rc",
        offer_code: env.SENDER_NEW_MONTHLY_OFFER_REFERENCE_NAME,
        purchased_at_ms: Date.parse("2026-09-14T10:15:00.000Z")
    }), "2026-09-14T10:16:00.000Z");

    assert.equal(database.raw.prepare("SELECT status FROM redemptions WHERE id='redemption'").get()!.status, "confirmed");
    assert.equal(database.raw.prepare("SELECT COALESCE(SUM(quantity),0) balance FROM credit_ledger WHERE account_id='sender'").get()!.balance, 0);
});

test("atomic cap enforcement counts open reservations under concurrent confirmations", async () => {
    const database = new SQLiteD1(), env = environment(database);
    addAccount(database, "sender", "sender-rc");
    database.raw.prepare(
        "INSERT INTO credit_ledger(id,account_id,entry_type,quantity,idempotency_key,created_at) VALUES(?,?,?,?,?,?)"
    ).run("balance", "sender", "admin_adjustment", 23, "seed-balance", "2026-07-01T00:00:00.000Z");
    await addCode(database, env, "code", "sender", "DEMO-2345-6789-ABCD");
    for (const suffix of ["1", "2"]) {
        addAccount(database, `recipient-${suffix}`, `recipient-rc-${suffix}`);
        database.raw.prepare(
            "INSERT INTO referrals(id,sender_account_id,recipient_account_id,referral_code_id,status,claimed_at,claim_expires_at) VALUES(?,?,?,?,?,?,?)"
        ).run(`referral-${suffix}`, "sender", `recipient-${suffix}`, "code", "offer_reserved", "2026-07-14T10:00:00.000Z", "2026-07-15T10:00:00.000Z");
        database.raw.prepare(
            "INSERT INTO redemptions(id,account_id,referral_id,fulfillment_type,configured_product,apple_offer_reference,status,reserved_at,expires_at,reconciliation_expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
        ).run(`redemption-${suffix}`, `recipient-${suffix}`, `referral-${suffix}`, "offer_code", "monthly", env.RECIPIENT_MONTHLY_OFFER_ID, "presented", "2026-07-14T10:00:00.000Z", "2026-07-14T10:30:00.000Z", "2026-08-13T10:30:00.000Z", `operation-${suffix}`);
        await addInventory(database, env, `inventory-${suffix}`, env.RECIPIENT_MONTHLY_OFFER_ID, "monthly", `redemption-${suffix}`);
    }
    await withActiveSender(() => Promise.all(["1", "2"].map(suffix => processRevenueCatEvent(env, purchaseEvent({
        id: `event-${suffix}`,
        app_user_id: `recipient-rc-${suffix}`,
        transaction_id: `transaction-${suffix}`
    }), "2026-07-14T10:20:00.000Z"))));
    assert.equal(database.raw.prepare("SELECT COALESCE(SUM(quantity),0) balance FROM credit_ledger WHERE account_id='sender'").get()!.balance, 24);
    assert.equal(database.raw.prepare("SELECT COUNT(*) count FROM credit_ledger WHERE account_id='sender' AND entry_type='earned'").get()!.count, 1);
});

test("refund arriving before purchase confirmation suppresses sender credit", async () => {
    const database = new SQLiteD1(), env = environment(database);
    addAccount(database, "sender", "sender-rc");
    addAccount(database, "recipient", "recipient-rc");
    await addCode(database, env, "code", "sender", "DEMO-2345-6789-ABCD");
    database.raw.prepare(
        "INSERT INTO referrals(id,sender_account_id,recipient_account_id,referral_code_id,status,claimed_at,claim_expires_at) VALUES(?,?,?,?,?,?,?)"
    ).run("referral", "sender", "recipient", "code", "offer_reserved", "2026-07-14T10:00:00.000Z", "2026-07-15T10:00:00.000Z");
    database.raw.prepare(
        "INSERT INTO redemptions(id,account_id,referral_id,fulfillment_type,configured_product,apple_offer_reference,status,reserved_at,expires_at,reconciliation_expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    ).run("redemption", "recipient", "referral", "offer_code", "monthly", env.RECIPIENT_MONTHLY_OFFER_ID, "presented", "2026-07-14T10:00:00.000Z", "2026-07-14T10:30:00.000Z", "2026-08-13T10:30:00.000Z", "operation-1");
    await addInventory(database, env, "inventory", env.RECIPIENT_MONTHLY_OFFER_ID, "monthly", "redemption");
    const transactionID = "transaction-refunded";
    await processRevenueCatEvent(env, purchaseEvent({
        type: "REFUND",
        transaction_id: transactionID,
        purchased_at_ms: Date.parse("2026-07-14T10:16:00.000Z")
    }), "2026-07-14T10:16:00.000Z");
    await withActiveSender(() => processRevenueCatEvent(env, purchaseEvent({transaction_id: transactionID}), "2026-07-14T10:20:00.000Z"));
    assert.equal(database.raw.prepare("SELECT status FROM redemptions WHERE id='redemption'").get()!.status, "confirmed");
    assert.equal(database.raw.prepare("SELECT COALESCE(SUM(quantity),0) balance FROM credit_ledger WHERE account_id='sender'").get()!.balance, 0);
});

async function signedMutationRequest(
    privateKey: CryptoKey,
    path: string,
    value: Record<string, string>,
    nonce: string,
    identity: string
): Promise<Request> {
    const body = JSON.stringify(value);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const canonical = ["POST", path, await sha256(body), timestamp, nonce].join("\n");
    const signature = await crypto.subtle.sign(
        {name: "ECDSA", hash: "SHA-256"},
        privateKey,
        new TextEncoder().encode(canonical)
    );
    return new Request(`https://staging.example.com${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Demo-Identity": identity,
            "X-Demo-Timestamp": timestamp,
            "X-Demo-Nonce": nonce,
            "X-Demo-Signature": Buffer.from(signature).toString("base64")
        },
        body
    });
}
