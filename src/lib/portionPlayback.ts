// The portion playback API of the local Reverie host (docs/API_CONTRACTS.md,
// "Portion playback, locking, and video generation"). These are same-origin
// Express routes, not Supabase RPCs: the room's shared clock in `playback.ts`
// is a different, unrelated position.

import {
  parsePlaybackSnapshot,
  type PlaybackSnapshot,
} from "../core/portionPlayback";

export type PortionPlaybackErrorCode =
  | "media_not_ready"
  | "stale_state_version"
  | "invalid_transition"
  | "generation_disabled"
  | "media_unavailable"
  | "not_found"
  | "unavailable";

/** A typed failure from the playback routes: a code, a safe message, and
 * whether retrying means anything. It never carries a provider detail. */
export class PortionPlaybackError extends Error {
  constructor(
    readonly code: PortionPlaybackErrorCode,
    readonly safeMessage: string,
    readonly retryable: boolean,
  ) {
    super(safeMessage);
    this.name = "PortionPlaybackError";
  }
}

const KNOWN_CODES: readonly string[] = [
  "media_not_ready",
  "stale_state_version",
  "invalid_transition",
  "generation_disabled",
  "media_unavailable",
  "not_found",
];

async function readError(response: Response, fallback: string): Promise<PortionPlaybackError> {
  const body: unknown = await response.json().catch(() => null);
  const error = (body as { error?: { code?: unknown; safeMessage?: unknown; retryable?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" && KNOWN_CODES.includes(error.code)
    ? (error.code as PortionPlaybackErrorCode)
    : "unavailable";
  const safeMessage = typeof error?.safeMessage === "string" ? error.safeMessage : fallback;
  return new PortionPlaybackError(code, safeMessage, error?.retryable === true);
}

async function readSnapshot(response: Response, fallback: string): Promise<PlaybackSnapshot> {
  if (!response.ok) throw await readError(response, fallback);
  try {
    return parsePlaybackSnapshot(await response.json());
  } catch {
    throw new PortionPlaybackError("unavailable", "The server returned an unexpected playback state.", true);
  }
}

async function send(path: string, init: RequestInit, fallback: string): Promise<PlaybackSnapshot> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new PortionPlaybackError("unavailable", "The server could not be reached.", true);
  }
  return readSnapshot(response, fallback);
}

export async function getPortionPlayback(jamId: string): Promise<PlaybackSnapshot> {
  return send(`/api/jams/${jamId}/playback`, { method: "GET" }, "This jam's playback could not be read.");
}

/** Locks portion 0 and asks for its clip. Starting twice is `invalid_transition`. */
export async function startPortionPlayback(jamId: string): Promise<PlaybackSnapshot> {
  return send(`/api/jams/${jamId}/playback/start`, { method: "POST" }, "Playback could not be started.");
}

/** Moves to the next portion. Refused with `media_not_ready` until its clip
 * exists, and with `stale_state_version` when somebody else moved first. */
export async function advancePortionPlayback(
  jamId: string,
  expectedStateVersion: number,
): Promise<PlaybackSnapshot> {
  return send(
    `/api/jams/${jamId}/playback/advance`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedStateVersion }),
    },
    "Playback could not move to the next portion.",
  );
}

/**
 * The clip's address. Server-hosted bytes with Range support — never a
 * provider or storage URL.
 *
 * The `configuration` a viewer is watching under is deliberately threaded to
 * this one function even though the server serves a single stream per jam
 * today: when per-configuration streams land
 * (docs/specs/configuration-keyed-streams.md) the address changes here and
 * nowhere else. It is not sent yet, because the server would ignore it and a
 * viewer would be shown someone else's stream while the URL implied otherwise.
 */
export function portionVideoSrc(jamId: string, portionIndex: number, _configuration?: string): string {
  return `/api/jams/${jamId}/portions/${portionIndex}/video`;
}
