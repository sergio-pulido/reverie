import { readSupabaseConfig, type SupabaseConfig } from "./supabase-rest.js";

/**
 * A catalogue read with no viewer behind it.
 *
 * Every other server path presents the caller's own access token, so it can see no more than
 * the participant it acts for. `/api/evaluate` has no participant: it is a harness calling with
 * a static token of its own, and a viewer's token must never be accepted there. The catalogue
 * RPC is granted to `authenticated` and revoked from `anon`, so the anon key alone cannot read
 * it; this module resolves a credential the server owns instead.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is used when it is set. Otherwise the server signs itself in
 * anonymously with the anon key and caches that session per process, so a warm instance mints
 * one session rather than one per request. The token is held in memory only, and never logged,
 * returned or written anywhere a response can reach.
 */

const DEFAULT_TIMEOUT_MS = 6_000;
/** Refreshed this far before expiry, so a token never runs out mid-read. */
const EXPIRY_MARGIN_MS = 60_000;

export type ServerSessionOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
};

type CachedSession = { token: string; expiresAt: number };

let cached: CachedSession | null = null;
let pending: Promise<CachedSession | null> | null = null;

/** Drops the cached anonymous session. Tests call this so one does not leak into the next. */
export function forgetServerSession(): void {
  cached = null;
  pending = null;
}

/**
 * A bearer token for reads the server makes on its own behalf, or null when Supabase is not
 * configured or would not issue one. Callers report that as "not configured"; nothing is faked.
 */
export async function serverAccessToken(options: ServerSessionOptions = {}): Promise<string | null> {
  const config = readSupabaseConfig(options.env ?? process.env);
  if (!config) return null;

  const serviceRoleKey = (options.env ?? process.env).SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (serviceRoleKey) return serviceRoleKey;

  const now = options.now ?? Date.now;
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.token;
  pending ??= signInAnonymously(config, options).finally(() => {
    pending = null;
  });
  const session = await pending;
  if (!session) return null;
  cached = session;
  return session.token;
}

/**
 * One anonymous session, over the Auth REST endpoint the browser client uses. A failure returns
 * null rather than throwing: the caller answers "the catalogue could not be reached", which is
 * what a viewer would have been told too.
 */
async function signInAnonymously(config: SupabaseConfig, options: ServerSessionOptions): Promise<CachedSession | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(`${config.url}/auth/v1/signup`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ data: {} }),
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const session = body as { access_token?: unknown; expires_in?: unknown } | null;
  const token = session?.access_token;
  if (typeof token !== "string" || token.length === 0) return null;
  const lifetimeMs = typeof session?.expires_in === "number" && session.expires_in > 0 ? session.expires_in * 1_000 : 0;
  return { token, expiresAt: (options.now ?? Date.now)() + lifetimeMs };
}
