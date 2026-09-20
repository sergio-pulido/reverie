/**
 * Which of the three ways a room was started, remembered in this browser.
 *
 * A jam row does not say. Everything you start is a row in `jams` — a Movie Jam room, a Director
 * session and an escape room alike — and what distinguishes them lives elsewhere: an escape room
 * has a session on the Node server, a Director session has rows in `jam_director_sessions`, and
 * both of those are that server's own routes, absent from a deployment and answerable only one
 * jam at a time. So a list of everything you have started cannot ask them.
 *
 * This is the same bargain `jamConfiguration.ts` makes for playback settings: the browser
 * remembers its own until the room's authority holds it. A room with nothing remembered is shown
 * as a Movie Jam, which is what a jam row is.
 */

const KINDS = ["jam", "director", "escape"] as const;
export type StartedKind = (typeof KINDS)[number];

/** What a room with nothing remembered about it is: a room. */
export const DEFAULT_STARTED_KIND: StartedKind = "jam";

function storageKey(jamId: string): string {
  return `reverie.started-kind.${jamId}`;
}

function isStartedKind(value: string | null): value is StartedKind {
  return value !== null && (KINDS as readonly string[]).includes(value);
}

export function rememberStartedKind(jamId: string, kind: StartedKind): void {
  try {
    window.localStorage.setItem(storageKey(jamId), kind);
  } catch {
    // A browser that refuses storage simply shows the room as a room.
  }
}

export function readStartedKind(jamId: string): StartedKind | null {
  try {
    const stored = window.localStorage.getItem(storageKey(jamId));
    return isStartedKind(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** What to call it, and what it says about itself, wherever one of these is listed. */
export const STARTED_KIND_LABEL: Readonly<Record<StartedKind, string>> = {
  jam: "MOVIE JAM",
  director: "DIRECTOR SESSION",
  escape: "ESCAPE ROOM",
};

export const STARTED_KIND_MEANING: Readonly<Record<StartedKind, string>> = {
  jam: "A room directing one film together.",
  director: "One person, one film, alone.",
  escape: "A room solving an authored place.",
};
