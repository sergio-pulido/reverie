import { z } from "zod";

/**
 * The shared playback clock, as pure data and arithmetic.
 *
 * The database is the authority: `jam_playback` stamps its anchor with its
 * own `now()`, and `get_jam_playback` answers with the elapsed milliseconds it
 * computed plus the server time it computed them at. A browser must not
 * substitute its own clock for that — two viewers with two skewed clocks would
 * see two different positions in one room.
 *
 * What a browser may do is advance a reading it was given, which is what
 * `positionAt` does: it adds locally measured time to the server's number
 * while the clock is playing, and adds nothing while it is not.
 */

export const playbackStatusSchema = z.enum(["idle", "playing", "paused"]);
export type PlaybackStatus = z.infer<typeof playbackStatusSchema>;

export const playbackReadingSchema = z.object({
  jamId: z.string(),
  status: playbackStatusSchema,
  elapsedMs: z.coerce.number().min(0),
  /** When the database computed `elapsedMs`, by its own clock. */
  serverNow: z.string(),
  stateVersion: z.number().int().min(1),
});

export type PlaybackReading = z.infer<typeof playbackReadingSchema>;

/** A reading, plus the local monotonic time it was received at. */
export interface PlaybackAnchor {
  reading: PlaybackReading;
  /** `performance.now()` when the reading arrived. */
  receivedAt: number;
}

/**
 * Where the room is now, in seconds.
 *
 * Only a playing clock moves, and it moves by time measured here since the
 * reading arrived — never by comparing two wall clocks, which is the whole
 * reason the database sends elapsed milliseconds rather than a start time.
 */
export function positionSeconds(anchor: PlaybackAnchor | null, now: number): number {
  if (!anchor) return 0;
  const { reading, receivedAt } = anchor;
  const since = reading.status === "playing" ? Math.max(0, now - receivedAt) : 0;
  return (reading.elapsedMs + since) / 1000;
}

/**
 * The position clamped to the film's runtime.
 *
 * The clock is a room-wide timer and knows nothing about the script, so it
 * keeps counting past the end. A playhead must not walk off the transport bar.
 */
export function playheadSeconds(
  anchor: PlaybackAnchor | null,
  now: number,
  runtimeSeconds: number,
): number {
  return Math.min(Math.max(0, runtimeSeconds), positionSeconds(anchor, now));
}
