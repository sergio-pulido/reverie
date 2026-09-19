// Membership mutations. Every one of these is a constrained database function: the
// browser cannot insert, update or delete a jam_members row directly.

import { admissionResultSchema, memberMutationResultSchema, type AdmissionResult, type MemberMutationResult } from "../core/room";
import { normalizeDisplayName, normalizeInviteCode } from "../core/invite";
import { JamError, notConfigured, toJamError } from "./errors";
import { ensureUserId } from "./session";
import { supabase } from "./supabase";

/**
 * Exchanges an invite entitlement and a display name for a membership row.
 * Invite-only jams return `waiting`; public jams return `active`.
 */
export async function requestAdmission(rawCode: string, rawName: string): Promise<AdmissionResult> {
  const code = normalizeInviteCode(rawCode);
  if (!code.ok) throw new JamError("invalid_input", code.message);
  const name = normalizeDisplayName(rawName);
  if (!name.ok) throw new JamError("invalid_input", name.message);
  if (!supabase) throw notConfigured("Joining a jam");

  await ensureUserId();
  const { data, error } = await supabase.rpc("request_jam_admission", {
    p_invite_code: code.value,
    p_display_name: name.value,
  });
  if (error) throw toJamError(error, "The jam could not be joined right now.");

  const parsed = admissionResultSchema.safeParse(data);
  if (!parsed.success) throw new JamError("unavailable", "The jam returned an unexpected response.", true);
  return parsed.data;
}

/** Host-only admission or removal. The database rejects any other caller. */
export async function setMemberStatus(jamId: string, memberId: string, status: "active" | "removed"): Promise<MemberMutationResult> {
  if (!supabase) throw notConfigured("Changing membership");

  const { data, error } = await supabase.rpc("set_jam_member_status", {
    p_jam_id: jamId,
    p_member_id: memberId,
    p_status: status,
  });
  if (error) throw toJamError(error, "That participant could not be updated.");

  const parsed = memberMutationResultSchema.safeParse(data);
  if (!parsed.success) throw new JamError("unavailable", "The jam returned an unexpected response.", true);
  return parsed.data;
}
