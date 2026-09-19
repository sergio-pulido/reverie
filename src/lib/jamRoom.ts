// Durable state lives in Postgres under RLS. Postgres Changes notify about those rows,
// Presence reports who is connected right now, and Broadcast is not used as authority.
// A configured Supabase project that fails surfaces an error; it never silently becomes
// local state.

import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  jamMemberSchema,
  jamMessageSchema,
  jamProposalSchema,
  jamRoomSchema,
  type ConnectionState,
  type JamRoom,
  type JamMember,
  type JamMessage,
  type JamProposal,
  type JamRoomSnapshot,
} from "../core/room";
import { JamError, notConfigured, toJamError } from "./errors";
import { currentUserId } from "./session";
import { supabase } from "./supabase";

const MESSAGE_PAGE = 200;
const PROPOSAL_PAGE = 200;

// invite_code is deliberately absent: the database revokes that column from members,
// and the host reads it through get_jam_invite.
const JAM_COLUMNS = "id, slug, title, premise, visibility, status, host_id";
const MEMBER_COLUMNS = "jam_id, user_id, display_name, role, status, joined_at";

function parseList<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, rows: unknown[]): T[] {
  // A row that fails validation is dropped rather than rendered. Untrusted input never
  // reaches the UI on the strength of having arrived from the database.
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success && parsed.data ? [parsed.data] : [];
  });
}

/**
 * Loads the authorized durable state for a jam. This is the reconnect snapshot: after a
 * dropped subscription the client reloads here instead of replaying missed events.
 */
export async function loadJamSnapshot(slug: string): Promise<JamRoomSnapshot> {
  if (!supabase) throw notConfigured("Opening a jam");

  const userId = await currentUserId();
  if (!userId) {
    throw new JamError("forbidden", "This jam needs an invite. Join with the code the host shared.");
  }

  const jamResult = await supabase.from("jams").select(JAM_COLUMNS).eq("slug", slug).maybeSingle();
  if (jamResult.error) throw toJamError(jamResult.error, "This jam could not be loaded.");
  if (!jamResult.data) {
    throw new JamError("forbidden", "This jam is not open to your session. Join with the code the host shared.");
  }

  const jamParsed = jamRoomSchema.safeParse(jamResult.data);
  if (!jamParsed.success) throw new JamError("unavailable", "This jam returned an unexpected record.", true);
  const jam: JamRoom = jamParsed.data;

  const memberResult = await supabase.from("jam_members").select(MEMBER_COLUMNS).eq("jam_id", jam.id);
  if (memberResult.error) throw toJamError(memberResult.error, "The participant list could not be loaded.");
  const members = parseList<JamMember>(jamMemberSchema, memberResult.data ?? []);
  const self = members.find((member) => member.user_id === userId) ?? null;

  // Chat and proposals are readable only by an active member. A waiting participant gets
  // an empty room rather than a denied screen, because waiting is a legitimate state.
  if (self?.status !== "active") {
    return { jam, self, members: self ? [self] : [], messages: [], proposals: [] };
  }

  const [messageResult, proposalResult] = await Promise.all([
    supabase.from("jam_messages").select("id, jam_id, author_id, body, created_at").eq("jam_id", jam.id).order("created_at", { ascending: true }).limit(MESSAGE_PAGE),
    supabase.from("jam_proposals").select("id, jam_id, author_id, body, status, created_at").eq("jam_id", jam.id).order("created_at", { ascending: true }).limit(PROPOSAL_PAGE),
  ]);
  if (messageResult.error) throw toJamError(messageResult.error, "The conversation could not be loaded.");
  if (proposalResult.error) throw toJamError(proposalResult.error, "The proposal queue could not be loaded.");

  return {
    jam,
    self,
    members,
    messages: parseList<JamMessage>(jamMessageSchema, messageResult.data ?? []),
    proposals: parseList<JamProposal>(jamProposalSchema, proposalResult.data ?? []),
  };
}

export async function sendJamMessage(jamId: string, body: string): Promise<void> {
  if (!supabase) throw notConfigured("Sending a message");
  const text = body.trim();
  if (!text || text.length > 500) throw new JamError("invalid_input", "A message is between 1 and 500 characters.");
  // author_id is omitted on purpose: the column defaults to auth.uid() and the policy pins it there.
  const { error } = await supabase.from("jam_messages").insert({ jam_id: jamId, body: text });
  if (error) throw toJamError(error, "That message could not be sent.");
}

export async function createJamProposal(jamId: string, body: string): Promise<void> {
  if (!supabase) throw notConfigured("Adding a proposal");
  const text = body.trim();
  if (!text || text.length > 280) throw new JamError("invalid_input", "A proposal is between 1 and 280 characters.");
  const { error } = await supabase.from("jam_proposals").insert({ jam_id: jamId, body: text });
  if (error) throw toJamError(error, "That proposal could not be queued.");
}

export type JamRoomHandlers = {
  onSnapshot: (snapshot: JamRoomSnapshot) => void;
  onMember: (member: JamMember) => void;
  onMessage: (message: JamMessage) => void;
  onProposal: (proposal: JamProposal) => void;
  onConnection: (state: ConnectionState) => void;
  onError: (error: JamError) => void;
};

/**
 * Subscribes to one jam. Returns a cleanup function; calling it removes the channel and
 * stops every callback, so a React effect can tear the subscription down on unmount or
 * when the participant changes.
 */
export function subscribeToJamRoom(jam: JamRoom, handlers: JamRoomHandlers): () => void {
  if (!supabase) {
    handlers.onError(notConfigured("Live collaboration"));
    return () => {};
  }

  const client = supabase;
  const topic = `jam:${jam.id}`;
  let disposed = false;
  let channel: RealtimeChannel | null = null;
  let hasConnectedOnce = false;

  const guard = <T>(run: (value: T) => void) => (value: T) => {
    if (!disposed) run(value);
  };

  const emitRow = <T>(
    schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
    row: unknown,
    emit: (value: T) => void,
  ) => {
    const parsed = schema.safeParse(row);
    if (parsed.success && parsed.data) emit(parsed.data);
  };

  async function reloadSnapshot() {
    try {
      const snapshot = await loadJamSnapshot(jam.slug);
      if (!disposed) handlers.onSnapshot(snapshot);
    } catch (error) {
      if (!disposed) {
        handlers.onError(error instanceof JamError ? error : new JamError("unavailable", "The jam could not be reloaded.", true));
      }
    }
  }

  async function connect() {
    handlers.onConnection("connecting");
    // Postgres Changes are authorized by each subscribed table's RLS policy. This public
    // channel carries no Presence or Broadcast payloads.
    await client.realtime.setAuth();
    if (disposed) return;

    const jamChannel = client.channel(topic);
    channel = jamChannel;

    jamChannel
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "jam_messages", filter: `jam_id=eq.${jam.id}` },
        guard(({ new: row }: { new: unknown }) => emitRow(jamMessageSchema, row, handlers.onMessage)))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "jam_proposals", filter: `jam_id=eq.${jam.id}` },
        guard(({ new: row }: { new: unknown }) => emitRow(jamProposalSchema, row, handlers.onProposal)))
      // '*' also matches DELETE, whose payload carries no `new` row; such a payload fails
      // validation and is dropped. There is no delete path on jam_members today.
      .on("postgres_changes", { event: "*", schema: "public", table: "jam_members", filter: `jam_id=eq.${jam.id}` },
        guard(({ new: row }: { new: unknown }) => emitRow(jamMemberSchema, row, handlers.onMember)))
      .subscribe((status, error) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          handlers.onConnection("live");
          // Every successful subscribe reloads durable state, so a reconnect closes the
          // gap with a snapshot instead of assuming no event was missed.
          void reloadSnapshot();
          hasConnectedOnce = true;
          return;
        }
        if (status === "TIMED_OUT") {
          handlers.onConnection(hasConnectedOnce ? "reconnecting" : "connecting");
          return;
        }
        if (status === "CLOSED") {
          handlers.onConnection("offline");
          return;
        }
        if (status === "CHANNEL_ERROR") {
          const text = error?.message ?? "";
          const denied = /unauthor|forbidden|not allowed|permission/i.test(text);
          handlers.onConnection(denied ? "denied" : "offline");
          handlers.onError(
            denied
              ? new JamError("forbidden", "This session is no longer allowed in the jam.")
              : new JamError("unavailable", "The live connection dropped. Reconnecting.", true),
          );
        }
      });
  }

  void connect();

  return () => {
    disposed = true;
    handlers.onConnection("idle");
    if (channel) {
      void channel.untrack();
      void client.removeChannel(channel);
      channel = null;
    }
  };
}
