// Where the viewer's own playback configuration lives between screens.
//
// A session is created on the script screen, but the player also runs in the
// studio, which never sees that form (docs/specs/script-screen-actions.md,
// "Current gap"). Until sessions are unified with room membership, the browser
// remembers its own session per jam so both screens can play under the same
// configuration.
//
// The session's `ownerToken` is a secret and is deliberately NOT stored: it
// authorizes changing the session's settings, which only the screen that
// created it needs, and it stays in memory there.

import { z } from "zod";
import { sessionSettingsSchema, type JamSession, type SessionSettings } from "../core/session";

const storedJamSessionSchema = z.object({
  sessionId: z.uuid(),
  settings: sessionSettingsSchema,
});

export type StoredJamSession = z.infer<typeof storedJamSessionSchema>;

function storageKey(jamId: string): string {
  return `reverie.jam-session.${jamId}`;
}

export function rememberJamSession(session: JamSession): void {
  try {
    window.localStorage.setItem(
      storageKey(session.jamId),
      JSON.stringify({ sessionId: session.id, settings: session.settings }),
    );
  } catch {
    // A browser that refuses storage simply plays under the default
    // configuration on the next screen.
  }
}

export function readJamSession(jamId: string): StoredJamSession | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey(jamId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = storedJamSessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The configuration this browser watches the jam under, defaults included. */
export function readJamConfiguration(jamId: string): SessionSettings | null {
  return readJamSession(jamId)?.settings ?? null;
}
