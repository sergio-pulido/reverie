import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.statusCode = statusCode;
  response.end(JSON.stringify(payload));
}

export function requestUrl(request: IncomingMessage) {
  const host = request.headers.host ?? "127.0.0.1";
  return new URL(request.url ?? "/", `http://${host}`);
}

/**
 * Rejects cross-origin browser calls. A missing Origin header (same-origin GET, curl,
 * server-to-server) is allowed; a present, mismatched one is not.
 */
export function isSameOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = request.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function clientKey(request: IncomingMessage) {
  const forwarded = request.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(",")[0]?.trim();
  return first || request.socket.remoteAddress || "unknown";
}

type Bucket = { count: number; resetAt: number };

/**
 * Per-instance fixed-window limiter. Vercel functions are stateless and may scale out, so
 * this bounds one instance rather than the whole deployment. It is a cost guard, not an
 * authorization control.
 */
export function createRateLimiter(limit: number, windowMs: number, maxTrackedClients = 5_000) {
  const buckets = new Map<string, Bucket>();

  return function allow(key: string, now = Date.now()) {
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      if (buckets.size >= maxTrackedClients) buckets.clear();
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (existing.count >= limit) return false;
    buckets.set(key, { count: existing.count + 1, resetAt: existing.resetAt });
    return true;
  };
}
