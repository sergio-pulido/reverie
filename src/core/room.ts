// Provider-free room state: schemas for everything crossing the trust boundary and the
// pure merge rules the client uses to fold Realtime events into a snapshot.
// Every row read from Supabase is untrusted input until it passes a schema here.

import { z } from "zod";

// `draft` is a legacy value: nothing ever wrote a different one, so every room
// read DRAFT for its whole life while its real state — live, playing, stopped —
// is the lifecycle the server owns. `20260920110000_jam_starts_live.sql` retires
// it. It stays readable here on purpose: a database that has not had that
// migration applied must not have its rows dropped by a stricter parser, since
// a row that fails this schema is not rendered at all.
export const jamStatusSchema = z.enum(["draft", "lobby", "live", "paused", "completed", "closed"]);
export const jamVisibilitySchema = z.enum(["public", "invite_only"]);
export const memberRoleSchema = z.enum(["host", "member"]);
export const memberStatusSchema = z.enum(["waiting", "active", "left", "removed"]);
export const proposalStatusSchema = z.enum(["queued", "accepted", "rejected", "superseded"]);

export const jamRoomSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  premise: z.string(),
  visibility: jamVisibilitySchema,
  status: jamStatusSchema,
  host_id: z.string().uuid().optional(),
  // invite_code is host-only now and is read through get_jam_invite, never off the room row.
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export const jamMemberSchema = z.object({
  jam_id: z.string().uuid(),
  user_id: z.string().uuid(),
  display_name: z.string(),
  role: memberRoleSchema,
  status: memberStatusSchema,
  joined_at: z.string(),
});

export const jamMessageSchema = z.object({
  id: z.string().uuid(),
  jam_id: z.string().uuid(),
  author_id: z.string().uuid(),
  body: z.string(),
  created_at: z.string(),
});

export const jamProposalSchema = z.object({
  id: z.string().uuid(),
  jam_id: z.string().uuid(),
  author_id: z.string().uuid(),
  body: z.string(),
  status: proposalStatusSchema,
  created_at: z.string(),
});

export const admissionResultSchema = z.object({
  jamId: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  memberStatus: memberStatusSchema,
});

export const memberMutationResultSchema = z.object({
  jamId: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  role: memberRoleSchema,
  status: memberStatusSchema,
});

export const jamInviteSchema = z.object({
  jamId: z.string().uuid(),
  slug: z.string(),
  code: z.string().regex(/^[A-HJ-NP-TV-Z2-9]{8}$/),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  state: z.enum(["active", "expired", "revoked"]),
});

export const presenceEntrySchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  at: z.number(),
});

export type JamRoom = z.infer<typeof jamRoomSchema>;
export type JamMember = z.infer<typeof jamMemberSchema>;
export type JamMessage = z.infer<typeof jamMessageSchema>;
export type JamProposal = z.infer<typeof jamProposalSchema>;
export type AdmissionResult = z.infer<typeof admissionResultSchema>;
export type MemberMutationResult = z.infer<typeof memberMutationResultSchema>;
export type PresenceEntry = z.infer<typeof presenceEntrySchema>;
export type JamInviteRecord = z.infer<typeof jamInviteSchema>;
export type MemberStatus = z.infer<typeof memberStatusSchema>;
export type JamVisibility = z.infer<typeof jamVisibilitySchema>;
export type JamStatus = z.infer<typeof jamStatusSchema>;

/**
 * Connection state is shown to the room. `denied` means the server refused this
 * participant; it is never presented as a transient network problem.
 */
export type ConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "offline" | "denied";

export type JamRoomSnapshot = {
  jam: JamRoom;
  self: JamMember | null;
  members: readonly JamMember[];
  messages: readonly JamMessage[];
  proposals: readonly JamProposal[];
};

type Timestamped = { id: string; created_at: string };

/** Deterministic order: creation time, then id, so two clients converge on one sequence. */
function byCreatedAt(a: Timestamped, b: Timestamped) {
  if (a.created_at === b.created_at) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.created_at < b.created_at ? -1 : 1;
}

/**
 * Folds an incoming row into a list without mutating it. A row already present wins
 * over the optimistic copy, which is how a redelivered Postgres Change after a
 * reconnect stays idempotent instead of duplicating an entry.
 */
export function mergeRow<T extends Timestamped>(current: readonly T[], incoming: T): T[] {
  const index = current.findIndex((item) => item.id === incoming.id);
  const next = index === -1 ? [...current, incoming] : current.map((item, i) => (i === index ? incoming : item));
  return next.sort(byCreatedAt);
}

/** Replaces a list with a freshly loaded snapshot, deduplicated and ordered. */
export function mergeRows<T extends Timestamped>(current: readonly T[], incoming: readonly T[]): T[] {
  return incoming.reduce<T[]>((rows, row) => mergeRow(rows, row), [...current]);
}

/** Members are keyed by user, not by row order, and a left/removed member drops out. */
export function mergeMember(current: readonly JamMember[], incoming: JamMember): JamMember[] {
  const others = current.filter((member) => member.user_id !== incoming.user_id);
  const next = incoming.status === "left" || incoming.status === "removed" ? others : [...others, incoming];
  return next.sort((a, b) => (a.joined_at === b.joined_at ? a.user_id.localeCompare(b.user_id) : a.joined_at < b.joined_at ? -1 : 1));
}

export function isParticipating(member: JamMember | null): boolean {
  return member?.status === "active";
}

export function canContribute(jam: JamRoom, member: JamMember | null): boolean {
  return isParticipating(member) && jam.status !== "closed" && jam.status !== "completed";
}

/** Resolves an author id to a roster name without ever exposing the raw user id. */
export function authorName(members: readonly JamMember[], authorId: string, fallback = "Someone"): string {
  return members.find((member) => member.user_id === authorId)?.display_name ?? fallback;
}
