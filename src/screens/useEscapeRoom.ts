import { useCallback, useEffect, useState } from "react";
import type { EscapeSnapshot } from "../core/escape/session";
import { JamError } from "../lib/errors";
import {
  proposeAction,
  readEscapeRoom,
  settleTurn,
  voteForProposal,
} from "../lib/escapeRoom";

/**
 * Whether this jam is an escape room, and what its world looks like now.
 *
 * The jam screen asks this before it decides what to draw, which is what
 * makes an escape room a configuration of that screen rather than a screen of
 * its own. `absent` is a real answer, not a failure: most jams are not escape
 * rooms, and the room the host did start is the only thing that says so.
 *
 * Polling is the transport here for the same reason it is in the live
 * director: there is no Realtime event for a world this server holds in
 * memory. The interval is one named constant a later slice replaces.
 */

export const ESCAPE_POLL_MS = 3_000;

export type EscapeRoomState =
  | { status: "unknown" }
  | { status: "absent" }
  | { status: "present"; snapshot: EscapeSnapshot };

export interface EscapeRoomActions {
  propose: (body: string, authorName: string) => Promise<void>;
  vote: (proposalId: string) => Promise<void>;
  settle: () => Promise<void>;
}

export function useEscapeRoom(jamId: string): {
  state: EscapeRoomState;
  failure: string | null;
  busy: boolean;
  actions: EscapeRoomActions;
} {
  const [state, setState] = useState<EscapeRoomState>({ status: "unknown" });
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const snapshot = await readEscapeRoom(jamId);
        if (!cancelled) setState({ status: "present", snapshot });
      } catch (error) {
        if (cancelled) return;
        // 404 is the answer "this jam is not an escape room", and it will not
        // change while this room is open: it is recorded, not reported.
        if (error instanceof JamError && error.code === "not_found") setState({ status: "absent" });
        else setFailure(safely(error));
      }
    };
    void read();
    const poll = setInterval(() => void read(), ESCAPE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [jamId]);

  const act = useCallback(async (work: () => Promise<EscapeSnapshot>) => {
    setBusy(true);
    setFailure(null);
    try {
      setState({ status: "present", snapshot: await work() });
    } catch (error) {
      setFailure(safely(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const propose = useCallback(
    async (body: string, authorName: string) => {
      const said = body.trim();
      if (!said) return;
      await act(async () => (await proposeAction(jamId, { body: said, authorName })).snapshot);
    },
    [act, jamId],
  );

  const vote = useCallback(
    (proposalId: string) => act(() => voteForProposal(jamId, proposalId)),
    [act, jamId],
  );

  const settle = useCallback(
    () => act(async () => (await settleTurn(jamId)).snapshot),
    [act, jamId],
  );

  return { state, failure, busy, actions: { propose, vote, settle } };
}

function safely(error: unknown): string {
  return error instanceof JamError ? error.safeMessage : "The escape room could not be reached.";
}
