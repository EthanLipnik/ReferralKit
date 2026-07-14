export class HTTPError extends Error { constructor(public status: number, public code: string, message = code) { super(message); } }
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
export async function body<T>(request: Request): Promise<T> {
    if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) throw new HTTPError(415,"json_required");
    try { return await request.json<T>(); } catch { throw new HTTPError(400,"invalid_json"); }
}
