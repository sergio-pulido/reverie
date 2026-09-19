/**
 * What the account avatar draws. Pure, so it is the same in a test, on a TV and on a phone.
 *
 * The colour is *derived* from the Supabase user id rather than stored anywhere, which is what
 * makes it stable across visits and devices: the same anonymous identity always draws the same
 * circle, and a new one (after a sign-out) draws a different one.
 */

/**
 * Circle colours, all dark enough for the initials to stay white on them. The list is fixed:
 * adding or reordering it would move every existing viewer's colour, so it is append-only.
 */
const AVATAR_COLOURS: readonly string[] = [
  "#6b3fb8",
  "#2a63bd",
  "#186b5e",
  "#7a5c15",
  "#a34327",
  "#94336a",
  "#39528f",
  "#4f6a24",
];

/** The neutral circle for a viewer with no session yet. It is never one of the derived colours. */
export const NEUTRAL_AVATAR_COLOUR = "#39405a";

/** FNV-1a, 32-bit. Chosen because it is short, stable and has no dependency. */
function hashOf(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The circle colour for a Supabase user id. The same id always answers the same colour. */
export function avatarColour(userId: string | null): string {
  if (!userId) return NEUTRAL_AVATAR_COLOUR;
  return AVATAR_COLOURS[hashOf(userId) % AVATAR_COLOURS.length];
}

/**
 * The initials drawn in the circle: the first letter of the first and last words of the name the
 * viewer gave a room. An empty string means there is no name, and the circle shows a neutral mark
 * instead — a name is never invented, and neither is an email or a photo.
 */
export function initialsOf(displayName: string | null): string {
  const words = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const chosen = words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]];
  return chosen.map((word) => [...word][0].toLocaleUpperCase()).join("");
}
