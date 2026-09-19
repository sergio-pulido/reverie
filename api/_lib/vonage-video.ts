// Vonage Video API adapter. Transport quirks stop here: the rest of the product sees a
// client auth id, a session id, a short-lived token and typed errors.
//
// Two credential shapes exist and the deployment picks one by what it configures.
//
// Application mode (current Vonage Video API, documentation fetched 2026-09-19 from
// https://developer.vonage.com/en/api/video and the @vonage/video 1.31.1 server SDK):
//   POST https://video.api.vonage.com/session/create
//   Authorization: Bearer <RS256 JWT { application_id, jti, iat, exp }>
//   form archiveMode=manual, p2p.preference=disabled -> [{ session_id, ... }]
//   Connection token: RS256 JWT { application_id, scope: "session.connect", session_id,
//   role, initial_layout_class_list, sub: "video", acl: { paths: { "/session/**": {} } },
//   iat, exp, jti }.
//
// Project mode (legacy OpenTok project key/secret, https://tokbox.com/developer/rest/):
//   POST https://api.opentok.com/session/create with header X-OPENTOK-AUTH carrying an
//   HS256 JWT { iss, ist: "project", iat, exp, jti } whose lifetime may not exceed five
//   minutes; the connection token is the same signature over the session claims.

import { createHmac, createSign, randomUUID } from "node:crypto";

export const LIVE_ROLES = ["subscriber", "publisher", "moderator"] as const;
export type LiveRole = (typeof LIVE_ROLES)[number];

export type VonageAuth =
  | { mode: "application"; applicationId: string; privateKey: string }
  | { mode: "project"; apiKey: string; apiSecret: string };

export type LiveErrorCode =
  | "LIVE_NOT_CONFIGURED"
  | "LIVE_UNAUTHORIZED"
  | "LIVE_TIMEOUT"
  | "LIVE_UNREACHABLE"
  | "LIVE_UPSTREAM_ERROR"
  | "LIVE_INVALID_RESPONSE";

export class LiveMediaError extends Error {
  readonly code: LiveErrorCode;
  readonly safeMessage: string;
  readonly retryable: boolean;

  constructor(code: LiveErrorCode, safeMessage: string, retryable = false) {
    super(safeMessage);
    this.name = "LiveMediaError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.retryable = retryable;
  }
}

const APPLICATION_HOST = "https://video.api.vonage.com";
const PROJECT_HOST = "https://api.opentok.com";
const API_JWT_TTL_SECONDS = 180; // Project mode documents a five-minute maximum.
const DEFAULT_TIMEOUT_MS = 8_000;

/** A connection token is deliberately short: a participant rejoins rather than holding one. */
export const TOKEN_TTL_SECONDS = 600;
export const TOKEN_MAX_TTL_SECONDS = 900;

/**
 * Live media exists only when it is switched on and fully credentialed. `null` means the
 * route refuses rather than inventing a session out of a half-configured deployment.
 * A legacy project key is numeric; an account-level API key is not, and is not accepted
 * here because it cannot create a video session.
 */
export function readVonageAuth(env: NodeJS.ProcessEnv = process.env): VonageAuth | null {
  if (env.REVERIE_LIVE_ENABLED !== "true") return null;

  const applicationId = env.VONAGE_APPLICATION_ID?.trim();
  const privateKey = env.VONAGE_PRIVATE_KEY?.trim().replace(/\\n/g, "\n");
  if (applicationId && privateKey?.includes("PRIVATE KEY")) {
    return { mode: "application", applicationId, privateKey };
  }

  const apiKey = env.VONAGE_API_KEY?.trim();
  const apiSecret = env.VONAGE_API_SECRET?.trim();
  if (apiKey && apiSecret && /^[0-9]{6,12}$/.test(apiKey)) {
    return { mode: "project", apiKey, apiSecret };
  }

  return null;
}

/** What the browser SDK needs to identify the project. It is public by design. */
export function clientAuthId(auth: VonageAuth): string {
  return auth.mode === "application" ? auth.applicationId : auth.apiKey;
}

function base64url(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(auth: VonageAuth, claims: Record<string, unknown>) {
  const algorithm = auth.mode === "application" ? "RS256" : "HS256";
  const header = base64url({ alg: algorithm, typ: "JWT" });
  const payload = base64url(claims);
  const signingInput = `${header}.${payload}`;

  const signature = auth.mode === "application"
    ? createSign("RSA-SHA256").update(signingInput).end().sign(auth.privateKey, "base64url")
    : createHmac("sha256", auth.apiSecret).update(signingInput).digest("base64url");

  return `${signingInput}.${signature}`;
}

/** Account-level JWT for REST calls. It never leaves the server. */
export function apiJwt(auth: VonageAuth, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1_000);
  const base = { iat: issuedAt, exp: issuedAt + API_JWT_TTL_SECONDS, jti: randomUUID() };
  return signJwt(auth, auth.mode === "application"
    ? { application_id: auth.applicationId, ...base }
    : { iss: auth.apiKey, ist: "project", ...base });
}

/**
 * Mints the token one participant uses to connect. The role is a server decision and the
 * lifetime is clamped here; there is no path that accepts a browser-supplied role or an
 * unbounded expiry.
 */
export function mintConnectionToken(
  auth: VonageAuth,
  options: { sessionId: string; role: LiveRole; ttlSeconds?: number; now?: number },
): { token: string; expiresAt: string } {
  if (!LIVE_ROLES.includes(options.role)) {
    throw new LiveMediaError("LIVE_INVALID_RESPONSE", "That live role is not available.");
  }
  const ttl = Math.min(Math.max(options.ttlSeconds ?? TOKEN_TTL_SECONDS, 60), TOKEN_MAX_TTL_SECONDS);
  const issuedAt = Math.floor((options.now ?? Date.now()) / 1_000);
  const exp = issuedAt + ttl;

  const shared = {
    scope: "session.connect",
    session_id: options.sessionId,
    role: options.role,
    initial_layout_class_list: "",
    iat: issuedAt,
    exp,
    jti: randomUUID(),
  };

  const token = signJwt(auth, auth.mode === "application"
    ? { application_id: auth.applicationId, sub: "video", acl: { paths: { "/session/**": {} } }, ...shared }
    : { iss: auth.apiKey, ist: "project", nonce: randomUUID(), ...shared });

  return { token, expiresAt: new Date(exp * 1_000).toISOString() };
}

/**
 * Creates a routed session with archiving off. `archiveMode=manual` is the documented
 * default and is sent explicitly so no later edit can make a room record by accident.
 */
export async function createVideoSession(
  auth: VonageAuth,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = auth.mode === "application" ? APPLICATION_HOST : PROJECT_HOST;
  const jwt = apiJwt(auth);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(`${host}/session/create`, {
      method: "POST",
      headers: {
        ...(auth.mode === "application" ? { Authorization: `Bearer ${jwt}` } : { "X-OPENTOK-AUTH": jwt }),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ "p2p.preference": "disabled", archiveMode: "manual" }).toString(),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw aborted
      ? new LiveMediaError("LIVE_TIMEOUT", "The live stage did not answer in time.", true)
      : new LiveMediaError("LIVE_UNREACHABLE", "The live stage could not be reached.", true);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    // The upstream body can quote the credential, so it is never surfaced.
    throw new LiveMediaError("LIVE_UNAUTHORIZED", "The live stage rejected this deployment's credentials.");
  }
  if (!response.ok) {
    throw new LiveMediaError("LIVE_UPSTREAM_ERROR", "The live stage is not available right now.", true);
  }

  const sessionId = parseSessionId(await response.text());
  if (!sessionId) {
    throw new LiveMediaError("LIVE_INVALID_RESPONSE", "The live stage returned an unexpected response.");
  }
  return sessionId;
}

/** The documented response is a one-element array; anything else is rejected, not coerced. */
export function parseSessionId(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0] as { session_id?: unknown };
  const sessionId = typeof first?.session_id === "string" ? first.session_id.trim() : "";
  return sessionId.length >= 16 && sessionId.length <= 512 ? sessionId : null;
}
