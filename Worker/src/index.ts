import {Env, ReferralConfig, config} from "./env";
import {HTTPError, json, body} from "./http";
import {authenticate} from "./auth";
import {decryptOfferCode, encryptOfferCode, hmac, randomID, sha256} from "./crypto";
import {RCEvent, acceptsTransactionEnvironment, customerState, parseEvent, transactionOccurredAt} from "./revenuecat";
import {accountBalance, activeReservationByID, claim, createCode, existingCode, now, pendingReservationForAccount, redemptionStatus, referralHistory, releaseExpired, reservationForOperation, reserve} from "./domain";
import {importOfferCodes, offerCodeProductMappings, redeemOfferCode} from "./inventory";
import {landing} from "./landing";

const webhookProcessingLeaseMilliseconds = 5 * 60_000;
const webhookSignatureToleranceMilliseconds = 5 * 60_000;
const refundableEventTypes = new Set(["REFUND", "REVOKE", "REVOCATION"]);

const safeEqual = (a: string, b: string) => {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
    return difference === 0;
};

export async function verifyRevenueCatWebhookSignature(
    raw: string,
    signatureHeader: string | null,
    secret: string,
    currentTimeMilliseconds = Date.now()
): Promise<boolean> {
    if (!signatureHeader || !secret) return false;
    let timestamp: string | undefined;
    const signatures: string[] = [];
    for (const component of signatureHeader.split(",")) {
        const [key, value] = component.trim().split("=", 2);
        if (key === "t" && /^\d+$/.test(value || "")) timestamp = value;
        if (key === "v1" && /^[a-fA-F0-9]{64}$/.test(value || "")) signatures.push(value.toLowerCase());
    }
    if (!timestamp || signatures.length === 0) return false;
    const signedAt = Number(timestamp) * 1_000;
    if (!Number.isSafeInteger(signedAt) ||
        Math.abs(currentTimeMilliseconds - signedAt) > webhookSignatureToleranceMilliseconds) return false;
    const expected = await hmac(secret, `${timestamp}.${raw}`);
    return signatures.some(signature => safeEqual(signature, expected));
}

async function signed(request: Request, env: Env): Promise<{
    auth: {accountID: string; deviceID: string};
    data: any;
    raw: string;
}> {
    const raw = await request.text();
    const auth = await authenticate(request, env, raw);
    let data: any = {};
    if (raw) {
        try { data = JSON.parse(raw); } catch { throw new HTTPError(400, "invalid_json"); }
    }
    return {auth, data, raw};
}

export async function resolveRegistrationAccount(
    env: Env,
    appUserID: string,
    originalAppUserID: string | undefined,
    aliases: string[]
): Promise<{
    accountID: string | undefined;
    identityHashes: string[];
    mappedHashes: Set<string>;
}> {
    const family = await hmac(env.IDENTITY_HASH_SECRET, appUserID);
    const identityCandidates = normalizedIdentityCandidates([appUserID, originalAppUserID, ...aliases]);
    const identityHashes = await Promise.all(identityCandidates.map(identity =>
        hmac(env.IDENTITY_HASH_SECRET, identity)
    ));
    const directAccounts = await env.DB.prepare(
        "SELECT id FROM referral_accounts WHERE revenuecat_customer_id=? OR identity_family_hash=?"
    ).bind(appUserID, family).all<{id: string}>();
    const placeholders = identityHashes.map(() => "?").join(",");
    const mappedAccounts = identityHashes.length
        ? await env.DB.prepare(
            `SELECT alias_hash,account_id id FROM account_aliases WHERE alias_hash IN (${placeholders})`
        ).bind(...identityHashes).all<{alias_hash: string; id: string}>()
        : {results: [] as Array<{alias_hash: string; id: string}>};
    const accountIDs = new Set([...directAccounts.results, ...mappedAccounts.results].map(row => row.id));
    if (accountIDs.size > 1) throw new HTTPError(409, "ambiguous_customer_identity");
    return {
        accountID: [...accountIDs][0],
        identityHashes,
        mappedHashes: new Set(mappedAccounts.results.map(row => row.alias_hash))
    };
}

export async function register(request: Request, env: Env) {
    const data = await body<{appUserID: string; identitySource: string; publicKey: string; challengeID: string}>(request);
    if (!data.appUserID || !/^[a-z0-9_-]{1,32}$/i.test(data.identitySource) || !data.publicKey || !data.challengeID) {
        throw new HTTPError(400, "invalid_registration");
    }
    let raw: Uint8Array;
    try { raw = Uint8Array.from(atob(data.publicKey), character => character.charCodeAt(0)); }
    catch { throw new HTTPError(400, "invalid_public_key"); }
    if (raw.length !== 65 || raw[0] !== 4) throw new HTTPError(400, "invalid_public_key");

    const family = await hmac(env.IDENTITY_HASH_SECRET, data.appUserID);
    const keyHash = await sha256(data.publicKey);
    const challenge = await env.DB.prepare(
        "SELECT attribute_key,attribute_value_hash,expires_at,consumed_at FROM registration_challenges WHERE id=? AND identity_family_hash=? AND public_key_hash=?"
    ).bind(data.challengeID, family, keyHash).first<any>();
    if (!challenge || challenge.consumed_at || challenge.expires_at <= now()) {
        throw new HTTPError(403, "invalid_registration_challenge");
    }

    const state = await customerState(env, data.appUserID);
    if (!state.exists) throw new HTTPError(403, "unverified_customer");
    const attributeValue = state.subscriberAttributes[challenge.attribute_key]?.value;
    if (!attributeValue || !safeEqual(await sha256(attributeValue), challenge.attribute_value_hash)) {
        throw new HTTPError(403, "unverified_registration_challenge");
    }

    const resolution = await resolveRegistrationAccount(
        env,
        data.appUserID,
        state.originalAppUserID,
        state.aliases
    );
    const {identityHashes, mappedHashes} = resolution;

    const timestamp = now();
    const account = {id: resolution.accountID || randomID()};
    const isNewAccount = resolution.accountID === undefined;
    const statements: D1PreparedStatement[] = [];
    if (isNewAccount) {
        statements.push(env.DB.prepare(
            "INSERT INTO referral_accounts(id,revenuecat_customer_id,identity_family_hash,lifetime_status,created_at,updated_at) VALUES(?,?,?,?,?,?)"
        ).bind(account.id, data.appUserID, family, state.lifetime ? 1 : 0, timestamp, timestamp));
    } else {
        statements.push(
        env.DB.prepare("UPDATE referral_accounts SET lifetime_status=?,updated_at=? WHERE id=?")
                .bind(state.lifetime ? 1 : 0, timestamp, account.id)
        );
    }
    statements.push(
        env.DB.prepare(
            "INSERT OR IGNORE INTO registered_devices(id,account_id,public_key_jwk,key_version,created_at,last_seen_at) " +
            "SELECT ?,?,?,COALESCE(MAX(key_version),0)+1,?,? FROM registered_devices WHERE account_id=?"
        ).bind(randomID(), account.id, data.publicKey, timestamp, timestamp, account.id),
        env.DB.prepare("UPDATE registration_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL")
            .bind(timestamp, data.challengeID)
    );
    for (const identityHash of identityHashes) {
        if (mappedHashes.has(identityHash)) continue;
        statements.push(env.DB.prepare(
            "INSERT INTO account_aliases(alias_hash,account_id,created_at) VALUES(?,?,?)"
        ).bind(identityHash, account.id, timestamp));
    }
    await env.DB.batch(statements);
    return json({}, 201);
}

export async function revokeDevice(env: Env, accountID: string, deviceID: string): Promise<void> {
    const result = await env.DB.prepare(
        "UPDATE registered_devices SET revoked_at=? WHERE id=? AND account_id=? AND revoked_at IS NULL"
    ).bind(now(), deviceID, accountID).run();
    if (Number(result.meta?.changes || 0) !== 1) throw new HTTPError(404, "device_not_found");
}

async function registrationChallenge(request: Request, env: Env) {
    const data = await body<{appUserID: string; publicKey: string}>(request);
    if (!data.appUserID || !data.publicKey) throw new HTTPError(400, "invalid_registration_challenge");
    let raw: Uint8Array;
    try { raw = Uint8Array.from(atob(data.publicKey), character => character.charCodeAt(0)); }
    catch { throw new HTTPError(400, "invalid_public_key"); }
    if (raw.length !== 65 || raw[0] !== 4) throw new HTTPError(400, "invalid_public_key");
    await enforceRegistrationChallengeRateLimit(request, env, data.appUserID);
    const state = await customerState(env, data.appUserID);
    if (!state.exists) throw new HTTPError(403, "unverified_customer");
    const id = randomID();
    const value = randomID() + randomID();
    const attributeKey = env.REGISTRATION_ATTRIBUTE_KEY;
    const timestamp = now();
    await env.DB.prepare(
        "INSERT INTO registration_challenges(id,identity_family_hash,public_key_hash,attribute_key,attribute_value_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)"
    ).bind(
        id,
        await hmac(env.IDENTITY_HASH_SECRET, data.appUserID),
        await sha256(data.publicKey),
        attributeKey,
        await sha256(value),
        new Date(Date.now() + 10 * 60_000).toISOString(),
        timestamp
    ).run();
    return json({challengeID: id, attributeKey, attributeValue: value}, 201);
}

async function consumeAbuseLimit(
    env: Env,
    signal: string,
    bucket: string,
    limit: number,
    windowMilliseconds: number
): Promise<void> {
    const timestamp = now();
    const expiresAt = new Date(Date.now() + windowMilliseconds).toISOString();
    const row = await env.DB.prepare(
        "INSERT INTO abuse_signals(signal_hash,bucket,count,expires_at) VALUES(?,?,1,?) " +
        "ON CONFLICT(signal_hash,bucket) DO UPDATE SET count=CASE WHEN abuse_signals.expires_at<=? THEN 1 ELSE abuse_signals.count+1 END, " +
        "expires_at=CASE WHEN abuse_signals.expires_at<=? THEN excluded.expires_at ELSE abuse_signals.expires_at END RETURNING count"
    ).bind(await hmac(env.IDENTITY_HASH_SECRET, signal), bucket, expiresAt, timestamp, timestamp).first<{count: number}>();
    if (Number(row?.count || 0) > limit) throw new HTTPError(429, "registration_rate_limited");
}

export async function enforceRegistrationChallengeRateLimit(request: Request, env: Env, appUserID: string): Promise<void> {
    const window = 10 * 60_000;
    await consumeAbuseLimit(env, `identity:${appUserID}`, "registration", 5, window);
    const address = request.headers.get("cf-connecting-ip")?.trim();
    if (address) await consumeAbuseLimit(env, `ip:${address}`, "registration", 20, window);
}

async function health(env: Env): Promise<Response> {
    const required = [
        env.APP_STORE_ID, env.ASSOCIATED_APP_IDS, env.CODE_HASH_SECRET, env.IDENTITY_HASH_SECRET,
        env.OFFER_CODE_ENCRYPTION_KEY, env.REVENUECAT_WEBHOOK_SECRET,
        env.REVENUECAT_WEBHOOK_SIGNING_SECRET,
        env.RECIPIENT_MONTHLY_OFFER_ID, env.RECIPIENT_YEARLY_OFFER_ID,
        env.RECIPIENT_MONTHLY_OFFER_REFERENCE_NAME, env.RECIPIENT_YEARLY_OFFER_REFERENCE_NAME,
        env.SENDER_NEW_MONTHLY_OFFER_ID, env.SENDER_NEW_YEARLY_OFFER_ID,
        env.SENDER_NEW_MONTHLY_OFFER_REFERENCE_NAME, env.SENDER_NEW_YEARLY_OFFER_REFERENCE_NAME
    ];
    const issues: string[] = [];
    const readinessIssues: string[] = [];
    if (required.some(value => !value?.trim() || value.startsWith("REPLACE_"))) issues.push("configuration");
    let mappings: Map<string, "monthly" | "yearly"> | undefined;
    try { mappings = offerCodeProductMappings(env); }
    catch { if (!issues.includes("configuration")) issues.push("configuration"); }
    try {
        await env.DB.prepare("SELECT reconciliation_expires_at FROM redemptions LIMIT 1").first();
        await env.DB.prepare("SELECT state FROM transaction_adjustments LIMIT 1").first();
        const references = [...(mappings?.keys() || [])];
        const placeholders = references.map(() => "?").join(",");
        if (mappings && references.length > 0) {
            const rows = await env.DB.prepare(
                `SELECT offer_reference,product FROM offer_code_inventory WHERE status='available' AND offer_reference IN (${placeholders}) GROUP BY offer_reference,product`
            ).bind(...references).all<{offer_reference: string; product: string}>();
            const available = new Set(rows.results.map(row => `${row.offer_reference}\u0000${row.product}`));
            if ([...mappings].some(([reference, product]) => !available.has(`${reference}\u0000${product}`))) {
                readinessIssues.push("offer_code_inventory");
            }
        }
    } catch {
        issues.push("database");
    }
    const referralConfig = config(env);
    const ok = issues.length === 0 && (!referralConfig.enabled || readinessIssues.length === 0);
    return json({
        ok,
        readyForEnrollment: issues.length === 0 && readinessIssues.length === 0,
        environment: env.ENVIRONMENT,
        issues,
        readinessIssues
    }, ok ? 200 : 503);
}

function appleAppSiteAssociation(env: Env): Response {
    const appIDs = env.ASSOCIATED_APP_IDS.split(",").map(value => value.trim()).filter(Boolean);
    return new Response(JSON.stringify({
        applinks: {
            details: [{appIDs, components: [{"/": "/r/*", comment: "Referral links"}]}]
        }
    }), {
        headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=3600"
        }
    });
}

async function snapshot(accountID: string, env: Env) {
    const referralConfig = config(env);
    const account = await env.DB.prepare("SELECT lifetime_status FROM referral_accounts WHERE id=?")
        .bind(accountID).first<{lifetime_status: number}>();
    const counts = await env.DB.prepare(
        "SELECT SUM(CASE WHEN status IN ('claimed','offer_reserved') THEN 1 ELSE 0 END) pending FROM referrals WHERE sender_account_id=?"
    ).bind(accountID).first<any>();
    const reserved = await env.DB.prepare(
        "SELECT COALESCE(SUM(-l.quantity),0) count FROM redemptions r JOIN credit_ledger l ON l.id=r.credit_ledger_reservation_id WHERE r.account_id=? AND r.status IN ('reserved','presented')"
    ).bind(accountID).first<{count: number}>();
    const pendingActivation = await env.DB.prepare(
        "SELECT id reservationID,fulfillment_type kind,status state,expires_at expiresAt FROM redemptions WHERE account_id=? AND status IN ('reserved','presented') AND expires_at>? ORDER BY reserved_at DESC LIMIT 1"
    ).bind(accountID, now()).first<any>();
    return json({
        availableCredits: Math.max(0, await accountBalance(env, accountID)),
        reservedCredits: Number(reserved?.count || 0),
        pendingRewards: Number(counts?.pending || 0),
        canEarnCredits: !account?.lifetime_status,
        isLifetime: Boolean(account?.lifetime_status),
        redemption: await redemptionStatus(env, referralConfig, accountID),
        pendingActivation,
        share: await existingCode(env, accountID),
        history: await referralHistory(env, accountID)
    });
}

function fulfillment(redemption: any, env: Env) {
    const product = redemption.configuredProduct || redemption.configured_product;
    const offerCode = redemption.offerCode || null;
    const kind = redemption.fulfillmentType || redemption.fulfillment_type;
    return {
        reservationID: redemption.id,
        kind,
        offerCode,
        offerURL: offerCode
            ? `https://apps.apple.com/redeem?ctx=offercodes&id=${encodeURIComponent(env.APP_STORE_ID)}&code=${encodeURIComponent(offerCode)}`
            : null,
        productIdentifier: product === "yearly" ? env.YEARLY_PRODUCT_ID : env.MONTHLY_PRODUCT_ID,
        promotionalOfferIdentifier: kind === "promotional_offer"
            ? (redemption.appleOfferReference || redemption.apple_offer_reference)
            : null,
        freeMonths: Math.max(1, Number(redemption.creditQuantity || redemption.credit_quantity || 1)),
        expiresAt: redemption.expiresAt || redemption.expires_at
    };
}

async function configResponse(request: Request, env: Env) {
    const referralConfig = config(env);
    const locale = (new URL(request.url).searchParams.get("locale") || "en").replace("_", "-");
    const language = locale.split("-")[0];
    const copy = referralConfig.localizedCopy[locale] || referralConfig.localizedCopy[language] ||
        referralConfig.localizedCopy.en || {};
    const {localizedCopy: _, ...safe} = referralConfig;
    return json({...safe, copy});
}

function normalizedIdentityCandidates(values: Array<string | undefined>): string[] {
    const candidates = values
        .filter((value): value is string => typeof value === "string")
        .map(value => value.trim())
        .filter(Boolean);
    return [...new Set(candidates)];
}

function recipientOfferReferenceName(env: Env, configuredProduct: string): string | undefined {
    const value = configuredProduct === "yearly"
        ? env.RECIPIENT_YEARLY_OFFER_REFERENCE_NAME
        : env.RECIPIENT_MONTHLY_OFFER_REFERENCE_NAME;
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

function offerCodeReferenceName(env: Env, redemption: any): string | undefined {
    const value = redemption.referral_id
        ? recipientOfferReferenceName(env, redemption.configured_product)
        : redemption.configured_product === "yearly"
            ? env.SENDER_NEW_YEARLY_OFFER_REFERENCE_NAME
            : env.SENDER_NEW_MONTHLY_OFFER_REFERENCE_NAME;
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

async function synchronizeAccountAliases(env: Env, accountID: string, aliases: string[]): Promise<void> {
    const aliasHashes = await Promise.all(normalizedIdentityCandidates(aliases).map(alias =>
        hmac(env.IDENTITY_HASH_SECRET, alias)
    ));
    if (!aliasHashes.length) return;
    const statements: D1PreparedStatement[] = [];
    for (const aliasHash of aliasHashes) {
        const existing = await env.DB.prepare("SELECT account_id FROM account_aliases WHERE alias_hash=?")
            .bind(aliasHash).first<{account_id: string}>();
        if (existing && existing.account_id !== accountID) throw new HTTPError(409, "ambiguous_customer_identity");
        if (existing) continue;
        statements.push(env.DB.prepare(
            "INSERT INTO account_aliases(alias_hash,account_id,created_at) VALUES(?,?,?)"
        ).bind(aliasHash, accountID, now()));
    }
    await env.DB.batch(statements);
}

export async function resolveWebhookAccount(env: Env, event: RCEvent): Promise<{id: string}> {
    const candidates = normalizedIdentityCandidates([
        event.app_user_id,
        event.original_app_user_id,
        ...(event.aliases || [])
    ]);
    if (!candidates.length) throw new HTTPError(400, "invalid_webhook_identity");
    const placeholders = candidates.map(() => "?").join(",");
    const direct = await env.DB.prepare(
        `SELECT id FROM referral_accounts WHERE revenuecat_customer_id IN (${placeholders})`
    ).bind(...candidates).all<{id: string}>();
    const aliasHashes = await Promise.all(candidates.map(candidate => hmac(env.IDENTITY_HASH_SECRET, candidate)));
    const aliasPlaceholders = aliasHashes.map(() => "?").join(",");
    const aliases = await env.DB.prepare(
        `SELECT account_id id FROM account_aliases WHERE alias_hash IN (${aliasPlaceholders})`
    ).bind(...aliasHashes).all<{id: string}>();
    const accountIDs = new Set([...direct.results, ...aliases.results].map(row => row.id));
    if (accountIDs.size === 0) throw new HTTPError(503, "unknown_customer");
    if (accountIDs.size > 1) throw new HTTPError(409, "ambiguous_customer_identity");
    return {id: [...accountIDs][0]};
}

async function webhookEventTouchesReferralState(env: Env, event: RCEvent): Promise<boolean> {
    const referralOfferIdentifiers = new Set(normalizedIdentityCandidates([
        env.RECIPIENT_MONTHLY_OFFER_REFERENCE_NAME,
        env.RECIPIENT_YEARLY_OFFER_REFERENCE_NAME,
        env.SENDER_NEW_MONTHLY_OFFER_REFERENCE_NAME,
        env.SENDER_NEW_YEARLY_OFFER_REFERENCE_NAME,
        env.SENDER_MONTHLY_PROMOTIONAL_OFFER_ID,
        env.SENDER_YEARLY_PROMOTIONAL_OFFER_ID,
        env.SENDER_MONTHLY_PROMOTIONAL_OFFER_2_MONTHS_ID,
        env.SENDER_YEARLY_PROMOTIONAL_OFFER_2_MONTHS_ID,
        env.SENDER_MONTHLY_PROMOTIONAL_OFFER_3_MONTHS_ID,
        env.SENDER_YEARLY_PROMOTIONAL_OFFER_3_MONTHS_ID,
        env.SENDER_MONTHLY_PROMOTIONAL_OFFER_6_MONTHS_ID,
        env.SENDER_YEARLY_PROMOTIONAL_OFFER_6_MONTHS_ID,
        env.SENDER_MONTHLY_PROMOTIONAL_OFFER_12_MONTHS_ID,
        env.SENDER_YEARLY_PROMOTIONAL_OFFER_12_MONTHS_ID
    ]));
    if ([event.offer_code, event.discount_identifier]
        .some(identifier => identifier && referralOfferIdentifiers.has(identifier))) return true;
    if (!event.transaction_id) return false;
    const redemption = await env.DB.prepare(
        "SELECT 1 present FROM redemptions WHERE revenuecat_transaction_id=? LIMIT 1"
    ).bind(event.transaction_id).first<{present: number}>();
    return Boolean(redemption);
}

type WebhookClaim = {state: "acquired"; token: string} | {state: "processed"} | {state: "busy"};

function processingStartedAt(value: string | null | undefined): number {
    if (!value) return 0;
    const parsed = Date.parse(value.split("/")[0]);
    return Number.isFinite(parsed) ? parsed : 0;
}

export async function claimWebhookEvent(
    env: Env,
    event: RCEvent,
    payloadHash: string,
    receivedAt: string
): Promise<WebhookClaim> {
    const token = `${now()}/${randomID()}`;
    const existing = await env.DB.prepare(
        "SELECT payload_hash,processing_status,processed_at FROM webhook_events WHERE provider_event_id=?"
    ).bind(event.id).first<{payload_hash: string; processing_status: string; processed_at: string | null}>();
    if (!existing) {
        try {
            await env.DB.prepare(
                "INSERT INTO webhook_events(id,provider_event_id,event_type,payload_hash,processing_status,received_at,processed_at) VALUES(?,?,?,?,?,?,?)"
            ).bind(randomID(), event.id, event.type, payloadHash, "processing", receivedAt, token).run();
            return {state: "acquired", token};
        } catch (error) {
            const raced = await env.DB.prepare(
                "SELECT 1 present FROM webhook_events WHERE provider_event_id=?"
            ).bind(event.id).first<{present: number}>();
            if (raced) return claimWebhookEvent(env, event, payloadHash, receivedAt);
            throw error;
        }
    }
    if (!safeEqual(existing.payload_hash, payloadHash)) throw new HTTPError(409, "webhook_payload_mismatch");
    if (existing.processing_status === "processed") return {state: "processed"};
    if (existing.processing_status === "processing" &&
        Date.now() - processingStartedAt(existing.processed_at) < webhookProcessingLeaseMilliseconds) {
        return {state: "busy"};
    }
    const statement = existing.processed_at
        ? env.DB.prepare(
            "UPDATE webhook_events SET processing_status='processing',processed_at=? WHERE provider_event_id=? AND payload_hash=? AND processing_status IN ('failed','processing') AND processed_at=?"
        ).bind(token, event.id, payloadHash, existing.processed_at)
        : env.DB.prepare(
            "UPDATE webhook_events SET processing_status='processing',processed_at=? WHERE provider_event_id=? AND payload_hash=? AND processing_status IN ('failed','processing') AND processed_at IS NULL"
        ).bind(token, event.id, payloadHash);
    const result = await statement.run();
    return Number(result.meta?.changes || 0) === 1 ? {state: "acquired", token} : {state: "busy"};
}

async function updateSenderLifetimeStatus(env: Env, sender: {id: string; revenuecat_customer_id: string; lifetime_status: number}) {
    const state = await customerState(env, sender.revenuecat_customer_id);
    if (Boolean(sender.lifetime_status) !== state.lifetime) {
        await env.DB.prepare("UPDATE referral_accounts SET lifetime_status=?,updated_at=? WHERE id=?")
            .bind(state.lifetime ? 1 : 0, now(), sender.id).run();
    }
    return state.lifetime;
}

type RevenueCatEventProcessingResult = "processed" | "test_event" | "unregistered_customer";

export async function processRevenueCatEvent(
    env: Env,
    event: RCEvent,
    receivedAt: string
): Promise<RevenueCatEventProcessingResult> {
    if (event.type === "TEST") return "test_event";
    let account: {id: string};
    try {
        account = await resolveWebhookAccount(env, event);
    } catch (error) {
        if (error instanceof HTTPError && error.code === "unknown_customer" &&
            !await webhookEventTouchesReferralState(env, event)) {
            return "unregistered_customer";
        }
        throw error;
    }
    const occurredAt = transactionOccurredAt(event, receivedAt);
    const adjustmentOccurredAt = typeof event.event_timestamp_ms === "number" &&
        Number.isFinite(event.event_timestamp_ms) && event.event_timestamp_ms > 0
        ? new Date(event.event_timestamp_ms).toISOString()
        : receivedAt;
    const isRefund = refundableEventTypes.has(event.type) ||
        (event.type === "CANCELLATION" && event.cancel_reason === "CUSTOMER_SUPPORT");
    const refundWasReversed = event.type === "REFUND_REVERSED";

    if ((isRefund || refundWasReversed) && event.transaction_id) {
        await env.DB.prepare(
            "INSERT INTO transaction_adjustments(transaction_id,state,event_at,updated_at) VALUES(?,?,?,?) " +
            "ON CONFLICT(transaction_id) DO UPDATE SET state=excluded.state,event_at=excluded.event_at,updated_at=excluded.updated_at " +
            "WHERE excluded.event_at>=transaction_adjustments.event_at"
        ).bind(event.transaction_id, isRefund ? "refunded" : "active", adjustmentOccurredAt, receivedAt).run();
    }

    const productIsSupported = [env.MONTHLY_PRODUCT_ID, env.YEARLY_PRODUCT_ID].includes(event.product_id || "");
    if (["INITIAL_PURCHASE", "RENEWAL", "NON_RENEWING_PURCHASE"].includes(event.type) &&
        event.transaction_id && productIsSupported) {
        const redemptions = await env.DB.prepare(
            "SELECT DISTINCT r.* FROM redemptions r LEFT JOIN offer_code_inventory i ON i.reservation_id=r.id " +
            "WHERE r.account_id=? AND (r.revenuecat_transaction_id=? OR (r.status IN ('reserved','presented','expired') AND r.reserved_at<=? " +
            "AND ((r.fulfillment_type='offer_code' AND i.status IN ('assigned','redeemed')) " +
            "OR (r.fulfillment_type<>'offer_code' AND r.reconciliation_expires_at>=?)))) ORDER BY r.reserved_at DESC"
        ).bind(account.id, event.transaction_id, occurredAt, occurredAt).all<any>();
        const redemption = redemptions.results.find(candidate => {
            const expectedProduct = candidate.configured_product === "yearly"
                ? env.YEARLY_PRODUCT_ID
                : env.MONTHLY_PRODUCT_ID;
            if (event.product_id !== expectedProduct) return false;
            if (candidate.revenuecat_transaction_id === event.transaction_id) return true;
            if (occurredAt < candidate.reserved_at) return false;
            if (candidate.fulfillment_type !== "offer_code" && occurredAt > candidate.expires_at) return false;
            if (!candidate.apple_offer_reference) return true;
            return candidate.fulfillment_type === "promotional_offer"
                ? [event.discount_identifier, event.offer_code].includes(candidate.apple_offer_reference)
                : event.offer_code === offerCodeReferenceName(env, candidate);
        });
        if (redemption) {
            let sender: {id: string; revenuecat_customer_id: string; lifetime_status: number} | null = null;
            let senderIsLifetime = false;
            if (redemption.referral_id) {
                sender = await env.DB.prepare(
                    "SELECT a.id,a.revenuecat_customer_id,a.lifetime_status FROM referrals r JOIN referral_accounts a ON a.id=r.sender_account_id WHERE r.id=?"
                ).bind(redemption.referral_id).first<{
                    id: string;
                    revenuecat_customer_id: string;
                    lifetime_status: number;
                }>();
                if (sender) senderIsLifetime = await updateSenderLifetimeStatus(env, sender);
            }
            const adjustment = await env.DB.prepare(
                "SELECT state FROM transaction_adjustments WHERE transaction_id=?"
            ).bind(event.transaction_id).first<{state: string}>();
            const referralConfig = config(env);
            const rollingStart = new Date(Date.parse(receivedAt) - 30 * 86400_000).toISOString();
            const statements: D1PreparedStatement[] = [
                env.DB.prepare(
                    "UPDATE redemptions SET status='confirmed',revenuecat_transaction_id=?,confirmed_at=? WHERE id=? AND (revenuecat_transaction_id=? OR (status IN ('reserved','presented','expired') AND ? >= reserved_at AND (fulfillment_type='offer_code' OR ? <= expires_at)))"
                ).bind(event.transaction_id, occurredAt, redemption.id, event.transaction_id, occurredAt, occurredAt)
            ];
            if (redemption.referral_id && sender) {
                statements.push(env.DB.prepare(
                    "UPDATE referrals SET status='redeemed',redeemed_at=? WHERE id=? AND status IN ('claimed','offer_reserved','expired') AND EXISTS(SELECT 1 FROM redemptions WHERE id=? AND status='confirmed' AND revenuecat_transaction_id=?)"
                ).bind(occurredAt, redemption.referral_id, redemption.id, event.transaction_id));
                if (!senderIsLifetime && adjustment?.state !== "refunded") {
                    statements.push(env.DB.prepare(
                        "INSERT OR IGNORE INTO credit_ledger(id,account_id,referral_id,entry_type,quantity,idempotency_key,created_at) " +
                        "SELECT ?,?,?, 'earned',1,?,? WHERE EXISTS(SELECT 1 FROM redemptions WHERE id=? AND status='confirmed' AND revenuecat_transaction_id=?) " +
                        "AND COALESCE((SELECT SUM(quantity) FROM credit_ledger WHERE account_id=?),0) + COALESCE((SELECT SUM(-l.quantity) FROM redemptions r JOIN credit_ledger l ON l.id=r.credit_ledger_reservation_id WHERE r.account_id=? AND r.status IN ('reserved','presented')),0) < ? " +
                        "AND (SELECT COUNT(*) FROM credit_ledger WHERE account_id=? AND entry_type='earned' AND created_at>=?) < ? " +
                        "AND NOT EXISTS(SELECT 1 FROM transaction_adjustments WHERE transaction_id=? AND state='refunded') " +
                        "AND EXISTS(SELECT 1 FROM referral_accounts WHERE id=? AND lifetime_status=0)"
                    ).bind(
                        randomID(), sender.id, redemption.referral_id, `earned:${redemption.referral_id}`, receivedAt,
                        redemption.id, event.transaction_id,
                        sender.id, sender.id, referralConfig.maxBankedCredits,
                        sender.id, rollingStart, referralConfig.maxRewardedReferralsPerRolling30Days,
                        event.transaction_id, sender.id
                    ));
                }
            } else {
                statements.push(env.DB.prepare(
                    "INSERT OR IGNORE INTO credit_ledger(id,account_id,redemption_id,entry_type,quantity,idempotency_key,created_at) " +
                    "SELECT ?,?,?, 'consumed',CASE WHEN EXISTS(SELECT 1 FROM credit_ledger WHERE redemption_id=? AND entry_type='reservation_released') THEN COALESCE(l.quantity,-1) ELSE 0 END,?,? " +
                    "FROM redemptions r LEFT JOIN credit_ledger l ON l.id=r.credit_ledger_reservation_id WHERE r.id=? AND r.status='confirmed' AND r.revenuecat_transaction_id=?"
                ).bind(randomID(), account.id, redemption.id, redemption.id, `consume:${redemption.id}`, receivedAt, redemption.id, event.transaction_id));
            }
            await env.DB.batch(statements);
            await redeemOfferCode(env, redemption.id);
        } else if (redemptions.results.length > 0) {
            throw new HTTPError(409, "redemption_event_mismatch");
        }
    }

    if ((isRefund || refundWasReversed) && event.transaction_id) {
        const currentAdjustment = await env.DB.prepare(
            "SELECT state FROM transaction_adjustments WHERE transaction_id=?"
        ).bind(event.transaction_id).first<{state: string}>();
        if ((isRefund && currentAdjustment?.state !== "refunded") ||
            (refundWasReversed && currentAdjustment?.state !== "active")) return "processed";
        const redemption = await env.DB.prepare(
            "SELECT id,referral_id FROM redemptions WHERE revenuecat_transaction_id=?"
        ).bind(event.transaction_id).first<{id: string; referral_id: string | null}>();
        if (redemption?.referral_id) {
            const sender = await env.DB.prepare(
                "SELECT sender_account_id FROM referrals WHERE id=?"
            ).bind(redemption.referral_id).first<{sender_account_id: string}>();
            if (sender) {
                if (isRefund) {
                    await env.DB.prepare(
                        "INSERT OR IGNORE INTO credit_ledger(id,account_id,referral_id,entry_type,quantity,idempotency_key,created_at) " +
                        "SELECT ?,?,?,?,-1,?,? WHERE EXISTS(" +
                        "SELECT 1 FROM credit_ledger WHERE account_id=? AND referral_id=? AND entry_type='earned'" +
                        ") AND NOT EXISTS(" +
                        "SELECT 1 FROM credit_ledger WHERE account_id=? AND referral_id=? AND entry_type='reversed'" +
                        ") AND EXISTS(SELECT 1 FROM transaction_adjustments WHERE transaction_id=? AND state='refunded')"
                    ).bind(
                        randomID(), sender.sender_account_id, redemption.referral_id, "reversed",
                        `reverse:${redemption.referral_id}`, receivedAt,
                        sender.sender_account_id, redemption.referral_id,
                        sender.sender_account_id, redemption.referral_id,
                        event.transaction_id
                    ).run();
                } else {
                    await env.DB.prepare(
                        "INSERT OR IGNORE INTO credit_ledger(id,account_id,referral_id,entry_type,quantity,idempotency_key,created_at) " +
                        "SELECT ?,?,?,?,1,?,? WHERE EXISTS(" +
                        "SELECT 1 FROM credit_ledger WHERE account_id=? AND referral_id=? AND entry_type='reversed'" +
                        ") AND NOT EXISTS(" +
                        "SELECT 1 FROM credit_ledger WHERE account_id=? AND referral_id=? AND idempotency_key=?" +
                        ") AND EXISTS(SELECT 1 FROM transaction_adjustments WHERE transaction_id=? AND state='active')"
                    ).bind(
                        randomID(), sender.sender_account_id, redemption.referral_id, "admin_adjustment",
                        `refund-reversed:${redemption.referral_id}`, receivedAt,
                        sender.sender_account_id, redemption.referral_id,
                        sender.sender_account_id, redemption.referral_id,
                        `refund-reversed:${redemption.referral_id}`,
                        event.transaction_id
                    ).run();
                    const referralConfig = config(env);
                    await env.DB.prepare(
                        "INSERT OR IGNORE INTO credit_ledger(id,account_id,referral_id,entry_type,quantity,idempotency_key,created_at) " +
                        "SELECT ?,?,?, 'earned',1,?,? WHERE NOT EXISTS(SELECT 1 FROM credit_ledger WHERE account_id=? AND referral_id=? AND entry_type='earned') " +
                        "AND COALESCE((SELECT SUM(quantity) FROM credit_ledger WHERE account_id=?),0) + COALESCE((SELECT SUM(-l.quantity) FROM redemptions r JOIN credit_ledger l ON l.id=r.credit_ledger_reservation_id WHERE r.account_id=? AND r.status IN ('reserved','presented')),0) < ? " +
                        "AND (SELECT COUNT(*) FROM credit_ledger WHERE account_id=? AND entry_type='earned' AND created_at>=?) < ? " +
                        "AND EXISTS(SELECT 1 FROM referral_accounts WHERE id=? AND lifetime_status=0) " +
                        "AND EXISTS(SELECT 1 FROM transaction_adjustments WHERE transaction_id=? AND state='active')"
                    ).bind(
                        randomID(), sender.sender_account_id, redemption.referral_id,
                        `earned:${redemption.referral_id}`, receivedAt,
                        sender.sender_account_id, redemption.referral_id,
                        sender.sender_account_id, sender.sender_account_id, referralConfig.maxBankedCredits,
                        sender.sender_account_id, new Date(Date.parse(receivedAt) - 30 * 86400_000).toISOString(), referralConfig.maxRewardedReferralsPerRolling30Days,
                        sender.sender_account_id,
                        event.transaction_id
                    ).run();
                }
            }
        }
    }
    return "processed";
}

export async function webhook(request: Request, env: Env) {
    const authorization = request.headers.get("authorization") || "";
    if (!safeEqual(authorization, `Bearer ${env.REVENUECAT_WEBHOOK_SECRET}`)) {
        throw new HTTPError(401, "invalid_webhook_secret");
    }
    const raw = await request.text();
    if (!await verifyRevenueCatWebhookSignature(
        raw,
        request.headers.get("x-revenuecat-webhook-signature"),
        env.REVENUECAT_WEBHOOK_SIGNING_SECRET
    )) throw new HTTPError(401, "invalid_webhook_signature");
    let payload: any;
    try { payload = JSON.parse(raw); } catch { throw new HTTPError(400, "invalid_json"); }
    const event = parseEvent(payload);
    if (!acceptsTransactionEnvironment(env.REVENUECAT_TRANSACTION_ENVIRONMENT, event.environment)) {
        return json({ok: true, ignored: true, reason: "transaction_environment"});
    }
    const payloadHash = await sha256(raw);
    const receivedAt = now();
    const claim = await claimWebhookEvent(env, event, payloadHash, receivedAt);
    if (claim.state === "processed") return json({ok: true, duplicate: true});
    if (claim.state === "busy") throw new HTTPError(503, "webhook_processing");
    try {
        const processingResult = await processRevenueCatEvent(env, event, receivedAt);
        await env.DB.prepare(
            "UPDATE webhook_events SET processing_status='processed',processed_at=? WHERE provider_event_id=? AND processing_status='processing' AND processed_at=?"
        ).bind(now(), event.id, claim.token).run();
        return processingResult === "processed"
            ? json({ok: true})
            : json({ok: true, ignored: true, reason: processingResult});
    } catch (error) {
        if (error instanceof HTTPError) {
            console.error("RevenueCat webhook processing failed", {
                eventID: event.id,
                eventType: event.type,
                status: error.status,
                code: error.code
            });
        } else {
            console.error("RevenueCat webhook processing failed", {
                eventID: event.id,
                eventType: event.type,
                error: error instanceof Error ? error.message : "unknown_error"
            });
        }
        await env.DB.prepare(
            "UPDATE webhook_events SET processing_status='failed',processed_at=? WHERE provider_event_id=? AND processing_status='processing' AND processed_at=?"
        ).bind(now(), event.id, claim.token).run();
        throw error;
    }
}

export function operationAllowed(path: string, referralConfig: ReferralConfig): boolean {
    if (path === "/v1/codes") return referralConfig.enabled;
    if (path === "/v1/referrals/claim") return referralConfig.enabled && referralConfig.redemptionEnabled;
    if (path === "/v1/credits/redeem") return referralConfig.redemptionEnabled;
    return true;
}

function requireOperationAllowed(path: string, referralConfig: ReferralConfig) {
    if (operationAllowed(path, referralConfig)) return;
    if (!referralConfig.redemptionEnabled && path !== "/v1/codes") {
        throw new HTTPError(403, "redemption_disabled");
    }
    throw new HTTPError(403, "enrollment_disabled");
}

function operationID(request: Request, data: any, env: Env): string {
    const headerValue = request.headers.get("idempotency-key")?.trim();
    const bodyValue = typeof data?.operationID === "string" ? data.operationID.trim() : undefined;
    if (headerValue && bodyValue && headerValue !== bodyValue) throw new HTTPError(400, "idempotency_key_mismatch");
    const explicit = bodyValue || headerValue;
    if (explicit) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(explicit)) {
            throw new HTTPError(400, "invalid_idempotency_key");
        }
        return explicit;
    }
    return request.headers.get(`x-${env.AUTH_HEADER_PREFIX.toLowerCase()}-nonce`)!;
}

async function cachedIdempotencyResponse(
    env: Env,
    accountID: string,
    idempotencyKey: string,
    requestHash: string
): Promise<Response | null> {
    const cached = await env.DB.prepare(
        "SELECT request_hash,status,response_json FROM idempotency_responses WHERE account_id=? AND idempotency_key=?"
    ).bind(accountID, idempotencyKey).first<{request_hash: string; status: number; response_json: string}>();
    if (!cached) return null;
    if (!safeEqual(cached.request_hash, requestHash)) throw new HTTPError(409, "idempotency_key_reused");
    let value: unknown;
    try {
        const serialized = cached.response_json.startsWith("v1.")
            ? await decryptOfferCode(env.OFFER_CODE_ENCRYPTION_KEY, cached.response_json)
            : cached.response_json;
        value = JSON.parse(serialized);
    }
    catch { throw new HTTPError(500, "invalid_idempotency_response"); }
    return json(value, cached.status);
}

async function persistIdempotencyResponse(
    env: Env,
    accountID: string,
    idempotencyKey: string,
    requestHash: string,
    status: number,
    value: unknown
) {
    const encryptedResponse = await encryptOfferCode(
        env.OFFER_CODE_ENCRYPTION_KEY,
        JSON.stringify(value)
    );
    await env.DB.prepare(
        "INSERT OR IGNORE INTO idempotency_responses(account_id,idempotency_key,request_hash,status,response_json,created_at) VALUES(?,?,?,?,?,?)"
    ).bind(accountID, idempotencyKey, requestHash, status, encryptedResponse, now()).run();
    const cached = await cachedIdempotencyResponse(env, accountID, idempotencyKey, requestHash);
    if (!cached) throw new HTTPError(503, "idempotency_response_unavailable");
}

export async function route(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/.well-known/apple-app-site-association") {
        return appleAppSiteAssociation(env);
    }
    if (request.method === "GET" && path === "/health") return health(env);
    if (request.method === "GET" && path === "/v1/config") return configResponse(request, env);
    if (request.method === "GET" && path.startsWith("/r/")) {
        return landing(request, env, decodeURIComponent(path.slice(3)));
    }
    if (request.method === "POST" && path === "/v1/devices/registration-challenges") {
        return registrationChallenge(request, env);
    }
    if (request.method === "POST" && path === "/v1/devices/register") return register(request, env);
    if (request.method === "POST" && path === "/v1/revenuecat/webhooks") return webhook(request, env);
    if (request.method === "POST" && path === "/v1/admin/offer-codes/import") {
        const authorization = request.headers.get("authorization") || "";
        if (!safeEqual(authorization, `Bearer ${env.OFFER_CODE_IMPORT_SECRET}`)) {
            throw new HTTPError(401, "invalid_import_secret");
        }
        return json({imported: await importOfferCodes(env, await body<any>(request))}, 201);
    }
    if (!path.startsWith("/v1/")) throw new HTTPError(404, "not_found");
    if (request.method === "GET") {
        const auth = await authenticate(request, env);
        if (path === "/v1/account") return snapshot(auth.accountID, env);
        throw new HTTPError(404, "not_found");
    }
    if (request.method !== "POST") throw new HTTPError(404, "not_found");

    const {auth, data, raw} = await signed(request, env);
    const referralConfig = config(env);
    if (path === "/v1/codes") {
        requireOperationAllowed(path, referralConfig);
        return json(await createCode(env, auth.accountID), 201);
    }
    if (path === "/v1/devices/revoke") {
        if (data.deviceID !== undefined) throw new HTTPError(400, "device_target_not_supported");
        await revokeDevice(env, auth.accountID, auth.deviceID);
        return json({});
    }
    if (path === "/v1/redemptions/presented") {
        if (typeof data.reservationID !== "string" || !data.reservationID) {
            throw new HTTPError(400, "invalid_reservation");
        }
        const result = await env.DB.prepare(
            "UPDATE redemptions SET status='presented' WHERE id=? AND account_id=? AND status IN ('reserved','presented') AND expires_at>?"
        ).bind(data.reservationID, auth.accountID, now()).run();
        if (Number(result.meta?.changes || 0) !== 1) {
            const existing = await env.DB.prepare(
                "SELECT status FROM redemptions WHERE id=? AND account_id=?"
            ).bind(data.reservationID, auth.accountID).first<{status: string}>();
            if (existing?.status !== "confirmed") throw new HTTPError(409, "reservation_not_active");
        }
        return json({});
    }
    if (path === "/v1/redemptions/resume") {
        if (typeof data.reservationID !== "string" || !data.reservationID) {
            throw new HTTPError(400, "invalid_reservation");
        }
        const redemption = await activeReservationByID(env, auth.accountID, data.reservationID);
        if (!redemption) throw new HTTPError(409, "reservation_not_active");
        return json(fulfillment(redemption, env));
    }
    const account = await env.DB.prepare("SELECT revenuecat_customer_id FROM referral_accounts WHERE id=?")
        .bind(auth.accountID).first<{revenuecat_customer_id: string}>();
    if (!account) throw new HTTPError(404, "account_not_found");
    if (path === "/v1/referrals/claim") {
        const idempotencyKey = operationID(request, data, env);
        const requestHash = await sha256(raw);
        const cached = await cachedIdempotencyResponse(env, auth.accountID, idempotencyKey, requestHash);
        if (cached) return cached;
        const existing = await reservationForOperation(env, auth.accountID, idempotencyKey);
        if (existing) {
            const value = fulfillment(existing, env);
            await persistIdempotencyResponse(env, auth.accountID, idempotencyKey, requestHash, 201, value);
            return json(value, 201);
        }
        const pending = await pendingReservationForAccount(env, auth.accountID, "recipient");
        if (pending) {
            const value = fulfillment(pending, env);
            await persistIdempotencyResponse(env, auth.accountID, idempotencyKey, requestHash, 201, value);
            return json(value, 201);
        }
        requireOperationAllowed(path, referralConfig);
        const recipientState = await customerState(env, account.revenuecat_customer_id);
        await synchronizeAccountAliases(env, auth.accountID, recipientState.aliases);
        if (!recipientState.referralRecipientEligible) {
            throw new HTTPError(
                409,
                "recipient_not_eligible",
                `This referral is only available to someone who has never paid for or tried ${env.PRO_NAME}.`
            );
        }
        await claim(env, referralConfig, auth.accountID, String(data.code || ""));
        const value = fulfillment(
            await reserve(env, referralConfig, auth.accountID, "recipient", idempotencyKey), env
        );
        await persistIdempotencyResponse(env, auth.accountID, idempotencyKey, requestHash, 201, value);
        return json(value, 201);
    }
    if (path === "/v1/credits/redeem") {
        const idempotencyKey = operationID(request, data, env);
        const requestHash = await sha256(raw);
        const cached = await cachedIdempotencyResponse(env, auth.accountID, idempotencyKey, requestHash);
        if (cached) return cached;
        const existing = await reservationForOperation(env, auth.accountID, idempotencyKey);
        if (existing) {
            const value = fulfillment(existing, env);
            await persistIdempotencyResponse(env, auth.accountID, idempotencyKey, requestHash, 201, value);
            return json(value, 201);
        }
        const pending = await pendingReservationForAccount(env, auth.accountID, "credit");
        if (pending) {
            const value = fulfillment(pending, env);
            await persistIdempotencyResponse(env, auth.accountID, idempotencyKey, requestHash, 201, value);
            return json(value, 201);
        }
        requireOperationAllowed(path, referralConfig);
        const senderState = await customerState(env, account.revenuecat_customer_id);
        await synchronizeAccountAliases(env, auth.accountID, senderState.aliases);
        const value = fulfillment(
            await reserve(env, referralConfig, auth.accountID, "credit", idempotencyKey, senderState), env
        );
        await persistIdempotencyResponse(env, auth.accountID, idempotencyKey, requestHash, 201, value);
        return json(value, 201);
    }
    throw new HTTPError(404, "not_found");
}

export default {
    async fetch(request: Request, env: Env) {
        try { return await route(request, env); }
        catch (error) {
            if (error instanceof HTTPError) {
                return json({error: {code: error.code, message: error.message}}, error.status);
            }
            console.error(error);
            return json({error: {code: "internal_error"}}, 500);
        }
    },
    async scheduled(_controller: ScheduledController, env: Env) {
        await releaseExpired(env);
        await env.DB.prepare("DELETE FROM request_nonces WHERE expires_at<=?").bind(now()).run();
        await env.DB.prepare("DELETE FROM registration_challenges WHERE expires_at<=?").bind(now()).run();
        await env.DB.prepare("DELETE FROM abuse_signals WHERE expires_at<=?").bind(now()).run();
        await env.DB.prepare("DELETE FROM idempotency_responses WHERE created_at<=?")
            .bind(new Date(Date.now() - 30 * 86400_000).toISOString()).run();
        await env.DB.prepare("DELETE FROM webhook_events WHERE received_at<=?")
            .bind(new Date(Date.now() - 180 * 86400_000).toISOString()).run();
        await env.DB.prepare("DELETE FROM transaction_adjustments WHERE updated_at<=?")
            .bind(new Date(Date.now() - 400 * 86400_000).toISOString()).run();
    }
};
