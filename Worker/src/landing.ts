import { hmac, normalizeCode, isValidCode } from "./crypto";
import { Env } from "./env";
import { HTTPError } from "./http";

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

export async function landing(request: Request, env: Env, code: string): Promise<Response> {
    const normalizedCode = normalizeCode(code, env.CODE_PREFIX);
    if (!isValidCode(normalizedCode, env.CODE_PREFIX)) {
        throw new HTTPError(404, "not_found");
    }
    const existing = await env.DB.prepare(
        "SELECT 1 present FROM referral_codes WHERE code_hash=? AND revoked_at IS NULL"
    ).bind(await hmac(env.CODE_HASH_SECRET, normalizedCode)).first<{present: number}>();
    if (!existing) throw new HTTPError(404, "not_found");

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

    return new Response(html, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public,max-age=300",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
        },
    });
}
