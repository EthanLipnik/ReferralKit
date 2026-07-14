import {Env, Product, RevenueCatTransactionEnvironment} from "./env";
import {HTTPError} from "./http";

export interface CustomerState {
    activePro: boolean;
    activeSubscriptionProduct?: Product;
    hasPriorSubscription: boolean;
    lifetime: boolean;
    aliases: string[];
    originalAppUserID?: string;
    exists: boolean;
    referralRecipientEligible: boolean;
    subscriberAttributes: Record<string, {value?: string; updated_at_ms?: number}>;
}

function normalizedEnvironment(value: unknown): RevenueCatTransactionEnvironment | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toUpperCase();
    if (normalized === "SANDBOX" || normalized === "PRODUCTION") return normalized;
    return undefined;
}

export function transactionMatchesEnvironment(
    transaction: any,
    expectedEnvironment?: RevenueCatTransactionEnvironment,
    unknownMatches = true
): boolean {
    if (!expectedEnvironment) return true;
    if (!transaction || typeof transaction !== "object") return unknownMatches;
    if (typeof transaction.is_sandbox === "boolean") {
        return transaction.is_sandbox === (expectedEnvironment === "SANDBOX");
    }
    const environment = normalizedEnvironment(transaction.environment ?? transaction.transaction_environment);
    return environment ? environment === expectedEnvironment : unknownMatches;
}

export function hasPriorProPurchaseOrTrial(
    subscriber: any,
    monthlyProductID: string,
    yearlyProductID: string,
    lifetimeProductIDs: string[] = [],
    expectedEnvironment?: RevenueCatTransactionEnvironment
): boolean {
    const subscriptionProducts = new Set([monthlyProductID, yearlyProductID]);
    const subscriptions = subscriber?.subscriptions && typeof subscriber.subscriptions === "object"
        ? subscriber.subscriptions
        : {};
    for (const [productID, transaction] of Object.entries<any>(subscriptions)) {
        if (!subscriptionProducts.has(productID)) continue;
        if (transaction && typeof transaction === "object" &&
            transactionMatchesEnvironment(transaction, expectedEnvironment)) return true;
    }

    return hasLifetimePurchase(subscriber, lifetimeProductIDs, expectedEnvironment);
}

export function hasLifetimePurchase(
    subscriber: any,
    lifetimeProductIDs: string[],
    expectedEnvironment?: RevenueCatTransactionEnvironment
): boolean {
    const nonSubscriptions = subscriber?.non_subscriptions && typeof subscriber.non_subscriptions === "object"
        ? subscriber.non_subscriptions
        : {};
    const lifetimeProducts = new Set(lifetimeProductIDs);
    return Object.entries<any>(nonSubscriptions).some(([productID, purchases]) =>
        lifetimeProducts.has(productID) && Array.isArray(purchases) &&
        purchases.some(purchase => transactionMatchesEnvironment(purchase, expectedEnvironment))
    );
}

export function activeProSubscriptionProduct(
    subscriber: any,
    entitlementIdentifier: string,
    monthlyProductID: string,
    yearlyProductID: string,
    expectedEnvironment?: RevenueCatTransactionEnvironment
): Product | undefined {
    const entitlement = subscriber?.entitlements?.[entitlementIdentifier];
    if (!entitlement) return undefined;
    if (entitlement.expires_date && Date.parse(entitlement.expires_date) <= Date.now()) return undefined;
    const productID = entitlement.product_identifier;
    const transaction = subscriber?.subscriptions?.[productID];
    const entitlementHasEnvironment = typeof entitlement.is_sandbox === "boolean" ||
        normalizedEnvironment(entitlement.environment ?? entitlement.transaction_environment) !== undefined;
    const environmentSource = entitlementHasEnvironment ? entitlement : transaction;
    if (!transactionMatchesEnvironment(environmentSource, expectedEnvironment, false)) return undefined;
    if (productID === monthlyProductID) return "monthly";
    if (productID === yearlyProductID) return "yearly";
    return undefined;
}

export async function customerState(env: Env, customerID: string): Promise<CustomerState> {
    const response = await fetch(
        `${env.REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(customerID)}`,
        {headers: {authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`, accept: "application/json"}}
    );
    if (!response.ok) throw new HTTPError(502, "revenuecat_unavailable");
    const payload = await response.json<any>();
    const subscriber = payload.subscriber || {};
    const lifetimeProductIDs = env.LIFETIME_PRODUCT_IDS.split(",").map(value => value.trim()).filter(Boolean);
    const activeSubscriptionProduct = activeProSubscriptionProduct(
        subscriber,
        env.REVENUECAT_ENTITLEMENT,
        env.MONTHLY_PRODUCT_ID,
        env.YEARLY_PRODUCT_ID,
        env.REVENUECAT_TRANSACTION_ENVIRONMENT
    );
    const lifetime = hasLifetimePurchase(
        subscriber,
        lifetimeProductIDs,
        env.REVENUECAT_TRANSACTION_ENVIRONMENT
    );
    const hasPriorSubscription = hasPriorProPurchaseOrTrial(
        subscriber,
        env.MONTHLY_PRODUCT_ID,
        env.YEARLY_PRODUCT_ID,
        lifetimeProductIDs,
        env.REVENUECAT_TRANSACTION_ENVIRONMENT
    );
    return {
        activePro: activeSubscriptionProduct !== undefined || lifetime,
        activeSubscriptionProduct,
        hasPriorSubscription,
        lifetime,
        aliases: Array.isArray(subscriber.aliases)
            ? subscriber.aliases.filter((alias: unknown): alias is string => typeof alias === "string")
            : [],
        originalAppUserID: typeof subscriber.original_app_user_id === "string"
            ? subscriber.original_app_user_id
            : undefined,
        exists: Boolean(subscriber.first_seen || subscriber.original_app_user_id),
        referralRecipientEligible: !hasPriorSubscription,
        subscriberAttributes: subscriber.subscriber_attributes && typeof subscriber.subscriber_attributes === "object"
            ? subscriber.subscriber_attributes
            : {}
    };
}

export interface RCEvent {
    id: string;
    type: string;
    app_user_id: string;
    original_app_user_id?: string;
    aliases?: string[];
    transaction_id?: string;
    product_id?: string;
    offer_code?: string;
    presented_offering_id?: string;
    environment?: string;
    cancel_reason?: string;
}

export function acceptsTransactionEnvironment(configured: string, received: string | undefined): boolean {
    return (configured === "SANDBOX" || configured === "PRODUCTION") && configured === received;
}

export function parseEvent(value: any): RCEvent {
    const event = value?.event;
    if (!event || typeof event.id !== "string" || typeof event.type !== "string" ||
        typeof event.app_user_id !== "string") throw new HTTPError(400, "invalid_webhook");
    return event;
}
