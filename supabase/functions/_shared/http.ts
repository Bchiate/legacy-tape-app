/** Response helpers shared by the edge functions. */

const DEFAULT_ALLOWED_HEADERS = "authorization, apikey, content-type, x-client-info";

/**
 * CORS headers. Callers authenticate with a header (a pairing token or a
 * bearer JWT), never cookies, so any origin may call. The preflight's
 * requested headers are echoed back because supabase-js adds its own headers
 * (x-client-info, x-supabase-api-version) and a fixed list falls behind.
 */
export function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers") ??
      DEFAULT_ALLOWED_HEADERS,
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

/**
 * Handles what every function rejects or answers the same way: CORS preflight
 * and methods other than POST. Returns null when the request should proceed.
 */
export function earlyResponse(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") return json(req, { error: "method not allowed" }, 405);
  return null;
}

/** Turns an unexpected exception into a logged 500, so callers always get JSON back. */
export function withErrorHandling(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (error) {
      console.error(error);
      return json(req, { error: "internal error" }, 500);
    }
  };
}
