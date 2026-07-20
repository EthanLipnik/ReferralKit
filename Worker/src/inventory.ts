import {decryptOfferCode, encryptOfferCode, hmac} from "./crypto";
import {Env, Product} from "./env";
import {HTTPError} from "./http";

const now = () => new Date().toISOString();

export interface OfferCodeImport {
    offerReference: string;
    product: Product;
    codes: string[];
}

export function offerCodeProductMappings(env: Env): Map<string, Product> {
    const entries: Array<[string, Product]> = [
        [env.RECIPIENT_MONTHLY_OFFER_ID, "monthly"],
        [env.RECIPIENT_YEARLY_OFFER_ID, "yearly"],
        [env.SENDER_NEW_MONTHLY_OFFER_ID, "monthly"],
        [env.SENDER_NEW_YEARLY_OFFER_ID, "yearly"]
    ];
    const mappings = new Map<string, Product>();
    for (const [reference, product] of entries) {
        if (!reference || reference.startsWith("REPLACE_")) continue;
        const existing = mappings.get(reference);
        if (existing && existing !== product) {
            throw new HTTPError(503, "offer_reference_configuration_conflict");
        }
        mappings.set(reference, product);
    }
    return mappings;
}

function normalizedAppleCode(value: string): string {
    const code = value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6,64}$/.test(code)) throw new HTTPError(400, "invalid_offer_code");
    return code;
}

export async function importOfferCodes(env: Env, input: OfferCodeImport): Promise<number> {
    const expectedProduct = offerCodeProductMappings(env).get(input.offerReference);
    if (!expectedProduct) {
        throw new HTTPError(400, "unknown_offer_reference");
    }
    if (!(["monthly", "yearly"] as string[]).includes(input.product) || !Array.isArray(input.codes)) {
        throw new HTTPError(400, "invalid_offer_code_import");
    }
    if (input.product !== expectedProduct) throw new HTTPError(400, "offer_product_mismatch");
    const uniqueCodes = [...new Set(input.codes.map(normalizedAppleCode))];
    if (uniqueCodes.length < 1 || uniqueCodes.length > 10_000) {
        throw new HTTPError(400, "invalid_offer_code_count");
    }
    const timestamp = now();
    const statements: D1PreparedStatement[] = [];
    for (const code of uniqueCodes) {
        const id = await hmac(env.CODE_HASH_SECRET, `apple-offer:${code}`);
        const encrypted = await encryptOfferCode(env.OFFER_CODE_ENCRYPTION_KEY, code);
        statements.push(env.DB.prepare(
            "INSERT OR IGNORE INTO offer_code_inventory(id,offer_reference,encrypted_code,product,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
        ).bind(id, input.offerReference, encrypted, input.product, "available", timestamp, timestamp));
    }
    const results = await env.DB.batch(statements);
    return results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
}

export async function reserveOfferCode(
    env: Env,
    offerReference: string,
    product: Product,
    redemptionID: string
): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = await env.DB.prepare(
            "SELECT id,encrypted_code FROM offer_code_inventory WHERE offer_reference=? AND product=? AND status='available' ORDER BY created_at,id LIMIT 1"
        ).bind(offerReference, product).first<{id:string;encrypted_code:string}>();
        if (!candidate) throw new HTTPError(503, "offer_code_inventory_empty");
        // Returning the plaintext code discloses it to the customer. Apple codes cannot be
        // revoked after disclosure, so assignment is intentionally irreversible even if the
        // local redemption later expires.
        const updated = await env.DB.prepare(
            "UPDATE offer_code_inventory SET status='assigned',reservation_id=?,updated_at=? WHERE id=? AND status='available'"
        ).bind(redemptionID, now(), candidate.id).run();
        if (Number(updated.meta?.changes || 0) === 1) {
            return decryptOfferCode(env.OFFER_CODE_ENCRYPTION_KEY, candidate.encrypted_code);
        }
    }
    throw new HTTPError(409, "offer_code_allocation_conflict");
}

export async function offerCodeForReservation(env: Env, redemptionID: string): Promise<string | null> {
    const row = await env.DB.prepare(
        "SELECT encrypted_code FROM offer_code_inventory WHERE reservation_id=? AND status IN ('reserved','assigned')"
    ).bind(redemptionID).first<{encrypted_code:string}>();
    return row ? decryptOfferCode(env.OFFER_CODE_ENCRYPTION_KEY, row.encrypted_code) : null;
}

export async function releaseOfferCode(env: Env, redemptionID: string): Promise<void> {
    // Only pre-disclosure reservations are reusable. Current allocation assigns in one
    // guarded write, but retaining this path safely handles older in-flight rows.
    await env.DB.prepare(
        "UPDATE offer_code_inventory SET status='available',reservation_id=NULL,updated_at=? WHERE reservation_id=? AND status='reserved' AND EXISTS(SELECT 1 FROM redemptions WHERE id=? AND status IN ('expired','failed'))"
    ).bind(now(), redemptionID, redemptionID).run();
}

export async function redeemOfferCode(env: Env, redemptionID: string): Promise<void> {
    await env.DB.prepare(
        "UPDATE offer_code_inventory SET status='redeemed',updated_at=? WHERE reservation_id=? AND status IN ('reserved','assigned')"
    ).bind(now(), redemptionID).run();
}
