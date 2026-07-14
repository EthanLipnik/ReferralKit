import {Env, ReferralConfig, config} from "./env";
import {HTTPError, json, body} from "./http";
import {authenticate} from "./auth";
import {decryptOfferCode, encryptOfferCode, hmac, randomID, sha256} from "./crypto";
import {RCEvent, acceptsTransactionEnvironment, customerState, parseEvent} from "./revenuecat";
import {accountBalance, claim, createCode, existingCode, now, redemptionStatus, releaseExpired, reservationForOperation, reserve} from "./domain";
import {importOfferCodes, redeemOfferCode} from "./inventory";
import {landing} from "./landing";

const webhookProcessingLeaseMilliseconds = 5 * 60_000;
const refundableEventTypes = new Set(["REFUND", "REVOKE", "REVOCATION"]);

const safeEqual = (a: string, b: string) => {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
    return difference === 0;
};

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
            "INSERT OR IGNORE INTO registered_devices(id,account_id,public_key_jwk,created_at,last_seen_at) VALUES(?,?,?,?,?)"
        ).bind(randomID(), account.id, data.publicKey, timestamp, timestamp),
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

async function registrationChallenge(request: Request, env: Env) {
    const data = await body<{appUserID: string; publicKey: string}>(request);
    if (!data.appUserID || !data.publicKey) throw new HTTPError(400, "invalid_registration_challenge");
    let raw: Uint8Array;
    try { raw = Uint8Array.from(atob(data.publicKey), character => character.charCodeAt(0)); }
    catch { throw new HTTPError(400, "invalid_public_key"); }
    if (raw.length !== 65 || raw[0] !== 4) throw new HTTPError(400, "invalid_public_key");
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
    return json({
        availableCredits: Math.max(0, await accountBalance(env, accountID)),
        reservedCredits: Number(reserved?.count || 0),
        pendingRewards: Number(counts?.pending || 0),
        canEarnCredits: !account?.lifetime_status,
        isLifetime: Boolean(account?.lifetime_status),
        redemption: await redemptionStatus(env, referralConfig, accountID),
        share: await existingCode(env, accountID)
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

export async function processRevenueCatEvent(env: Env, event: RCEvent, receivedAt: string): Promise<void> {
    if (event.type === "TEST") return;
    const account = await resolveWebhookAccount(env, event);
    const productIsSupported = [env.MONTHLY_PRODUCT_ID, env.YEARLY_PRODUCT_ID].includes(event.product_id || "");
    if (["INITIAL_PURCHASE", "RENEWAL", "NON_RENEWING_PURCHASE"].includes(event.type) &&
        event.transaction_id && productIsSupported) {
        const redemption = await env.DB.prepare(
            "SELECT * FROM redemptions WHERE account_id=? AND status IN ('reserved','presented') AND expires_at>? ORDER BY reserved_at LIMIT 1"
        ).bind(account.id, receivedAt).first<any>();
        const expectedProduct = redemption?.configured_product === "yearly"
            ? env.YEARLY_PRODUCT_ID
            : env.MONTHLY_PRODUCT_ID;
        const offerMatches = redemption && (!redemption.apple_offer_reference ||
            [event.offer_code, event.presented_offering_id].includes(redemption.apple_offer_reference));
        if (redemption && event.product_id === expectedProduct && offerMatches) {
            const statements: D1PreparedStatement[] = [
                env.DB.prepare(
                    "UPDATE redemptions SET status='confirmed',revenuecat_transaction_id=?,confirmed_at=? WHERE id=? AND status IN ('reserved','presented')"
                ).bind(event.transaction_id, receivedAt, redemption.id)
            ];
            if (redemption.referral_id) {
                const sender = await env.DB.prepare(
                    "SELECT a.id,a.revenuecat_customer_id,a.lifetime_status FROM referrals r JOIN referral_accounts a ON a.id=r.sender_account_id WHERE r.id=?"
                ).bind(redemption.referral_id).first<{
                    id: string;
                    revenuecat_customer_id: string;
                    lifetime_status: number;
                }>();
                if (sender) {
                    const senderIsLifetime = await updateSenderLifetimeStatus(env, sender);
                    const referralConfig = config(env);
                    const balance = await accountBalance(env, sender.id);
                    const recent = await env.DB.prepare(
                        "SELECT COUNT(*) count FROM credit_ledger WHERE account_id=? AND entry_type='earned' AND created_at>=?"
                    ).bind(sender.id, new Date(Date.now() - 30 * 86400_000).toISOString()).first<{count: number}>();
                    statements.push(env.DB.prepare(
                        "UPDATE referrals SET status='redeemed',redeemed_at=? WHERE id=? AND status='offer_reserved'"
                    ).bind(receivedAt, redemption.referral_id));
                    if (!senderIsLifetime && balance < referralConfig.maxBankedCredits &&
                        Number(recent?.count || 0) < referralConfig.maxRewardedReferralsPerRolling30Days) {
                        statements.push(env.DB.prepare(
                            "INSERT OR IGNORE INTO credit_ledger(id,account_id,referral_id,entry_type,quantity,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)"
                        ).bind(
                            randomID(), sender.id, redemption.referral_id, "earned", 1,
                            `earned:${redemption.referral_id}`, receivedAt
                        ));
                    }
                }
            } else {
                statements.push(env.DB.prepare(
                    "INSERT OR IGNORE INTO credit_ledger(id,account_id,redemption_id,entry_type,quantity,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)"
                ).bind(randomID(), account.id, redemption.id, "consumed", 0, `consume:${redemption.id}`, receivedAt));
            }
            await env.DB.batch(statements);
            await redeemOfferCode(env, redemption.id);
        }
    }

    const isRefund = refundableEventTypes.has(event.type) ||
        (event.type === "CANCELLATION" && event.cancel_reason === "CUSTOMER_SUPPORT");
    if ((isRefund || event.type === "REFUND_REVERSED") && event.transaction_id) {
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
                        ")"
                    ).bind(
                        randomID(), sender.sender_account_id, redemption.referral_id, "reversed",
                        `reverse:${redemption.referral_id}`, receivedAt,
                        sender.sender_account_id, redemption.referral_id,
                        sender.sender_account_id, redemption.referral_id
                    ).run();
                } else {
                    await env.DB.prepare(
                        "INSERT OR IGNORE INTO credit_ledger(id,account_id,referral_id,entry_type,quantity,idempotency_key,created_at) " +
                        "SELECT ?,?,?,?,1,?,? WHERE EXISTS(" +
                        "SELECT 1 FROM credit_ledger WHERE account_id=? AND referral_id=? AND entry_type='reversed'" +
                        ") AND NOT EXISTS(" +
                        "SELECT 1 FROM credit_ledger WHERE account_id=? AND referral_id=? AND idempotency_key=?" +
                        ")"
                    ).bind(
                        randomID(), sender.sender_account_id, redemption.referral_id, "admin_adjustment",
                        `refund-reversed:${redemption.referral_id}`, receivedAt,
                        sender.sender_account_id, redemption.referral_id,
                        sender.sender_account_id, redemption.referral_id,
                        `refund-reversed:${redemption.referral_id}`
                    ).run();
                }
            }
        }
    }
}

export async function webhook(request: Request, env: Env) {
    const authorization = request.headers.get("authorization") || "";
    if (!safeEqual(authorization, `Bearer ${env.REVENUECAT_WEBHOOK_SECRET}`)) {
        throw new HTTPError(401, "invalid_webhook_secret");
    }
    const raw = await request.text();
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
        await processRevenueCatEvent(env, event, receivedAt);
        await env.DB.prepare(
            "UPDATE webhook_events SET processing_status='processed',processed_at=? WHERE provider_event_id=? AND processing_status='processing' AND processed_at=?"
        ).bind(now(), event.id, claim.token).run();
        return json({ok: true});
    } catch (error) {
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
    if (request.method === "GET" && path === "/health") return json({ok: true, environment: env.ENVIRONMENT});
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
        await env.DB.prepare("DELETE FROM idempotency_responses WHERE created_at<=?")
            .bind(new Date(Date.now() - 30 * 86400_000).toISOString()).run();
    }
};
