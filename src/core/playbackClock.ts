import { z } from "zod";

// The shared playback clock: one position per jam room that every viewer derives
// from the same server anchor. The database stamps `serverNow` and `elapsedMs`
// with its own clock; the browser only ever advances that anchor with its own
// monotonic clock, so no participant's wall clock can move the room.

export const playbackClockStatusSchema = z.enum(["idle", "playing", "paused"]);
export type PlaybackClockStatus = z.infer<typeof playbackClockStatusSchema>;

export const jamPlaybackClockSchema = z.object({
  jamId: z.uuid(),
  status: playbackClockStatusSchema,
  elapsedMs: z.number().int().min(0),
  // Server wall clock at read time (ISO 8601). Used to correct for skew.
  serverNow: z.string(),
  stateVersion: z.number().int().min(1),
});

export type JamPlaybackClock = z.infer<typeof jamPlaybackClockSchema>;

/** Parse a clock payload from the database, which is untrusted input. */
export function parsePlaybackClock(data: unknown): JamPlaybackClock {
  const parsed = jamPlaybackClockSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("playback_clock_invalid");
  }
  return parsed.data;
}

/**
 * Position to show for a clock, given the browser's monotonic clock reading when
 * the payload arrived. While playing, the server anchor is advanced by the local
 * elapsed time; while paused or idle it stays fixed. This never trusts the
 * browser's wall clock, only the difference between two of its own readings.
 */
export function positionMsAt(
  clock: JamPlaybackClock,
  receivedAtMonotonicMs: number,
  nowMonotonicMs: number,
): number {
  if (clock.status !== "playing") return clock.elapsedMs;
  const sinceReceived = Math.max(0, nowMonotonicMs - receivedAtMonotonicMs);
  return clock.elapsedMs + sinceReceived;
}

/** Where the room is, in the only terms this slice needs: mm:ss and a raw ms value. */
export type PlaybackPosition = { elapsedMs: number; clock: string };

export function playbackPosition(
  clock: JamPlaybackClock | null,
  receivedAtMonotonicMs: number,
  nowMonotonicMs: number,
): PlaybackPosition {
  if (!clock) return { elapsedMs: 0, clock: "0:00" };
  const elapsedMs = positionMsAt(clock, receivedAtMonotonicMs, nowMonotonicMs);
  return { elapsedMs, clock: formatPlaybackClock(elapsedMs) };
}

/** Whole seconds as m:ss, matching the script renderer's clock. */
export function formatPlaybackClock(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
