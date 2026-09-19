import { z } from "zod";
import { playbackStateSchema } from "./playback";
import { DEFAULT_SESSION_LANGUAGE, type SessionSettings } from "./session";

// The viewer-side reading of the server's portion playback machine
// (docs/API_CONTRACTS.md, "Portion playback, locking, and video generation").
// The server owns the cursor and the lock window; everything here derives what
// one viewer should do next from the snapshot it is given, so the player screen
// holds no rules of its own.

/** Per-portion media status as `GET /api/jams/:id/playback` reports it. */
export const portionMediaStatusSchema = z.enum([
  "none",
  "queued",
  "submitted",
  "generating",
  "downloading",
  "ready",
  "failed",
]);

export type PortionMediaStatus = z.infer<typeof portionMediaStatusSchema>;

export const playbackSnapshotSchema = z.object({
  playback: playbackStateSchema,
  lockedPortionIndex: z.number().int().min(0).nullable(),
  minEditablePortionIndex: z.number().int().min(0),
  portions: z.array(
    z.object({
      portionIndex: z.number().int().min(0),
      durationSeconds: z.number().positive(),
      media: portionMediaStatusSchema,
    }),
  ),
});

export type PlaybackSnapshot = z.infer<typeof playbackSnapshotSchema>;

/** Parse a snapshot from the server, which is untrusted input like any other. */
export function parsePlaybackSnapshot(data: unknown): PlaybackSnapshot {
  const parsed = playbackSnapshotSchema.safeParse(data);
  if (!parsed.success) throw new Error("playback_snapshot_invalid");
  return parsed.data;
}

/**
 * What the viewer should do to move playback forward, derived from the same
 * rules the server enforces: portion 0 is locked by `start`, and every
 * `advance` needs the locked portion's clip to be ready first.
 */
export type PlayerAction =
  | { kind: "start" }
  | { kind: "advance"; portionIndex: number; expectedStateVersion: number }
  | { kind: "wait"; portionIndex: number; media: PortionMediaStatus }
  | { kind: "failed"; portionIndex: number }
  | { kind: "finished" };

export function nextPlayerAction(snapshot: PlaybackSnapshot): PlayerAction {
  const { playback, lockedPortionIndex } = snapshot;
  if (playback.status === "idle") return { kind: "start" };
  if (playback.status === "finished" || lockedPortionIndex === null) {
    return { kind: "finished" };
  }
  const media = snapshot.portions[lockedPortionIndex]?.media ?? "none";
  if (media === "ready") {
    return {
      kind: "advance",
      portionIndex: lockedPortionIndex,
      expectedStateVersion: playback.stateVersion,
    };
  }
  if (media === "failed") return { kind: "failed", portionIndex: lockedPortionIndex };
  return { kind: "wait", portionIndex: lockedPortionIndex, media };
}

/** The portion whose clip belongs in the player right now, if any. */
export function playingPortionIndex(snapshot: PlaybackSnapshot): number | null {
  return snapshot.playback.status === "playing"
    ? snapshot.playback.currentPortionIndex
    : null;
}

/** What a viewer without a session of their own watches: the script as written. */
export const DEFAULT_CONFIGURATION: SessionSettings = {
  language: DEFAULT_SESSION_LANGUAGE,
  ambientation: "",
};

/**
 * The normalized configuration a session selects
 * (docs/specs/configuration-keyed-streams.md): language tag casing and
 * surrounding or repeated whitespace are cosmetic, so they must not multiply
 * streams. The spec leaves exact canonicalisation open; this is the choice this
 * build makes, and the one place it is made.
 *
 * Per-configuration streams, the cap and the attach flow are **not**
 * implemented: every key resolves to the jam's single generated stream today.
 * The player asks for its clip by configuration so that when streams become
 * configuration-keyed, only the media address below changes.
 */
export function configurationKey(settings: SessionSettings): string {
  const language = settings.language.trim().toLowerCase();
  const ambientation = settings.ambientation.trim().replace(/\s+/g, " ").toLowerCase();
  return `${language}|${encodeURIComponent(ambientation)}`;
}

/** The configuration in the same words the annotated script view uses. */
export function describeConfiguration(settings: SessionSettings): string {
  return (
    `language ${settings.language.trim().toLowerCase()}` +
    (settings.ambientation.trim()
      ? `, ambientation “${settings.ambientation.trim()}”`
      : ", ambientation as written")
  );
}
