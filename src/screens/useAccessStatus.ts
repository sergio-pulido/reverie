import { useEffect, useRef, useState } from "react";
import type { AccessStatus } from "../lib/membership";
import { accessStatusOf, loadOwnMembership } from "../lib/membership";
import { safeMessageOf } from "../lib/errors";

/** Realtime needs active membership, so a waiting participant has no channel to listen on. */
export const ACCESS_POLL_MS = 5_000;

export type AccessStatusState = {
  status: AccessStatus;
  error: string | null;
  checking: boolean;
};

/**
 * Polls this participant's own membership row while they are not yet active. The moment
 * they are admitted — or refused — polling stops: from `active` onwards Postgres Changes
 * carry every further transition, and `removed` is terminal.
 *
 * `enabled` is false for a participant who is already in the room, so an active member
 * never pays for this.
 */
export function useAccessStatus(jamId: string | null, enabled: boolean): AccessStatusState {
  const [state, setState] = useState<AccessStatusState>({ status: "unknown", error: null, checking: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!jamId || !enabled) return;
    let live = true;

    async function check() {
      if (!live || !jamId) return;
      setState((current) => ({ ...current, checking: true }));
      try {
        const status = accessStatusOf(await loadOwnMembership(jamId));
        if (!live) return;
        setState({ status, error: null, checking: false });
        // `active` and `removed` are both final for this hook: one hands the participant
        // to the live subscription, the other is a refusal that will not change by waiting.
        if (status === "active" || status === "removed") return;
      } catch (error) {
        if (!live) return;
        setState((current) => ({ ...current, error: safeMessageOf(error, "Your access could not be checked."), checking: false }));
      }
      if (live) timer.current = setTimeout(() => void check(), ACCESS_POLL_MS);
    }

    void check();
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [jamId, enabled]);

  return state;
}
