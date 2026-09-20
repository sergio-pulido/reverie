import { createHash } from "node:crypto";
import type { Request } from "express";
import {
  authenticate,
  readBearerToken,
  readMembership,
  readSupabaseConfig,
  RestError,
} from "../../api/_lib/supabase-rest";

/**
 * Who is asking, for the escape-room routes.
 *
 * These routes spend money and move a shared world, so unlike the other
 * routes this Express host serves, they do not take the browser's word for
 * who it is. Identity comes from Supabase Auth verifying the presented access
 * token, and the role comes from the caller's own `jam_members` row read
 * under Row Level Security with that same token — this server holds no
 * service-role key for it and can see no more than the participant it is
 * acting for.
 *
 * A room is polled every few seconds by everyone in it, so the answer is
 * cached briefly. The cache is keyed on a digest of the token rather than the
 * token, so a long-lived structure never holds a credential; an admission or
 * a removal therefore takes up to `TTL_MS` to be felt, which is the price of
 * not making two Supabase calls per participant per poll.
 */

const TTL_MS = 20_000;
const MAX_CACHED = 256;

export interface EscapeCaller {
  userId: string;
  role: "host" | "member";
  status: string;
}

export class EscapeAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EscapeAuthError";
  }
}

export type Authorize = (request: Request, jamId: string) => Promise<EscapeCaller>;

interface CacheEntry {
  caller: EscapeCaller;
  expiresAt: number;
}

export function createSupabaseAuthorize(
  now: () => number = () => Date.now(),
): Authorize {
  const cache = new Map<string, CacheEntry>();

  return async function authorize(request: Request, jamId: string): Promise<EscapeCaller> {
    const config = readSupabaseConfig();
    if (!config) {
      throw new EscapeAuthError(
        503,
        "escape_unauthenticated",
        "This server has no Supabase configuration, so it cannot tell who you are.",
      );
    }
    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      throw new EscapeAuthError(401, "escape_unauthenticated", "Sign in to open this room.");
    }
    const key = `${jamId}:${createHash("sha256").update(token).digest("hex")}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.caller;

    let caller: EscapeCaller;
    try {
      const userId = await authenticate(config, token);
      const membership = await readMembership(config, token, jamId, userId);
      caller = { userId, role: membership.role, status: membership.status };
    } catch (error) {
      if (error instanceof RestError) {
        if (error.code === "unauthenticated") {
          throw new EscapeAuthError(401, "escape_unauthenticated", "That session is not signed in.");
        }
        if (error.code === "forbidden") {
          throw new EscapeAuthError(403, "escape_forbidden", "You are not a member of this room.");
        }
        throw new EscapeAuthError(503, "escape_unavailable", "Membership could not be checked.");
      }
      throw error;
    }
    if (caller.status !== "active") {
      throw new EscapeAuthError(403, "escape_forbidden", "You are not an active member of this room.");
    }
    if (cache.size >= MAX_CACHED) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { caller, expiresAt: now() + TTL_MS });
    return caller;
  };
}

export function requireHost(caller: EscapeCaller): void {
  if (caller.role !== "host") {
    throw new EscapeAuthError(403, "escape_forbidden", "Only the host can do that.");
  }
}
