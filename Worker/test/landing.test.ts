import assert from "node:assert/strict";
import test from "node:test";
import { landing } from "../src/landing";
import type { PublicResponseCache } from "../src/landing";

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
        const response = await landing(
            new Request(`https://example.com/r/EXMP-7K4P-Q9TX-ABCD?state=${state}`),
            unavailable,
            "EXMP-7K4P-Q9TX-ABCD",
        );
        const html = await response.text();

        assert.equal(response.status, 404);
        assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
        assert.match(html, /This referral link isn’t available\./);
        assert.match(html, /Get Example/);
        assert.doesNotMatch(html, /EXMP-7K4P-Q9TX-ABCD/);
    }
});

test("invalid referral codes return friendly HTML without querying D1", async () => {
    const invalid = {
        ...env,
        DB: {prepare: () => {
            throw new Error("invalid codes must not query D1");
        }},
    };
    const response = await landing(
        new Request("https://example.com/r/not-a-code"),
        invalid,
        "not-a-code",
    );

    assert.equal(response.status, 404);
    assert.match(await response.text(), /invalid, expired, or no longer active/);
});

test("landing cache canonicalizes query parameters and avoids repeated D1 reads", async () => {
    const responses = new Map<string, Response>();
    const cache: PublicResponseCache = {
        match: async request => responses.get(request.url)?.clone(),
        put: async (request, response) => {
            responses.set(request.url, response.clone());
        },
    };
    let databaseReads = 0;
    const cachedEnv = {
        ...env,
        DB: {prepare: () => ({bind: () => ({first: async () => {
            databaseReads += 1;
            return {present: 1};
        }})})},
    };
    const backgroundWrites: Promise<unknown>[] = [];
    const first = await landing(
        new Request("https://example.com/r/EXMP-7K4P-Q9TX-ABCD?preview=first"),
        cachedEnv,
        "EXMP-7K4P-Q9TX-ABCD",
        {
            cache,
            waitUntil: promise => {
                backgroundWrites.push(promise);
            },
        },
    );
    await Promise.all(backgroundWrites);
    const second = await landing(
        new Request("https://example.com/r/EXMP-7K4P-Q9TX-ABCD?preview=second"),
        cachedEnv,
        "EXMP-7K4P-Q9TX-ABCD",
        {cache},
    );

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(databaseReads, 1);
    assert.deepEqual([...responses.keys()], [
        "https://example.com/r/EXMP-7K4P-Q9TX-ABCD",
    ]);
});
