import assert from "node:assert/strict";
import test from "node:test";
import {
    acceptsTransactionEnvironment,
    activeProSubscriptionProduct,
    hasLifetimePurchase,
    hasPriorProPurchaseOrTrial,
    transactionMatchesEnvironment
} from "../src/revenuecat";

test("staging accepts only sandbox transactions", () => {
    assert.equal(acceptsTransactionEnvironment("SANDBOX", "SANDBOX"), true);
    assert.equal(acceptsTransactionEnvironment("SANDBOX", "PRODUCTION"), false);
    assert.equal(acceptsTransactionEnvironment("SANDBOX", undefined), false);
});

test("production accepts only production transactions", () => {
    assert.equal(acceptsTransactionEnvironment("PRODUCTION", "PRODUCTION"), true);
    assert.equal(acceptsTransactionEnvironment("PRODUCTION", "SANDBOX"), false);
    assert.equal(acceptsTransactionEnvironment("unexpected", "PRODUCTION"), false);
});

test("subscriber transaction environment supports RevenueCat legacy field variants", () => {
    assert.equal(transactionMatchesEnvironment({is_sandbox: true}, "SANDBOX"), true);
    assert.equal(transactionMatchesEnvironment({is_sandbox: true}, "PRODUCTION"), false);
    assert.equal(transactionMatchesEnvironment({environment: " sandbox "}, "SANDBOX"), true);
    assert.equal(transactionMatchesEnvironment({transaction_environment: "PRODUCTION"}, "PRODUCTION"), true);
    assert.equal(transactionMatchesEnvironment({environment: "unknown"}, "SANDBOX"), true);
    assert.equal(transactionMatchesEnvironment({}, "SANDBOX"), true);
    assert.equal(transactionMatchesEnvironment({}, "SANDBOX", false), false);
});

test("recipient subscription history is scoped to the configured transaction environment", () => {
    const subscriber = {
        subscriptions: {
            example_pro_monthly: {period_type: "trial", environment: "SANDBOX"},
            example_pro_yearly: {period_type: "normal", environment: "PRODUCTION"}
        }
    };

    assert.equal(
        hasPriorProPurchaseOrTrial(subscriber, "example_pro_monthly", "unused", [], "SANDBOX"),
        true
    );
    assert.equal(
        hasPriorProPurchaseOrTrial(subscriber, "example_pro_monthly", "unused", [], "PRODUCTION"),
        false
    );
    assert.equal(
        hasPriorProPurchaseOrTrial(subscriber, "unused", "example_pro_yearly", [], "PRODUCTION"),
        true
    );
    assert.equal(
        hasPriorProPurchaseOrTrial(subscriber, "unused", "example_pro_yearly", [], "SANDBOX"),
        false
    );
});

test("unknown subscription environment fails closed for recipient eligibility", () => {
    const subscriber = {
        subscriptions: {
            example_pro_monthly: {period_type: "trial", purchase_date: "2026-01-01"}
        }
    };

    assert.equal(
        hasPriorProPurchaseOrTrial(subscriber, "example_pro_monthly", "example_pro_yearly", [], "SANDBOX"),
        true
    );
    assert.equal(
        hasPriorProPurchaseOrTrial(subscriber, "example_pro_monthly", "example_pro_yearly", [], "PRODUCTION"),
        true
    );
});

test("lifetime history is environment scoped across mixed purchase history", () => {
    const subscriber = {
        non_subscriptions: {
            example_pro_lifetime: [
                {purchase_date: "2026-01-01", is_sandbox: true},
                {purchase_date: "2026-02-01", is_sandbox: false}
            ],
            unrelated_lifetime: [{purchase_date: "2026-03-01", is_sandbox: true}]
        }
    };

    assert.equal(hasLifetimePurchase(subscriber, ["example_pro_lifetime"], "SANDBOX"), true);
    assert.equal(hasLifetimePurchase(subscriber, ["example_pro_lifetime"], "PRODUCTION"), true);
    assert.equal(hasLifetimePurchase(subscriber, ["unrelated"], "SANDBOX"), false);
    assert.equal(
        hasPriorProPurchaseOrTrial(
            subscriber,
            "example_pro_monthly",
            "example_pro_yearly",
            ["example_pro_lifetime"],
            "PRODUCTION"
        ),
        true
    );
});

test("active product requires matching environment and an unexpired entitlement", () => {
    const active = {
        entitlements: {
            "Example Pro": {
                product_identifier: "example_pro_yearly",
                expires_date: "2999-01-01T00:00:00Z"
            }
        },
        subscriptions: {
            example_pro_yearly: {environment: "PRODUCTION"}
        }
    };
    const expired = {
        entitlements: {
            "Example Pro": {
                product_identifier: "example_pro_monthly",
                expires_date: "2020-01-01T00:00:00Z"
            }
        },
        subscriptions: {
            example_pro_monthly: {environment: "SANDBOX"}
        }
    };
    const unknownEnvironment = {
        entitlements: {
            "Example Pro": {product_identifier: "example_pro_monthly"}
        }
    };

    assert.equal(
        activeProSubscriptionProduct(active, "Example Pro", "example_pro_monthly", "example_pro_yearly", "PRODUCTION"),
        "yearly"
    );
    assert.equal(
        activeProSubscriptionProduct(active, "Example Pro", "example_pro_monthly", "example_pro_yearly", "SANDBOX"),
        undefined
    );
    assert.equal(
        activeProSubscriptionProduct(expired, "Example Pro", "example_pro_monthly", "example_pro_yearly", "SANDBOX"),
        undefined
    );
    assert.equal(
        activeProSubscriptionProduct(
            unknownEnvironment,
            "Example Pro",
            "example_pro_monthly",
            "example_pro_yearly",
            "PRODUCTION"
        ),
        undefined
    );
});
