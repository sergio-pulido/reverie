import type { IncomingMessage, ServerResponse } from "node:http";
import { decideLiveAccess, liveTokenRequestSchema } from "../../src/core/liveMedia";
import {
  authenticate,
  callRpc,
  readBearerToken,
  readMembership,
  readSupabaseConfig,
  RestError,
  type SupabaseRestOptions,
} from "../_lib/supabase-rest";
import {
  clientAuthId,
  createVideoSession,
  LiveMediaError,
  mintConnectionToken,
  readVonageAuth,
  TOKEN_TTL_SECONDS,
  type VonageAuth,
} from "../_lib/vonage-video";
import { clientKey, createRateLimiter, isSameOrigin, sendJson } from "../_lib/http";

const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 2_048;

const allowRequest = createRateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS);

export type LiveTokenOptions = SupabaseRestOptions & {
  env?: NodeJS.ProcessEnv;
  auth?: VonageAuth | null;
};

function fail(response: ServerResponse, statusCode: number, code: string, safeMessage: string, retryable = false) {
  sendJson(response, statusCode, { status: "error", code, safeMessage, retryable });
}

/** Reads a small JSON body. A body beyond the cap is refused rather than buffered. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Issues one short-lived Vonage connection token to one active member of one jam.
 *
 * Identity comes from Supabase Auth, membership from the caller's own RLS-filtered row,
 * and the role from that membership. Nothing privileged is derived from the request body,
 * which carries a jam id and nothing else.
 */
export default async function liveToken(
  request: IncomingMessage,
  response: ServerResponse,
  options: LiveTokenOptions = {},
) {
  const env = options.env ?? process.env;

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    fail(response, 405, "METHOD_NOT_ALLOWED", "Only POST is supported.");
    return;
  }
  if (!isSameOrigin(request)) {
    fail(response, 403, "CROSS_ORIGIN_BLOCKED", "This endpoint only answers same-origin requests.");
    return;
  }
  if (!allowRequest(clientKey(request))) {
    response.setHeader("Retry-After", String(RATE_LIMIT_WINDOW_MS / 1_000));
    fail(response, 429, "RATE_LIMITED", "Too many live requests. Try again shortly.", true);
    return;
  }

  const vonage = options.auth !== undefined ? options.auth : readVonageAuth(env);
  const supabase = readSupabaseConfig(env);
  if (!vonage || !supabase) {
    sendJson(response, 200, {
      status: "live_not_configured",
      code: "LIVE_NOT_CONFIGURED",
      safeMessage: "Live media is not enabled for this deployment.",
      missing: [
        ...(vonage ? [] : ["vonage"]),
        ...(supabase ? [] : ["supabase"]),
      ],
    });
    return;
  }

  const accessToken = readBearerToken(request.headers.authorization);
  if (!accessToken) {
    fail(response, 401, "LIVE_UNAUTHENTICATED", "Sign in to the jam before joining the live stage.");
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    fail(response, 400, "INVALID_REQUEST", "That request was not valid.");
    return;
  }

  const parsed = liveTokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    fail(response, 400, "INVALID_REQUEST", "That request was not valid.");
    return;
  }
  const { jamId } = parsed.data;

  try {
    const userId = await authenticate(supabase, accessToken, options);
    const facts = await readMembership(supabase, accessToken, jamId, userId, options);
    const decision = decideLiveAccess(facts);
    if (!decision.allowed) {
      fail(
        response,
        403,
        "LIVE_FORBIDDEN",
        decision.reason === "jam_closed"
          ? "This jam is no longer open."
          : "The host has not admitted you to this jam yet.",
      );
      return;
    }

    // Reserve durable ownership before creating an external room. Without this step every
    // concurrent join could allocate an unused Vonage session before Postgres settled on one.
    const reservation = await callRpc(supabase, accessToken, "reserve_jam_live_session", {
      p_jam_id: jamId,
    }, options);
    const reserved = reservation as { state?: unknown; sessionId?: unknown; reservationId?: unknown };
    let sessionId: unknown = reserved.sessionId;
    if (reserved.state === "reserved" && typeof reserved.reservationId === "string") {
      const created = await createVideoSession(vonage, options);
      sessionId = await callRpc(supabase, accessToken, "finalize_jam_live_session", {
        p_jam_id: jamId,
        p_reservation_id: reserved.reservationId,
        p_provider_session_id: created,
      }, options);
    } else if (reserved.state !== "ready") {
      fail(response, 503, "LIVE_SESSION_PENDING", "The live stage is opening. Try again shortly.", true);
      return;
    }
    if (typeof sessionId !== "string" || sessionId.length < 16) {
      fail(response, 502, "LIVE_UPSTREAM_ERROR", "The live stage is not available right now.", true);
      return;
    }

    const { token, expiresAt } = mintConnectionToken(vonage, {
      sessionId,
      role: decision.role,
      ttlSeconds: TOKEN_TTL_SECONDS,
    });

    sendJson(response, 200, {
      status: "ok",
      authId: clientAuthId(vonage),
      sessionId,
      token,
      role: decision.role,
      expiresAt,
    });
  } catch (error) {
    if (error instanceof RestError) {
      const statusCode = error.code === "unauthenticated" ? 401 : error.code === "forbidden" ? 403 : 503;
      fail(response, statusCode, `LIVE_${error.code.toUpperCase()}`, error.message, error.code === "unavailable");
      return;
    }
    if (error instanceof LiveMediaError) {
      fail(response, error.retryable ? 502 : 500, error.code, error.safeMessage, error.retryable);
      return;
    }
    fail(response, 500, "LIVE_UPSTREAM_ERROR", "The live stage is not available right now.", true);
  }
}
