// Provider-free, browser-free invite and identity normalization.
// Imports nothing from React, the DOM, Supabase or any provider SDK.

/** Unambiguous alphabet shared with the database check constraint: no I, O or U. */
export const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTVWXYZ23456789";
export const INVITE_CODE_LENGTH = 8;
const INVITE_CODE_PATTERN = /^[A-HJ-NP-TV-Z2-9]{8}$/;

export const DISPLAY_NAME_MIN = 1;
export const DISPLAY_NAME_MAX = 32;

export type Normalized<T> = { ok: true; value: T } | { ok: false; message: string };

function invalid(message: string): Normalized<never> {
  return { ok: false, message };
}

/**
 * Accepts a bare code, a code with spaces or dashes, or an invite URL carrying
 * `?code=`/`#code=`. Anything else is rejected rather than guessed at, so a wrong
 * paste never becomes a silent lookup for a different room.
 */
export function normalizeInviteCode(raw: string): Normalized<string> {
  const input = (raw ?? "").trim();
  if (!input) return invalid("Enter the invite code the host shared with you.");

  const fromUrl = input.match(/[?#&]code=([^&\s]+)/i);
  const candidate = (fromUrl ? fromUrl[1] : input).toUpperCase().replace(/[\s-]+/g, "");

  if (!INVITE_CODE_PATTERN.test(candidate)) {
    return invalid(`An invite code is ${INVITE_CODE_LENGTH} characters, for example ABCD2345.`);
  }
  return { ok: true, value: candidate };
}

/** Collapses internal whitespace so two participants cannot look identical in the roster. */
export function normalizeDisplayName(raw: string): Normalized<string> {
  const value = (raw ?? "").replace(/\s+/g, " ").trim();
  if (value.length < DISPLAY_NAME_MIN) return invalid("Enter the name the room should see.");
  if (value.length > DISPLAY_NAME_MAX) {
    return invalid(`A display name is at most ${DISPLAY_NAME_MAX} characters.`);
  }
  return { ok: true, value };
}

/** The shareable invite for a jam. Never includes a session or token. */
export function inviteUrl(origin: string, slug: string, code: string) {
  return `${origin.replace(/\/+$/, "")}/join?jam=${encodeURIComponent(slug)}&code=${encodeURIComponent(code)}`;
}

/** Lifecycle of the room-level invite, mirroring `public.jam_invite_state`. */
export type InviteState = "active" | "expired" | "revoked";

/** Minutes a host can choose for a rotated invite; `null` means it does not expire. */
export const INVITE_TTL_MIN_MINUTES = 5;
export const INVITE_TTL_MAX_MINUTES = 1440;

export type JamInvite = {
  jamId: string;
  slug: string;
  code: string;
  expiresAt: string | null;
  revokedAt: string | null;
  state: InviteState;
};

/**
 * Recomputes the state from the timestamps rather than trusting the stored `state`,
 * because an invite that was active when it was fetched expires while the panel is open.
 * Revocation outranks expiry: a revoked invite never comes back by waiting.
 */
export function inviteState(invite: Pick<JamInvite, "expiresAt" | "revokedAt">, now = Date.now()): InviteState {
  if (invite.revokedAt) return "revoked";
  if (!invite.expiresAt) return "active";
  const expiry = Date.parse(invite.expiresAt);
  if (Number.isNaN(expiry)) return "active";
  return expiry <= now ? "expired" : "active";
}

/** Host-facing description of an invite. Never used to decide access; the database does that. */
export function describeInvite(invite: Pick<JamInvite, "expiresAt" | "revokedAt">, now = Date.now()): string {
  const state = inviteState(invite, now);
  if (state === "revoked") return "This invite was revoked. Rotate it to let anyone else in.";
  if (state === "expired") return "This invite has expired. Rotate it to let anyone else in.";
  if (!invite.expiresAt) return "This invite does not expire. Revoke it when the room is full.";

  const minutes = Math.max(1, Math.round((Date.parse(invite.expiresAt) - now) / 60_000));
  if (minutes < 60) return `This invite works for another ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  const hours = Math.round(minutes / 60);
  return `This invite works for about another ${hours} hour${hours === 1 ? "" : "s"}.`;
}

export function isInviteShareable(invite: Pick<JamInvite, "expiresAt" | "revokedAt">, now = Date.now()): boolean {
  return inviteState(invite, now) === "active";
}

/** Validates the host's chosen lifetime before it reaches the database. */
export function normalizeInviteMinutes(raw: number | null): Normalized<number | null> {
  if (raw === null) return { ok: true, value: null };
  if (!Number.isInteger(raw) || raw < INVITE_TTL_MIN_MINUTES || raw > INVITE_TTL_MAX_MINUTES) {
    return invalid(`An invite lasts between ${INVITE_TTL_MIN_MINUTES} minutes and 24 hours.`);
  }
  return { ok: true, value: raw };
}
