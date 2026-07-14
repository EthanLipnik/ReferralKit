export interface Env {
    DB: D1Database;
    ENVIRONMENT: string; PUBLIC_SITE_URL: string; APP_STORE_URL: string; APP_STORE_ID: string;
    APP_NAME: string; PRO_NAME: string; CODE_PREFIX: string; AUTH_HEADER_PREFIX: string;
    REGISTRATION_ATTRIBUTE_KEY: string;
    REVENUECAT_API_BASE: string; REVENUECAT_SECRET_KEY: string; REVENUECAT_WEBHOOK_SECRET: string;
    REVENUECAT_TRANSACTION_ENVIRONMENT: RevenueCatTransactionEnvironment;
    REVENUECAT_ENTITLEMENT: string; MONTHLY_PRODUCT_ID: string; YEARLY_PRODUCT_ID: string;
    LIFETIME_PRODUCT_IDS: string;
    RECIPIENT_MONTHLY_OFFER_ID: string; RECIPIENT_YEARLY_OFFER_ID: string;
    SENDER_MONTHLY_PROMOTIONAL_OFFER_ID: string; SENDER_YEARLY_PROMOTIONAL_OFFER_ID: string;
    SENDER_MONTHLY_PROMOTIONAL_OFFER_2_MONTHS_ID: string; SENDER_YEARLY_PROMOTIONAL_OFFER_2_MONTHS_ID: string;
    SENDER_MONTHLY_PROMOTIONAL_OFFER_3_MONTHS_ID: string; SENDER_YEARLY_PROMOTIONAL_OFFER_3_MONTHS_ID: string;
    SENDER_MONTHLY_PROMOTIONAL_OFFER_6_MONTHS_ID: string; SENDER_YEARLY_PROMOTIONAL_OFFER_6_MONTHS_ID: string;
    SENDER_MONTHLY_PROMOTIONAL_OFFER_12_MONTHS_ID: string; SENDER_YEARLY_PROMOTIONAL_OFFER_12_MONTHS_ID: string;
    SENDER_NEW_MONTHLY_OFFER_ID: string; SENDER_NEW_YEARLY_OFFER_ID: string;
    CODE_HASH_SECRET: string; IDENTITY_HASH_SECRET: string; OFFER_CODE_ENCRYPTION_KEY: string;
    OFFER_CODE_IMPORT_SECRET: string;
    CONFIG_JSON: string;
}

export type Product = "monthly" | "yearly";
export type RevenueCatTransactionEnvironment = "SANDBOX" | "PRODUCTION";
export interface ReferralConfig {
    schemaVersion: 1; enabled: boolean; redemptionEnabled: boolean; renewalProduct: Product;
    senderCreditDays: number; recipientFreeDays: number; maxBankedCredits: number;
    maxCreditsPerRedemption: number; extensionWindowDays: number;
    maxRewardedReferralsPerRolling30Days: number; maxOutstandingClaims: number;
    reservationMinutes: number; hidePolicy: "disabled" | "proOnly" | "everyone";
    copyVariant: string; localizedCopy: Record<string, {headline?: string; body?: string; toolbarAccessibilityLabel?: string}>;
}

export function config(env: Env): ReferralConfig {
    let raw: Partial<ReferralConfig> = {};
    try { raw = JSON.parse(env.CONFIG_JSON); } catch { /* fail closed */ }
    const clamp = (n: unknown, fallback: number, max: number) => Math.max(1, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : fallback));
    return {
        schemaVersion: 1, enabled: raw.schemaVersion === 1 && raw.enabled === true,
        redemptionEnabled: raw.schemaVersion === 1 && raw.redemptionEnabled === true,
        renewalProduct: raw.renewalProduct === "yearly" ? "yearly" : "monthly",
        senderCreditDays: clamp(raw.senderCreditDays, 30, 31), recipientFreeDays: clamp(raw.recipientFreeDays, 30, 31),
        maxBankedCredits: clamp(raw.maxBankedCredits, 24, 24),
        maxCreditsPerRedemption: clamp(raw.maxCreditsPerRedemption, 12, 12),
        extensionWindowDays: clamp(raw.extensionWindowDays, 7, 14),
        maxRewardedReferralsPerRolling30Days: clamp(raw.maxRewardedReferralsPerRolling30Days, 10, 10),
        maxOutstandingClaims: clamp(raw.maxOutstandingClaims, 20, 20), reservationMinutes: clamp(raw.reservationMinutes, 30, 60),
        hidePolicy: ["disabled", "proOnly", "everyone"].includes(String(raw.hidePolicy)) ? raw.hidePolicy! : "proOnly",
        copyVariant: typeof raw.copyVariant === "string" ? raw.copyVariant : "giftMonthV1",
        localizedCopy: raw.localizedCopy && typeof raw.localizedCopy === "object" ? raw.localizedCopy : {}
    };
}
