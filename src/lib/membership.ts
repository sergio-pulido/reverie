// Membership mutations. Every one of these is a constrained database function: the
// browser cannot insert, update or delete a jam_members row directly.

import { admissionResultSchema, jamMemberSchema, memberMutationResultSchema, type AdmissionResult, type JamMember, type MemberMutationResult, type MemberStatus } from "../core/room";
import { normalizeDisplayName, normalizeInviteCode } from "../core/invite";
import { JamError, notConfigured, toJamError } from "./errors";
import { currentUserId, ensureUserId } from "./session";
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

/**
 * Reads this participant's own membership row — the one fact a waiting participant is
 * authorized to see. `jam_members` RLS already allows `user_id = auth.uid()`, so this
 * opens no new read surface; it just asks for what the lobby needs.
 *
 * Returns `null` when no row exists (never joined, or the row is gone).
 */
export async function loadOwnMembership(jamId: string): Promise<JamMember | null> {
  if (!supabase) throw notConfigured("Checking your access");

  const userId = await currentUserId();
  if (!userId) throw new JamError("unauthenticated", "Your session is no longer signed in. Reload the page to continue.");

  const { data, error } = await supabase
    .from("jam_members")
    .select("jam_id, user_id, display_name, role, status, joined_at")
    .eq("jam_id", jamId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw toJamError(error, "Your access could not be checked.");
  if (!data) return null;

  const parsed = jamMemberSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** What the lobby should tell a waiting participant about where they stand. */
export type AccessStatus = MemberStatus | "unknown";

export function accessStatusOf(member: JamMember | null): AccessStatus {
  return member?.status ?? "unknown";
}
