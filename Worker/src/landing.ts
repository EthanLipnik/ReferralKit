import { hmac, normalizeCode, isValidCode } from "./crypto";
import { Env } from "./env";

export interface PublicResponseCache {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
}

export interface PublicResponseContext {
    cache?: PublicResponseCache;
    waitUntil?: (promise: Promise<unknown>) => void;
}

function escapeHTML(value: string): string {
    return value.replace(
        /[&<>"']/g,
        character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "\"": "&quot;",
            "'": "&#39;",
        })[character]!,
    );
}

function securityHeaders(cacheControl: string): HeadersInit {
    return {
        "cache-control": cacheControl,
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
    };
}

function canonicalCacheRequest(request: Request, normalizedCode: string): Request {
    const url = new URL(request.url);
    // Query parameters never affect referral validity, so one cache entry absorbs
    // repeated previews of the same public link instead of repeating a D1 lookup.
    url.pathname = `/r/${encodeURIComponent(normalizedCode)}`;
    url.search = "";
    url.hash = "";
    return new Request(url, {method: "GET"});
}

async function cachedResponse(
    context: PublicResponseContext,
    request: Request,
): Promise<Response | undefined> {
    if (!context.cache) return undefined;
    try {
        return await context.cache.match(request);
    } catch (error) {
        // Public pages remain available when a local edge cache is unavailable.
        console.warn("Referral landing cache read failed", {
            error: error instanceof Error ? error.message : "unknown_error",
        });
        return undefined;
    }
}

async function storeResponse(
    context: PublicResponseContext,
    request: Request,
    response: Response,
): Promise<void> {
    if (!context.cache) return;
    const write = context.cache.put(request, response.clone()).catch(error => {
        // Cache writes are an optimization and never participate in redemption safety.
        console.warn("Referral landing cache write failed", {
            error: error instanceof Error ? error.message : "unknown_error",
        });
    });
    if (context.waitUntil) {
        context.waitUntil(write);
    } else {
        await write;
    }
}

export function unavailableLanding(env: Env): Response {
    const appName = escapeHTML(env.APP_NAME);
    const appStoreURL = escapeHTML(env.APP_STORE_URL);
    const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Referral link unavailable</title>
<style>
body{font:17px system-ui;margin:0;background:#f4f1eb;color:#191816;display:grid;min-height:100vh;place-items:center}
.c{max-width:34rem;padding:3rem;text-align:center}
h1{font-size:clamp(2rem,7vw,4rem);line-height:1}
a{display:inline-block;margin:.6rem;padding:.8rem 1.2rem;border-radius:99px;background:#191816;color:white;text-decoration:none}
</style>
<main class="c">
<h1>This referral link isn’t available.</h1>
<p>It may be invalid, expired, or no longer active. You can still get ${appName} from the App Store.</p>
<a href="${appStoreURL}">Get ${appName}</a>
</main>
</html>`;
    return new Response(html, {
        status: 404,
        // A short cache absorbs repeated link previews while allowing prompt recovery
        // from an operator mistake or a transiently unavailable code.
        headers: securityHeaders("public,max-age=60"),
    });
}

export async function landing(
    request: Request,
    env: Env,
    code: string,
    context: PublicResponseContext = {},
): Promise<Response> {
    const normalizedCode = normalizeCode(code, env.CODE_PREFIX);
    if (!isValidCode(normalizedCode, env.CODE_PREFIX)) {
        return unavailableLanding(env);
    }
    const cacheRequest = canonicalCacheRequest(request, normalizedCode);
    const cached = await cachedResponse(context, cacheRequest);
    if (cached) return cached;

    const existing = await env.DB.prepare(
        "SELECT 1 present FROM referral_codes WHERE code_hash=? AND revoked_at IS NULL"
    ).bind(await hmac(env.CODE_HASH_SECRET, normalizedCode)).first<{present: number}>();
    if (!existing) {
        const response = unavailableLanding(env);
        await storeResponse(context, cacheRequest, response);
        return response;
    }

    const escapedCode = escapeHTML(normalizedCode);
    const appName = escapeHTML(env.APP_NAME);
    const proName = escapeHTML(env.PRO_NAME);
    const appStoreURL = escapeHTML(env.APP_STORE_URL);
    const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Your first month of ${proName} is on us</title>
<style>
body{font:17px system-ui;margin:0;background:#f4f1eb;color:#191816;display:grid;min-height:100vh;place-items:center}
.c{max-width:34rem;padding:3rem;text-align:center}
h1{font-size:clamp(2rem,7vw,4rem);line-height:1}
.code{font:700 1.25rem ui-monospace;padding:1rem;border:1px solid #aaa;border-radius:12px;background:white}
a,button{display:inline-block;margin:.6rem;padding:.8rem 1.2rem;border-radius:99px;background:#191816;color:white;text-decoration:none;border:0;font:inherit}
.status{min-height:1.25em;color:#555}
</style>
<main class="c">
<h1>Your first month of ${proName} is on us.</h1>
<p>After you set up ${appName}, enter this referral code in the app:</p>
<p class="code" id="code">${escapedCode}</p>
<button id="copy-code" type="button">Copy code</button>
<a href="${appStoreURL}">Get ${appName}</a>
<p class="status" id="copy-status" role="status" aria-live="polite" aria-atomic="true"></p>
</main>
<script>
const button=document.getElementById('copy-code');
const status=document.getElementById('copy-status');
button.addEventListener('click',async()=>{
    try{
        await navigator.clipboard.writeText(document.getElementById('code').textContent);
        button.textContent='Copied';
        status.textContent='Referral code copied.';
        setTimeout(()=>{button.textContent='Copy code';status.textContent='';},2000);
    }catch{
        status.textContent='Could not copy the code. Select it above to copy it manually.';
    }
});
</script>
</html>`;

    const response = new Response(html, {
        // Redemption and claim endpoints always re-check D1. This short public-page
        // cache reduces repeated preview traffic without weakening revocation safety.
        headers: securityHeaders("public,max-age=300"),
    });
    await storeResponse(context, cacheRequest, response);
    return response;
}
