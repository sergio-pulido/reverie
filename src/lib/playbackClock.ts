import { playbackReadingSchema, type PlaybackReading } from "../core/playbackClock";
import { JamError, notConfigured, toJamError } from "./errors";
import { supabase } from "./supabase";

/**
 * The room-wide playback clock, read and driven through the database.
 *
 * Every one of these is a security-definer function: `jam_playback` has RLS on
 * and no policies, so there is no direct read or write path from a browser.
 * The host controls it; any active member can read it. Both rules are the
 * database's, not this module's.
 */

function parse(data: unknown): PlaybackReading {
  const parsed = playbackReadingSchema.safeParse(data);
  if (!parsed.success) {
    throw new JamError("unavailable", "The playback clock returned an unexpected reading.", true);
  }
  return parsed.data;
}

export async function readPlayback(jamId: string): Promise<PlaybackReading> {
  if (!supabase) throw notConfigured("Reading the playback clock");
  const { data, error } = await supabase.rpc("get_jam_playback", { p_jam_id: jamId });
  if (error) throw toJamError(error, "The playback clock could not be read.");
  return parse(data);
}

/** Host-only. Pressing play on a clock already playing does not move the anchor. */
export async function startPlayback(jamId: string): Promise<PlaybackReading> {
  if (!supabase) throw notConfigured("Starting playback");
  const { data, error } = await supabase.rpc("start_jam_playback", { p_jam_id: jamId });
  if (error) throw toJamError(error, "Playback could not be started.");
  return parse(data);
}

/** Host-only. Freezes the elapsed time and clears the anchor. */
export async function pausePlayback(jamId: string): Promise<PlaybackReading> {
  if (!supabase) throw notConfigured("Pausing playback");
  const { data, error } = await supabase.rpc("pause_jam_playback", { p_jam_id: jamId });
  if (error) throw toJamError(error, "Playback could not be paused.");
  return parse(data);
}

/** Host-only. Returns the clock to idle at zero. */
export async function resetPlayback(jamId: string): Promise<PlaybackReading> {
  if (!supabase) throw notConfigured("Resetting playback");
  const { data, error } = await supabase.rpc("reset_jam_playback", { p_jam_id: jamId });
  if (error) throw toJamError(error, "Playback could not be reset.");
  return parse(data);
}
