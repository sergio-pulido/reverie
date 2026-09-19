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
  "53400": { code: "rate_limited", message: "Too many attempts. Wait a few minutes and try again.", retryable: true },
  PGRST301: { code: "unauthenticated", message: "Your session is no longer signed in. Reload the page to continue." },
};

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
