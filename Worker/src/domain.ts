import {Env, ReferralConfig, Product} from "./env"; import {HTTPError} from "./http"; import {hmac, randomCode, randomID, normalizeCode, isValidCode} from "./crypto"; import {CustomerState} from "./revenuecat"; import {offerCodeForReservation,releaseOfferCode,reserveOfferCode} from "./inventory";
export const now = () => new Date().toISOString();
const claimLifetimeMilliseconds = 24 * 60 * 60_000;
const recoveryLifetimeMilliseconds = 30 * 24 * 60 * 60_000;
export async function accountBalance(env: Env, accountID: string): Promise<number> {
    const row = await env.DB.prepare("SELECT COALESCE(SUM(quantity),0) balance FROM credit_ledger WHERE account_id=?").bind(accountID).first<{balance:number}>(); return Number(row?.balance || 0);
}
export async function bankedCreditCommitment(env: Env, accountID: string): Promise<number> {
    const row = await env.DB.prepare(
        "SELECT COALESCE((SELECT SUM(quantity) FROM credit_ledger WHERE account_id=?),0) + " +
        "COALESCE((SELECT SUM(-l.quantity) FROM redemptions r JOIN credit_ledger l ON l.id=r.credit_ledger_reservation_id WHERE r.account_id=? AND r.status IN ('reserved','presented')),0) balance"
    ).bind(accountID, accountID).first<{balance:number}>();
    return Number(row?.balance || 0);
}
export async function existingCode(env: Env, accountID: string): Promise<{code:string,url:string}|null> {
    const existing = await env.DB.prepare("SELECT display_code FROM referral_codes WHERE sender_account_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").bind(accountID).first<{display_code:string}>();
    return existing ? {code:existing.display_code,url:`${env.PUBLIC_SITE_URL}/r/${encodeURIComponent(existing.display_code)}`} : null;
}
export interface ReferralHistoryEntry {
    id: string;
    role: "sent" | "received";
    status: "pending" | "redeemed" | "expired" | "unavailable";
    code: string;
    claimedAt: string;
    redeemedAt?: string;
}
export async function referralHistory(env: Env, accountID: string): Promise<ReferralHistoryEntry[]> {
    const rows = await env.DB.prepare(
        "SELECT r.id,r.sender_account_id,r.status,c.display_code,r.claimed_at,r.redeemed_at FROM referrals r JOIN referral_codes c ON c.id=r.referral_code_id WHERE r.sender_account_id=? OR r.recipient_account_id=? ORDER BY COALESCE(r.redeemed_at,r.claimed_at) DESC LIMIT 50"
    ).bind(accountID, accountID).all<{
        id: string;
        sender_account_id: string;
        status: string;
        display_code: string;
        claimed_at: string;
        redeemed_at: string | null;
    }>();
    return rows.results.map(row => ({
        id: row.id,
        role: row.sender_account_id === accountID ? "sent" : "received",
        status: row.status === "redeemed"
            ? "redeemed"
            : row.status === "expired"
                ? "expired"
                : ["claimed", "offer_reserved"].includes(row.status)
                    ? "pending"
                    : "unavailable",
        code: row.display_code,
        claimedAt: row.claimed_at,
        ...(row.redeemed_at ? {redeemedAt: row.redeemed_at} : {})
    }));
}
export async function createCode(env: Env, accountID: string): Promise<{code:string,url:string}> {
    const existing = await existingCode(env,accountID);
    if (existing) return existing;
    for (let attempt = 0; attempt < 3; attempt++) {
        const code = randomCode(env.CODE_PREFIX), id=randomID();
        try {
            await env.DB.prepare("INSERT INTO referral_codes(id,sender_account_id,code_hash,display_code,display_suffix,created_at) VALUES(?,?,?,?,?,?)").bind(id,accountID,await hmac(env.CODE_HASH_SECRET,code),code,code.slice(-4),now()).run();
            return {code,url:`${env.PUBLIC_SITE_URL}/r/${encodeURIComponent(code)}`};
        } catch (error) {
            const raced = await existingCode(env, accountID);
            if (raced) return raced;
            if (attempt === 2) throw error;
        }
    }
    throw new HTTPError(503, "code_creation_failed");
}
export async function claim(env: Env, cfg:ReferralConfig, accountID:string, suppliedCode:string): Promise<{referralID:string}> {
    if (!cfg.enabled) throw new HTTPError(403,"enrollment_disabled"); const code=normalizeCode(suppliedCode,env.CODE_PREFIX); if (!isValidCode(code,env.CODE_PREFIX)) throw new HTTPError(400,"invalid_code");
    const found=await env.DB.prepare("SELECT id,sender_account_id FROM referral_codes WHERE code_hash=? AND revoked_at IS NULL").bind(await hmac(env.CODE_HASH_SECRET,code)).first<{id:string,sender_account_id:string}>();
    if (!found) throw new HTTPError(404,"code_not_found"); if(found.sender_account_id===accountID) throw new HTTPError(409,"self_referral");
    const claimedAt=now(), claimExpiresAt=new Date(Date.now()+claimLifetimeMilliseconds).toISOString();
    await env.DB.prepare("UPDATE referrals SET status='expired' WHERE recipient_account_id=? AND status='claimed' AND claim_expires_at<=?").bind(accountID,claimedAt).run();
    const id=randomID(); try {
        const inserted=await env.DB.prepare(
            "INSERT INTO referrals(id,sender_account_id,recipient_account_id,referral_code_id,status,claimed_at,claim_expires_at) " +
            "SELECT ?,?,?,?,'claimed',?,? WHERE (SELECT COUNT(*) FROM referrals WHERE sender_account_id=? AND status IN ('claimed','offer_reserved') AND claim_expires_at>?) < ?"
        ).bind(id,found.sender_account_id,accountID,found.id,claimedAt,claimExpiresAt,found.sender_account_id,claimedAt,cfg.maxOutstandingClaims).run();
        if(Number(inserted.meta?.changes||0)!==1)throw new HTTPError(429,"sender_claim_limit");
    }
    catch {
        const existing=await env.DB.prepare("SELECT id,sender_account_id,referral_code_id FROM referrals WHERE recipient_account_id=? AND status IN ('claimed','offer_reserved','redeemed') ORDER BY claimed_at DESC LIMIT 1").bind(accountID).first<{id:string;sender_account_id:string;referral_code_id:string}>();
        if(existing?.sender_account_id===found.sender_account_id&&existing.referral_code_id===found.id)return {referralID:existing.id};
        if(!existing){
            const reusable=await env.DB.prepare("SELECT id FROM referrals WHERE recipient_account_id=? AND status='expired' AND NOT EXISTS(SELECT 1 FROM redemptions WHERE referral_id=referrals.id) ORDER BY claimed_at DESC LIMIT 1").bind(accountID).first<{id:string}>();
            if(reusable){
                const reactivated=await env.DB.prepare(
                    "UPDATE referrals SET sender_account_id=?,referral_code_id=?,status='claimed',claimed_at=?,claim_expires_at=?,redeemed_at=NULL,rejection_reason=NULL " +
                    "WHERE id=? AND status='expired' AND NOT EXISTS(SELECT 1 FROM redemptions WHERE referral_id=referrals.id) " +
                    "AND (SELECT COUNT(*) FROM referrals active WHERE active.sender_account_id=? AND active.status IN ('claimed','offer_reserved') AND active.claim_expires_at>?) < ?"
                ).bind(found.sender_account_id,found.id,claimedAt,claimExpiresAt,reusable.id,found.sender_account_id,claimedAt,cfg.maxOutstandingClaims).run();
                if(Number(reactivated.meta?.changes||0)===1)return {referralID:reusable.id};
            }
        }
        const count=await env.DB.prepare("SELECT COUNT(*) count FROM referrals WHERE sender_account_id=? AND status IN ('claimed','offer_reserved') AND claim_expires_at>?").bind(found.sender_account_id,claimedAt).first<{count:number}>();
        if(Number(count?.count||0)>=cfg.maxOutstandingClaims)throw new HTTPError(429,"sender_claim_limit");
        throw new HTTPError(409,"recipient_already_referred");
    } return {referralID:id};
}
export function senderRewardProduct(state: CustomerState, fallback: Product): Product {
    return state.activeSubscriptionProduct ?? fallback;
}
export function senderRewardKind(state: CustomerState): "promotional_offer" | "offer_code" {
    return state.hasPriorSubscription ? "promotional_offer" : "offer_code";
}
export type RewardMonths = 1 | 2 | 3 | 6 | 12;
export const rewardMonthBuckets: readonly RewardMonths[] = [12, 6, 3, 2, 1];
export function rewardMonthsForBalance(balance: number, maximum: number): RewardMonths {
    const available = Math.max(1, Math.min(Math.floor(balance), Math.floor(maximum)));
    return rewardMonthBuckets.find(months => months <= available) ?? 1;
}
function recipientOfferID(env: Env, product: Product): string {
    return product === "yearly" ? env.RECIPIENT_YEARLY_OFFER_ID : env.RECIPIENT_MONTHLY_OFFER_ID;
}
export function senderOfferID(env: Env, product: Product, kind: "promotional_offer" | "offer_code", months: RewardMonths): string {
    if (kind === "promotional_offer") {
        const offers = product === "yearly" ? {
            1: env.SENDER_YEARLY_PROMOTIONAL_OFFER_ID,
            2: env.SENDER_YEARLY_PROMOTIONAL_OFFER_2_MONTHS_ID,
            3: env.SENDER_YEARLY_PROMOTIONAL_OFFER_3_MONTHS_ID,
            6: env.SENDER_YEARLY_PROMOTIONAL_OFFER_6_MONTHS_ID,
            12: env.SENDER_YEARLY_PROMOTIONAL_OFFER_12_MONTHS_ID
        } : {
            1: env.SENDER_MONTHLY_PROMOTIONAL_OFFER_ID,
            2: env.SENDER_MONTHLY_PROMOTIONAL_OFFER_2_MONTHS_ID,
            3: env.SENDER_MONTHLY_PROMOTIONAL_OFFER_3_MONTHS_ID,
            6: env.SENDER_MONTHLY_PROMOTIONAL_OFFER_6_MONTHS_ID,
            12: env.SENDER_MONTHLY_PROMOTIONAL_OFFER_12_MONTHS_ID
        };
        const offer = offers[months];
        if (!offer || offer.startsWith("REPLACE_")) throw new HTTPError(503, "reward_offer_unavailable");
        return offer;
    }
    return product === "yearly" ? env.SENDER_NEW_YEARLY_OFFER_ID : env.SENDER_NEW_MONTHLY_OFFER_ID;
}
export async function redemptionStatus(env: Env, cfg: ReferralConfig, accountID: string): Promise<{state:"ready"|"active_reward";nextEligibleAt?:string;activeRewardEndsAt?:string}> {
    const latest = await env.DB.prepare("SELECT r.confirmed_at,-l.quantity reward_months FROM redemptions r JOIN credit_ledger l ON l.id=r.credit_ledger_reservation_id WHERE r.account_id=? AND r.status='confirmed' AND r.confirmed_at IS NOT NULL ORDER BY r.confirmed_at DESC LIMIT 1").bind(accountID).first<{confirmed_at:string;reward_months:number}>();
    if (!latest) return {state:"ready"};
    const rewardEnds = new Date(latest.confirmed_at), months = rewardMonthsForBalance(latest.reward_months, 12);
    rewardEnds.setUTCMonth(rewardEnds.getUTCMonth() + months);
    const nextEligible = new Date(rewardEnds.getTime() - cfg.extensionWindowDays * 86400_000);
    if (nextEligible.getTime() <= Date.now()) return {state:"ready"};
    return {state:"active_reward",nextEligibleAt:nextEligible.toISOString(),activeRewardEndsAt:rewardEnds.toISOString()};
}
export async function reservationForOperation(env:Env,accountID:string,idempotencyKey:string):Promise<any|null>{
    const existing=await env.DB.prepare("SELECT r.id,r.fulfillment_type,r.configured_product,r.apple_offer_reference,r.status,r.expires_at,COALESCE(-l.quantity,1) credit_quantity FROM redemptions r LEFT JOIN credit_ledger l ON l.id=r.credit_ledger_reservation_id WHERE r.account_id=? AND r.idempotency_key=?").bind(accountID,idempotencyKey).first<any>();
    return hydrateReservation(env, existing);
}
export async function pendingReservationForAccount(env:Env,accountID:string,kind:"recipient"|"credit"):Promise<any|null>{
    const existing=await env.DB.prepare(
        "SELECT r.id,r.fulfillment_type,r.configured_product,r.apple_offer_reference,r.status,r.expires_at,COALESCE(-l.quantity,1) credit_quantity " +
        "FROM redemptions r LEFT JOIN credit_ledger l ON l.id=r.credit_ledger_reservation_id LEFT JOIN offer_code_inventory i ON i.reservation_id=r.id " +
        "WHERE r.account_id=? AND ((?='recipient' AND r.referral_id IS NOT NULL) OR (?='credit' AND r.referral_id IS NULL)) " +
        "AND ((r.status IN ('reserved','presented') AND r.expires_at>?) OR (r.status='expired' AND r.reconciliation_expires_at>? AND i.status='assigned')) " +
        "ORDER BY r.reserved_at DESC LIMIT 1"
    ).bind(accountID,kind,kind,now(),now()).first<any>();
    return hydrateReservation(env, existing);
}
export async function activeReservationByID(env:Env,accountID:string,reservationID:string):Promise<any|null>{
    const existing=await env.DB.prepare("SELECT r.id,r.fulfillment_type,r.configured_product,r.apple_offer_reference,r.status,r.expires_at,COALESCE(-l.quantity,1) credit_quantity FROM redemptions r LEFT JOIN credit_ledger l ON l.id=r.credit_ledger_reservation_id LEFT JOIN offer_code_inventory i ON i.reservation_id=r.id WHERE r.id=? AND r.account_id=? AND ((r.status IN ('reserved','presented') AND r.expires_at>?) OR (r.status='expired' AND r.reconciliation_expires_at>? AND i.status='assigned'))").bind(reservationID,accountID,now(),now()).first<any>();
    return hydrateReservation(env,existing);
}
async function hydrateReservation(env:Env,existing:any):Promise<any|null>{
    if(!existing)return null;
    if(!["reserved","presented","confirmed","expired"].includes(existing.status))throw new HTTPError(409,"operation_not_recoverable");
    if(existing.fulfillment_type==="offer_code"){
        existing.offerCode=await offerCodeForReservation(env,existing.id);
        if(!existing.offerCode&&existing.status!=="confirmed")throw new HTTPError(503,"reservation_pending");
    }
    return existing;
}
export async function reserve(env:Env,cfg:ReferralConfig,accountID:string,kind:"recipient"|"credit",idempotencyKey:string,customerState?:CustomerState):Promise<any>{
    if(!cfg.redemptionEnabled) throw new HTTPError(403,"redemption_disabled"); let product:Product=cfg.renewalProduct; const created=now(),expiresAt=new Date(Date.now()+cfg.reservationMinutes*60_000);
    const old=await reservationForOperation(env,accountID,idempotencyKey);if(old)return old;
    let referralID:string|null=null, ledgerID:string|null=null, fulfillment:"promotional_offer"|"offer_code"="offer_code", offerRef=recipientOfferID(env,product), creditQuantity:RewardMonths=1;
    if(kind==="recipient") { const r=await env.DB.prepare("SELECT id FROM referrals WHERE recipient_account_id=? AND status='claimed' AND claim_expires_at>?").bind(accountID,created).first<{id:string}>(); if(!r)throw new HTTPError(409,"no_claimed_referral"); referralID=r.id; }
    else { const acct=await env.DB.prepare("SELECT lifetime_status FROM referral_accounts WHERE id=?").bind(accountID).first<{lifetime_status:number}>(); if(acct?.lifetime_status||customerState?.lifetime)throw new HTTPError(409,"lifetime_not_reward_eligible"); if(!customerState)throw new HTTPError(500,"missing_customer_state"); const balance=await accountBalance(env,accountID);if(balance<1)throw new HTTPError(409,"insufficient_credits");const status=await redemptionStatus(env,cfg,accountID);if(status.state==="active_reward")throw new HTTPError(409,"reward_already_active","Your banked months will be ready shortly before your current referral reward ends.");product=senderRewardProduct(customerState,cfg.renewalProduct);fulfillment=senderRewardKind(customerState);creditQuantity=fulfillment==="promotional_offer"?rewardMonthsForBalance(balance,cfg.maxCreditsPerRedemption):1;offerRef=senderOfferID(env,product,fulfillment,creditQuantity);ledgerID=randomID();if(fulfillment==="promotional_offer"&&customerState.activeSubscriptionExpiresAt){const renewalConfirmationDeadline=Date.parse(customerState.activeSubscriptionExpiresAt)+10*60_000;if(Number.isFinite(renewalConfirmationDeadline)&&renewalConfirmationDeadline>expiresAt.getTime())expiresAt.setTime(renewalConfirmationDeadline);} }
    const expires=expiresAt.toISOString(), reconciliationExpiresAt=new Date(expiresAt.getTime()+recoveryLifetimeMilliseconds).toISOString();
    const redemptionID=randomID(); const statements=[] as D1PreparedStatement[];
    if(ledgerID) statements.push(env.DB.prepare("INSERT INTO credit_ledger(id,account_id,redemption_id,entry_type,quantity,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)").bind(ledgerID,accountID,redemptionID,"reserved",-creditQuantity,`reserve:${idempotencyKey}`,created));
    statements.push(env.DB.prepare("INSERT INTO redemptions(id,account_id,referral_id,credit_ledger_reservation_id,fulfillment_type,configured_product,apple_offer_reference,status,reserved_at,expires_at,reconciliation_expires_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(redemptionID,accountID,referralID,ledgerID,fulfillment,product,offerRef,"reserved",created,expires,reconciliationExpiresAt,idempotencyKey));
    if(referralID) statements.push(env.DB.prepare("UPDATE referrals SET status='offer_reserved' WHERE id=? AND status='claimed'").bind(referralID));
    try{await env.DB.batch(statements);}catch(error){const raced=await reservationForOperation(env,accountID,idempotencyKey);if(raced)return raced;throw error;}
    let offerCode:string|null=null;
    if(fulfillment==="offer_code") {
        try { offerCode=await reserveOfferCode(env,offerRef,product,redemptionID); }
        catch(error) {
            const rollback:D1PreparedStatement[]=[env.DB.prepare("UPDATE redemptions SET status='failed' WHERE id=? AND status='reserved'").bind(redemptionID)];
            if(ledgerID)rollback.push(env.DB.prepare("INSERT OR IGNORE INTO credit_ledger(id,account_id,redemption_id,entry_type,quantity,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)").bind(randomID(),accountID,redemptionID,"reservation_released",creditQuantity,`allocation-release:${redemptionID}`,now()));
            if(referralID)rollback.push(env.DB.prepare("UPDATE referrals SET status='claimed' WHERE id=? AND status='offer_reserved'").bind(referralID));
            await env.DB.batch(rollback); await releaseOfferCode(env,redemptionID); throw error;
        }
    }
    return {id:redemptionID,fulfillmentType:fulfillment,configuredProduct:product,appleOfferReference:offerRef,offerCode,creditQuantity,expiresAt:expires};
}
export async function releaseExpired(env:Env):Promise<number>{
    const rows=await env.DB.prepare("SELECT r.id,r.account_id,r.referral_id,r.credit_ledger_reservation_id,COALESCE(-l.quantity,1) credit_quantity FROM redemptions r LEFT JOIN credit_ledger l ON l.id=r.credit_ledger_reservation_id WHERE r.status IN ('reserved','presented') AND r.expires_at<=?").bind(now()).all<any>();
    let released=0;
    for(const r of rows.results){
        const timestamp=now();
        const q:D1PreparedStatement[]=[env.DB.prepare("UPDATE redemptions SET status='expired' WHERE id=? AND status IN ('reserved','presented') AND expires_at<=?").bind(r.id,timestamp)];
        if(r.credit_ledger_reservation_id)q.push(env.DB.prepare("INSERT OR IGNORE INTO credit_ledger(id,account_id,redemption_id,entry_type,quantity,idempotency_key,created_at) SELECT ?,?,?,?, ?,?,? FROM redemptions WHERE id=? AND status='expired'").bind(randomID(),r.account_id,r.id,"reservation_released",Math.max(1,Number(r.credit_quantity||1)),`release:${r.id}`,timestamp,r.id));
        if(r.referral_id)q.push(env.DB.prepare("UPDATE referrals SET status=CASE WHEN claim_expires_at>? THEN 'claimed' ELSE 'expired' END WHERE id=? AND status='offer_reserved' AND EXISTS(SELECT 1 FROM redemptions WHERE id=? AND status='expired')").bind(timestamp,r.referral_id,r.id));
        const results=await env.DB.batch(q);
        if(Number(results[0]?.meta?.changes||0)===1){released+=1;await releaseOfferCode(env,r.id);}
    }
    await env.DB.prepare("UPDATE referrals SET status='expired' WHERE status='claimed' AND claim_expires_at<=?").bind(now()).run();
    return released;
}
