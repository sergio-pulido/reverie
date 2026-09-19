// The shared playback clock. Every mutation is a host-only database function, so the
// browser cannot move the room's position directly. Reads are limited to active members.

import { parsePlaybackClock, type JamPlaybackClock } from "../core/playbackClock";
import { JamError, notConfigured, toJamError } from "./errors";
import { supabase } from "./supabase";

function readClock(data: unknown, fallback: string): JamPlaybackClock {
  try {
    return parsePlaybackClock(data);
  } catch {
    throw new JamError("unavailable", fallback, true);
  }
}

/** Any active member (or the host) may read where the room is. */
export async function getJamPlayback(jamId: string): Promise<JamPlaybackClock> {
  if (!supabase) throw notConfigured("Reading playback");
  const { data, error } = await supabase.rpc("get_jam_playback", { p_jam_id: jamId });
  if (error) throw toJamError(error, "The room's position could not be read.");
  return readClock(data, "The room returned an unexpected position.");
}

async function hostControl(jamId: string, rpc: string, fallback: string): Promise<JamPlaybackClock> {
  if (!supabase) throw notConfigured("Controlling playback");
  const { data, error } = await supabase.rpc(rpc, { p_jam_id: jamId });
  if (error) throw toJamError(error, fallback);
  return readClock(data, "The room returned an unexpected position.");
}

/** Host-only. Starting while already playing is a no-op and does not move the anchor. */
export async function startJamPlayback(jamId: string): Promise<JamPlaybackClock> {
  return hostControl(jamId, "start_jam_playback", "Playback could not be started.");
}

/** Host-only. Freezes the current position. */
export async function pauseJamPlayback(jamId: string): Promise<JamPlaybackClock> {
  return hostControl(jamId, "pause_jam_playback", "Playback could not be paused.");
}

/** Host-only. Returns the clock to zero. */
export async function resetJamPlayback(jamId: string): Promise<JamPlaybackClock> {
  return hostControl(jamId, "reset_jam_playback", "Playback could not be reset.");
}
