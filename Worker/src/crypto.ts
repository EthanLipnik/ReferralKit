const encoder = new TextEncoder();
export const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join("");
export const sha256 = async (value: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
export async function hmac(secret: string, value: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
    return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
export const randomID = () => crypto.randomUUID();
export function randomCode(prefix: string): string {
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; const bytes = crypto.getRandomValues(new Uint8Array(12));
    const chars = [...bytes].map(v => alphabet[v % alphabet.length]).join("");
    return `${prefix.toUpperCase()}-${chars.slice(0,4)}-${chars.slice(4,8)}-${chars.slice(8)}`;
}
export function normalizeCode(value: string, prefix: string): string {
    const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const normalizedPrefix = prefix.toUpperCase();
    if (!compact.startsWith(normalizedPrefix) || compact.length !== normalizedPrefix.length + 12) return compact;
    const suffix = compact.slice(normalizedPrefix.length);
    if (!/^[A-Z2-9]{12}$/.test(suffix)) return compact;
    return `${normalizedPrefix}-${suffix.slice(0, 4)}-${suffix.slice(4, 8)}-${suffix.slice(8)}`;
}
export function isValidCode(value: string, prefix: string): boolean {
    const normalizedPrefix = prefix.toUpperCase();
    return value.startsWith(`${normalizedPrefix}-`) &&
        value.slice(normalizedPrefix.length + 1).split("-").length === 3 &&
        value.slice(normalizedPrefix.length + 1).split("-").every(part => /^[A-Z2-9]{4}$/.test(part));
}
export function base64Bytes(value: string): ArrayBuffer {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    return Uint8Array.from(binary, c => c.charCodeAt(0)).buffer;
}
function bytesBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}
async function offerCodeKey(secret: string): Promise<CryptoKey> {
    const raw = new Uint8Array(base64Bytes(secret));
    if (raw.byteLength !== 32) throw new Error("invalid offer code encryption key");
    return crypto.subtle.importKey("raw", raw, {name:"AES-GCM"}, false, ["encrypt","decrypt"]);
}
export async function encryptOfferCode(secret: string, code: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({name:"AES-GCM",iv}, await offerCodeKey(secret), encoder.encode(code));
    return `v1.${bytesBase64(iv)}.${bytesBase64(new Uint8Array(encrypted))}`;
}
export async function decryptOfferCode(secret: string, value: string): Promise<string> {
    const [version,ivValue,ciphertextValue] = value.split(".");
    if (version !== "v1" || !ivValue || !ciphertextValue) throw new Error("invalid encrypted offer code");
    const decrypted = await crypto.subtle.decrypt(
        {name:"AES-GCM",iv:new Uint8Array(base64Bytes(ivValue))},
        await offerCodeKey(secret),
        base64Bytes(ciphertextValue)
    );
    return new TextDecoder().decode(decrypted);
}
function derToRaw(signature: Uint8Array): Uint8Array {
    if (signature.length === 64) return signature;
    if (signature[0] !== 0x30) throw new Error("invalid DER");
    let i = signature[1] & 0x80 ? 2 + (signature[1] & 0x7f) : 2;
    if (signature[i++] !== 0x02) throw new Error("invalid DER");
    const rLength = signature[i++], r = signature.slice(i, i + rLength); i += rLength;
    if (signature[i++] !== 0x02) throw new Error("invalid DER");
    const sLength = signature[i++], s = signature.slice(i, i + sLength);
    const raw = new Uint8Array(64); raw.set(r.slice(Math.max(0, r.length - 32)), 32 - Math.min(32, r.length)); raw.set(s.slice(Math.max(0, s.length - 32)), 64 - Math.min(32, s.length)); return raw;
}
export async function verifySignature(jwkJSON: string, signature: string, message: string): Promise<boolean> {
    try {
        const jwk = JSON.parse(jwkJSON) as JsonWebKey;
        if (jwk.kty !== "EC" || jwk.crv !== "P-256") return false;
        const key = await crypto.subtle.importKey("jwk", jwk, {name: "ECDSA", namedCurve: "P-256"}, false, ["verify"]);
        return crypto.subtle.verify({name: "ECDSA", hash: "SHA-256"}, key, base64Bytes(signature), encoder.encode(message));
    } catch { return false; }
}
export async function verifyX963Signature(publicKeyBase64: string, signature: string, message: string): Promise<boolean> {
    try {
        const key = await crypto.subtle.importKey("raw", base64Bytes(publicKeyBase64), {name:"ECDSA",namedCurve:"P-256"}, false, ["verify"]);
        const rawSignature = derToRaw(new Uint8Array(base64Bytes(signature)));
        const signatureBuffer = rawSignature.buffer.slice(
            rawSignature.byteOffset,
            rawSignature.byteOffset + rawSignature.byteLength
        ) as ArrayBuffer;
        return crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"}, key, signatureBuffer, encoder.encode(message));
    } catch { return false; }
}
