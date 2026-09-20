// Typed, safe-to-display errors. Per docs/API_CONTRACTS.md an error exposes a code, a
// safe message and whether a retry is meaningful; it never carries credentials, a raw
// provider body or an internal prompt.

export type JamErrorCode =
  | "not_configured"
  | "unauthenticated"
  | "invalid_input"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "unavailable";

export class JamError extends Error {
  readonly code: JamErrorCode;
  readonly safeMessage: string;
  readonly retryable: boolean;

  constructor(code: JamErrorCode, safeMessage: string, retryable = false) {
    super(safeMessage);
    this.name = "JamError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.retryable = retryable;
  }
}

type PostgrestLike = { code?: string | null; message?: string | null } | null | undefined;

/**
 * Our database functions prefix every message they raise with this marker. A message
 * without it came from Postgres itself and may name a schema, table or constraint, so it
 * is replaced by the fixed text below instead of being forwarded to a participant.
 */
const RAISED_BY_SCHEMA = "jam: ";

const SQLSTATE: Record<string, { code: JamErrorCode; message: string; retryable?: boolean }> = {
  "28000": { code: "unauthenticated", message: "Your session is no longer signed in. Reload the page to continue." },
  "22023": { code: "invalid_input", message: "That request was not valid." },
  P0002: { code: "not_found", message: "That invite code does not match an open jam." },
  "42501": { code: "forbidden", message: "You are not allowed to do that in this jam." },
  "23505": { code: "conflict", message: "That record already exists." },
  // A value the schema refuses. Retrying sends the same value, so this is never retryable —
  // reported as an outage it looked like one, and an operator whose database predates a
  // migration was told to wait rather than to migrate.
  "23514": { code: "invalid_input", message: "That is not a value this room accepts. The room database may be missing a migration." },
  // A foreign key failure on insert means the identity this browser kept no longer has a
  // user record (for example after the project database is reset). It is actionable, not
  // a mystery outage: reloading re-runs identity confirmation and signs in again.
  "23503": { code: "unauthenticated", message: "Your session is no longer recognized. Reload the page to sign in again." },
  // The migrations were never applied or are incomplete. Name the fix instead of hiding it
  // behind the operation's generic fallback, which made a missing table look like an outage.
  "42P01": { code: "not_configured", message: "The room database is missing a required table. Apply the Supabase migrations." },
  PGRST205: { code: "not_configured", message: "The room database is missing a required table. Apply the Supabase migrations." },
  "42883": { code: "not_configured", message: "The room database is missing a required function. Apply the Supabase migrations." },
  PGRST202: { code: "not_configured", message: "The room database is missing a required function. Apply the Supabase migrations." },
  "53400": { code: "rate_limited", message: "Too many attempts. Wait a few minutes and try again.", retryable: true },
  PGRST301: { code: "unauthenticated", message: "Your session is no longer signed in. Reload the page to continue." },
};

/**
 * True when Supabase Auth rejected the stored session because the identity it points at
 * no longer exists or can no longer be used. A 4xx from the auth server is definitive; a
 * transient network failure reports status 0/undefined and must not be treated as stale,
 * or a flaky connection would silently replace the participant's identity.
 */
export function isStaleIdentityError(error: { status?: number | null } | null | undefined): boolean {
  const status = error?.status;
  return status === 400 || status === 401 || status === 403;
}

/**
 * Maps a Supabase/PostgREST failure onto a typed error. Only a message our own schema
 * authored is shown; anything else becomes fixed safe text, so no driver string, schema
 * name or constraint name can reach the UI.
 */
export function toJamError(error: PostgrestLike, fallback: string): JamError {
  const mapped = error?.code ? SQLSTATE[error.code] : undefined;
  if (!mapped) return new JamError("unavailable", fallback, true);

  const raw = error?.message ?? "";
  const authored = raw.startsWith(RAISED_BY_SCHEMA) ? raw.slice(RAISED_BY_SCHEMA.length) : null;
  return new JamError(mapped.code, authored ?? mapped.message, mapped.retryable ?? false);
}

export function notConfigured(action: string) {
  return new JamError("not_configured", `${action} needs a configured Supabase project. This preview cannot reach a room.`);
}

export function safeMessageOf(error: unknown, fallback: string): string {
  if (error instanceof JamError) return error.safeMessage;
  return fallback;
}
