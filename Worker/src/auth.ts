import {Env} from "./env";
import {HTTPError} from "./http";
import {hmac, sha256, verifyX963Signature} from "./crypto";

export interface Auth { accountID: string; deviceID: string; }

export async function registeredDevicesForIdentity(
    env: Env,
    identity: string
): Promise<Array<{id: string; account_id: string; public_key_jwk: string}>> {
    const identityHash = await hmac(env.IDENTITY_HASH_SECRET, identity);
    const devices = await env.DB.prepare(
        "SELECT DISTINCT d.id,d.account_id,d.public_key_jwk FROM registered_devices d " +
        "JOIN referral_accounts a ON a.id=d.account_id " +
        "LEFT JOIN account_aliases aa ON aa.account_id=a.id " +
        "WHERE (a.revenuecat_customer_id=? OR aa.alias_hash=?) AND d.revoked_at IS NULL"
    ).bind(identity, identityHash).all<{id: string; account_id: string; public_key_jwk: string}>();
    if (new Set(devices.results.map(device => device.account_id)).size > 1) {
        throw new HTTPError(401, "ambiguous_customer_identity");
    }
    return devices.results;
}

export async function authenticate(request: Request, env: Env, rawBody = ""): Promise<Auth> {
    const prefix = env.AUTH_HEADER_PREFIX.toLowerCase();
    const identity = request.headers.get(`x-${prefix}-identity`) || "";
    const timestamp = request.headers.get(`x-${prefix}-timestamp`) || "";
    const nonce = request.headers.get(`x-${prefix}-nonce`) || "";
    const signature = request.headers.get(`x-${prefix}-signature`) || "";
    if (!identity || !timestamp || !nonce || !signature) throw new HTTPError(401, "signature_required");
    const time = /^\d+$/.test(timestamp) ? Number(timestamp) * 1000 : Date.parse(timestamp);
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60_000) {
        throw new HTTPError(401, "stale_signature");
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new HTTPError(401, "invalid_nonce");

    const devices = await registeredDevicesForIdentity(env, identity);
    if (!devices.length) throw new HTTPError(401, "unknown_device");

    const url = new URL(request.url);
    const canonical = [
        request.method.toUpperCase(),
        url.pathname + url.search,
        await sha256(rawBody),
        timestamp,
        nonce
    ].join("\n");
    let matched: typeof devices[number] | undefined;
    for (const candidate of devices) {
        if (await verifyX963Signature(candidate.public_key_jwk, signature, canonical)) {
            matched = candidate;
            break;
        }
    }
    if (!matched) throw new HTTPError(401, "invalid_signature");
    try {
        await env.DB.prepare("INSERT INTO request_nonces(device_id,nonce,expires_at) VALUES(?,?,?)")
            .bind(matched.id, nonce, new Date(Date.now() + 10 * 60_000).toISOString()).run();
    } catch {
        throw new HTTPError(409, "replayed_request");
    }
    await env.DB.prepare("UPDATE registered_devices SET last_seen_at=? WHERE id=?")
        .bind(new Date().toISOString(), matched.id).run();
    return {accountID: matched.account_id, deviceID: matched.id};
}
