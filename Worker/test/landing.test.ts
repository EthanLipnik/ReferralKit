import assert from "node:assert/strict";
import test from "node:test";
import { landing } from "../src/landing";
import { HTTPError } from "../src/http";

const env = {
    APP_NAME: "Example",
    PRO_NAME: "Example Pro",
    APP_STORE_URL: "https://apps.apple.com/app/id6757893115",
    CODE_PREFIX: "EXMP",
    CODE_HASH_SECRET: "code-secret",
    DB: {prepare: () => ({bind: () => ({first: async () => ({present: 1})})})},
} as any;

test("landing page explains setup and omits tracking and gift copy", async () => {
    const response = await landing(
        new Request("https://example.com/r/EXMP-7K4P-Q9TX-ABCD"),
        env,
        "EXMP-7K4P-Q9TX-ABCD",
    );
    const html = await response.text();

    assert.match(html, /Your first month of Example Pro is on us\./);
    assert.match(html, /After you set up Example, enter this referral code in the app:/);
    assert.doesNotMatch(html, /gift/i);
    assert.doesNotMatch(html, /tracking|IP-based attribution/i);
});

test("landing page reports clipboard success and failure accessibly", async () => {
    const response = await landing(
        new Request("https://example.com/r/EXMP-7K4P-Q9TX-ABCD"),
        env,
        "EXMP-7K4P-Q9TX-ABCD",
    );
    const html = await response.text();

    assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(html, /button\.textContent='Copied'/);
    assert.match(html, /Referral code copied\./);
    assert.match(html, /Could not copy the code\./);
});

test("landing page rejects unknown and revoked referral codes", async () => {
    for (const state of ["unknown", "revoked"]) {
        const unavailable = {
            ...env,
            DB: {prepare: () => ({bind: () => ({first: async () => null})})},
        };
        await assert.rejects(
            landing(
                new Request(`https://example.com/r/EXMP-7K4P-Q9TX-ABCD?state=${state}`),
                unavailable,
                "EXMP-7K4P-Q9TX-ABCD",
            ),
            (error: unknown) => error instanceof HTTPError && error.status === 404,
        );
    }
});
