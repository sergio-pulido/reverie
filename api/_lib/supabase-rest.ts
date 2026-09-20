// Server-side identity and membership checks against Supabase.
//
// The function never holds a service-role key. It presents the caller's own access token,
// so every read below is still filtered by the same Row Level Security policies the browser
// is subject to: the server cannot see more than the participant it is acting for.

const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_ACCESS_TOKEN_LENGTH = 4_096;

export type SupabaseConfig = { url: string; anonKey: string };

export type MembershipFacts = {
  userId: string;
  role: "host" | "member";
  status: string;
  jamStatus: string;
};

export type SupabaseRestOptions = { timeoutMs?: number; fetchImpl?: typeof fetch };

export class RestError extends Error {
  readonly code: "unauthenticated" | "forbidden" | "unavailable";

  constructor(code: RestError["code"], message: string) {
    super(message);
    this.name = "RestError";
    this.code = code;
  }
}

export function readSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig | null {
  const url = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL)?.trim().replace(/\/$/, "");
  const anonKey = (env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY)?.trim();
  return url && anonKey ? { url, anonKey } : null;
}

/** A bounded, syntactically plausible bearer token, or null. It is never logged. */
export function readBearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || raw.length > MAX_ACCESS_TOKEN_LENGTH) return null;
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(raw.trim());
  return match ? match[1] : null;
}

async function getJson(
  config: SupabaseConfig,
  accessToken: string,
  path: string,
  options: SupabaseRestOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(`${config.url}${path}`, {
      method: "GET",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch {
    throw new RestError("unavailable", "The room directory could not be reached.");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new RestError("unauthenticated", "That session is not signed in.");
  }
  if (!response.ok) {
    throw new RestError("unavailable", "The room directory is not available right now.");
  }
  try {
    return await response.json();
  } catch {
    throw new RestError("unavailable", "The room directory returned an unexpected response.");
  }
}

/**
 * Resolves the caller. Identity comes from Supabase Auth verifying the presented token,
 * never from anything the browser claims about itself.
 */
export async function authenticate(
  config: SupabaseConfig,
  accessToken: string,
  options: SupabaseRestOptions = {},
): Promise<string> {
  const body = await getJson(config, accessToken, "/auth/v1/user", options);
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.length < 16) {
    throw new RestError("unauthenticated", "That session is not signed in.");
  }
  return id;
}

/**
 * Reads the caller's own membership row and the jam's status under RLS. A caller who is
 * not an active member of that jam simply has no row to read.
 */
export async function readMembership(
  config: SupabaseConfig,
  accessToken: string,
  jamId: string,
  userId: string,
  options: SupabaseRestOptions = {},
): Promise<MembershipFacts> {
  const members = await getJson(
    config,
    accessToken,
    `/rest/v1/jam_members?jam_id=eq.${jamId}&user_id=eq.${userId}&select=role,status&limit=1`,
    options,
  );
  const member = Array.isArray(members) ? (members[0] as { role?: unknown; status?: unknown }) : undefined;
  if (!member || (member.role !== "host" && member.role !== "member") || typeof member.status !== "string") {
    throw new RestError("forbidden", "You are not a member of this jam.");
  }

  const jams = await getJson(config, accessToken, `/rest/v1/jams?id=eq.${jamId}&select=status&limit=1`, options);
  const jam = Array.isArray(jams) ? (jams[0] as { status?: unknown }) : undefined;
  if (!jam || typeof jam.status !== "string") {
    throw new RestError("forbidden", "That jam is not open to you.");
  }

  return { userId, role: member.role, status: member.status, jamStatus: jam.status };
}

/**
 * Calls a constrained database function as the caller. The server has no privileged path
 * here either: `ensure_jam_live_session` refuses anyone who is not an active member.
 */
export async function callRpc(
  config: SupabaseConfig,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
  options: SupabaseRestOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(`${config.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
  } catch {
    throw new RestError("unavailable", "The room directory could not be reached.");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) throw new RestError("unauthenticated", "That session is not signed in.");
  if (response.status === 403) throw new RestError("forbidden", "You are not allowed to do that in this jam.");
  if (!response.ok) {
    // A Postgres error body can name a table or a constraint, so it is never forwarded.
    throw new RestError("unavailable", "The room refused that request.");
  }
  try {
    return await response.json();
  } catch {
    throw new RestError("unavailable", "The room directory returned an unexpected response.");
  }
}

/**
 * Reads the jam's live-consent register as the caller.
 *
 * Still under RLS: an active member sees the room's register, and nobody else sees anything.
 * The server holds no service-role key here either, so it cannot read a register for a
 * caller who could not read it themselves.
 */
export async function readLiveConsents(
  config: SupabaseConfig,
  accessToken: string,
  jamId: string,
  options: SupabaseRestOptions = {},
): Promise<unknown[]> {
  const rows = await getJson(
    config,
    accessToken,
    `/rest/v1/jam_live_consents?jam_id=eq.${jamId}` +
      "&select=id,jam_id,owner_id,kind,purpose,asset_ref,granted_at,expires_at,withdrawn_at" +
      "&order=granted_at.asc&limit=200",
    options,
  );
  if (!Array.isArray(rows)) {
    throw new RestError("unavailable", "The consent register returned an unexpected response.");
  }
  return rows;
}
