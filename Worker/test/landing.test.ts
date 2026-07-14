import assert from "node:assert/strict";
import test from "node:test";
import { landing } from "../src/landing";

const env = {
    APP_NAME: "Mirage",
    PRO_NAME: "Mirage Pro",
    APP_STORE_URL: "https://apps.apple.com/app/id6757893115",
    CODE_PREFIX: "MIRA",
} as any;

test("landing page explains setup and omits tracking and gift copy", async () => {
    const response = landing(
        new Request("https://mirage.elipnik.com/r/MIRA-7K4P-Q9TX-ABCD"),
        env,
        "MIRA-7K4P-Q9TX-ABCD",
    );
    const html = await response.text();

    assert.match(html, /Your first month of Mirage Pro is on us\./);
    assert.match(html, /After you set up Mirage, enter this referral code in the app:/);
    assert.doesNotMatch(html, /gift/i);
    assert.doesNotMatch(html, /tracking|IP-based attribution/i);
});

test("landing page reports clipboard success and failure accessibly", async () => {
    const response = landing(
        new Request("https://mirage.elipnik.com/r/MIRA-7K4P-Q9TX-ABCD"),
        env,
        "MIRA-7K4P-Q9TX-ABCD",
    );
    const html = await response.text();

    assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(html, /button\.textContent='Copied'/);
    assert.match(html, /Referral code copied\./);
    assert.match(html, /Could not copy the code\./);
});
