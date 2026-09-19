// The invite lifecycle. Every one of these is a host-only database function: the invite
// columns on `jams` are revoked from the authenticated role, so there is no direct read
// or write path to the entitlement from a browser.

import { jamInviteSchema, type JamInviteRecord } from "../core/room";
import { normalizeInviteMinutes } from "../core/invite";
import { JamError, notConfigured, toJamError } from "./errors";
import { supabase } from "./supabase";

function parseInvite(data: unknown): JamInviteRecord {
  const parsed = jamInviteSchema.safeParse(data);
  if (!parsed.success) throw new JamError("unavailable", "The invite returned an unexpected response.", true);
  return parsed.data;
}

/** Host-only. Any other caller is refused by the database, not by this function. */
export async function getJamInvite(jamId: string): Promise<JamInviteRecord> {
  if (!supabase) throw notConfigured("Reading the invite");
  const { data, error } = await supabase.rpc("get_jam_invite", { p_jam_id: jamId });
  if (error) throw toJamError(error, "The invite could not be read.");
  return parseInvite(data);
}

/**
 * Mints a new code. Every link and QR carrying the previous code stops working, because
 * the entitlement is a column on the room rather than a row left behind.
 * `minutes` is `null` for an invite that does not expire.
 */
export async function rotateJamInvite(jamId: string, minutes: number | null): Promise<JamInviteRecord> {
  const ttl = normalizeInviteMinutes(minutes);
  if (!ttl.ok) throw new JamError("invalid_input", ttl.message);
  if (!supabase) throw notConfigured("Rotating the invite");

  const { data, error } = await supabase.rpc("rotate_jam_invite", {
    p_jam_id: jamId,
    p_expires_in_minutes: ttl.value,
  });
  if (error) throw toJamError(error, "The invite could not be rotated.");
  return parseInvite(data);
}

/** Closes the door to new arrivals. Members already in the room are unaffected. */
export async function revokeJamInvite(jamId: string): Promise<JamInviteRecord> {
  if (!supabase) throw notConfigured("Revoking the invite");
  const { data, error } = await supabase.rpc("revoke_jam_invite", { p_jam_id: jamId });
  if (error) throw toJamError(error, "The invite could not be revoked.");
  return parseInvite(data);
}
