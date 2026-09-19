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
