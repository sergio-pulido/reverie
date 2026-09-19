import { useCallback, useEffect, useMemo, useState } from "react";
import {
  canContribute,
  mergeMember,
  mergeRow,
  type ConnectionState,
  type JamMember,
  type JamRoomSnapshot,
} from "../core/room";
import { JamError, safeMessageOf } from "../lib/errors";
import { createJamProposal, loadJamSnapshot, sendJamMessage, subscribeToJamRoom } from "../lib/jamRoom";
import { setMemberStatus } from "../lib/membership";

export type JamRoomState = {
  phase: "loading" | "ready" | "error";
  snapshot: JamRoomSnapshot | null;
  connection: ConnectionState;
  error: string | null;
};

const INITIAL: JamRoomState = { phase: "loading", snapshot: null, connection: "idle", error: null };

/**
 * Owns one jam subscription. Durable rows come from the snapshot and Postgres Changes;
 * Presence only reports who is connected. A configured Supabase project that fails leaves
 * the room in an error state rather than falling back to local state.
 */
export function useJamRoom(slug: string | null) {
  const [state, setState] = useState<JamRoomState>(INITIAL);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const applySnapshot = useCallback((snapshot: JamRoomSnapshot) => {
    setState((current) => ({ ...current, phase: "ready", snapshot, error: null }));
  }, []);

  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    if (!slug) return;
    let active = true;
    setState((current) => (current.snapshot ? current : INITIAL));

    void loadJamSnapshot(slug)
      .then((snapshot) => { if (active) applySnapshot(snapshot); })
      .catch((error: unknown) => {
        if (!active) return;
        setState({ phase: "error", snapshot: null, connection: "idle", error: safeMessageOf(error, "This jam could not be opened.") });
      });

    return () => { active = false; };
  }, [slug, applySnapshot, reloadKey]);

  const jamId = state.snapshot?.jam.id ?? null;
  const self = state.snapshot?.self ?? null;
  const selfIsActive = self?.status === "active";

  useEffect(() => {
    const snapshot = state.snapshot;
    if (!snapshot || !snapshot.self || !selfIsActive) return;

    const stop = subscribeToJamRoom(snapshot.jam, {
      onSnapshot: applySnapshot,
      onConnection: (connection) => setState((current) => ({ ...current, connection })),
      onMessage: (message) => setState((current) => current.snapshot
        ? { ...current, snapshot: { ...current.snapshot, messages: mergeRow(current.snapshot.messages, message) } }
        : current),
      onProposal: (proposal) => setState((current) => current.snapshot
        ? { ...current, snapshot: { ...current.snapshot, proposals: mergeRow(current.snapshot.proposals, proposal) } }
        : current),
      onMember: (member: JamMember) => setState((current) => {
        if (!current.snapshot) return current;
        const isSelf = member.user_id === current.snapshot.self?.user_id;
        return {
          ...current,
          snapshot: {
            ...current.snapshot,
            self: isSelf ? member : current.snapshot.self,
            members: mergeMember(current.snapshot.members, member),
          },
        };
      }),
      onError: (error: JamError) => setState((current) => ({ ...current, error: error.safeMessage })),
    });

    // Removes the channel and silences every callback when the room or identity changes.
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jamId, self?.user_id, selfIsActive, applySnapshot]);

  const guardedAction = useCallback(async (run: () => Promise<void>) => {
    setActionError(null);
    try {
      await run();
    } catch (error) {
      setActionError(safeMessageOf(error, "That action did not complete."));
    }
  }, []);

  const actions = useMemo(() => ({
    sendMessage: (body: string) => guardedAction(() => jamId ? sendJamMessage(jamId, body) : Promise.resolve()),
    addProposal: (body: string) => guardedAction(() => jamId ? createJamProposal(jamId, body) : Promise.resolve()),
    admit: (memberId: string) => guardedAction(async () => { if (jamId) await setMemberStatus(jamId, memberId, "active"); }),
    remove: (memberId: string) => guardedAction(async () => { if (jamId) await setMemberStatus(jamId, memberId, "removed"); }),
    refresh,
  }), [guardedAction, jamId, refresh]);

  const contributionAllowed = state.snapshot ? canContribute(state.snapshot.jam, state.snapshot.self) : false;

  return { state, actions, actionError, contributionAllowed };
}
