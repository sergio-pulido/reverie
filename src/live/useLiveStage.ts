import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  permittedKinds,
  type LiveConsent,
  type LiveTrackKind,
} from "../core/liveMedia";
import { safeMessageOf } from "../lib/errors";
import { grantLiveConsent, requestLiveToken, withdrawLiveConsent } from "../lib/liveMedia";
import { openStage, type StageConnection, type StageHandle } from "./vonageStage";

export type LiveAvailability = "unknown" | "available" | "not_configured";

export type LiveStageState = {
  availability: LiveAvailability;
  connection: StageConnection;
  remoteStreams: number;
  busy: boolean;
  error: string | null;
};

const INITIAL: LiveStageState = {
  availability: "unknown",
  connection: "idle",
  remoteStreams: 0,
  busy: false,
  error: null,
};

/**
 * Owns one participant's live stage: the consent register, the Vonage connection, and the
 * rule that the two stay in step. A consent that is withdrawn or expires stops the track
 * on the next evaluation, and leaving or unmounting tears everything down.
 */
export function useLiveStage(
  jamId: string | null,
  userId: string | null,
  canJoin: boolean,
  register: {
    consents: readonly LiveConsent[];
    add: (consent: LiveConsent) => void;
    markWithdrawn: (consentId: string) => void;
  },
) {
  const [state, setState] = useState<LiveStageState>(INITIAL);
  const stageRef = useRef<StageHandle | null>(null);
  const cameraRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);

  const patch = useCallback((next: Partial<LiveStageState>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);

  // The register hook re-publishes its rows when a grant lapses, so this follows expiry
  // without a clock of its own. A likeness grant is filtered out inside `permittedKinds`.
  const permitted = useMemo(
    () => (userId ? permittedKinds(register.consents, userId) : new Set<LiveTrackKind>()),
    [register.consents, userId],
  );

  // The published set follows the permitted set, in both directions.
  useEffect(() => {
    if (!stageRef.current) return;
    void stageRef.current.applyPermissions(permitted);
  }, [permitted]);

  const join = useCallback(async () => {
    if (!jamId || stageRef.current) return;
    patch({ busy: true, error: null });
    try {
      const outcome = await requestLiveToken(jamId);
      if (outcome.status === "not_configured") {
        patch({ availability: "not_configured", busy: false, error: outcome.safeMessage });
        return;
      }
      if (!cameraRef.current || !screenRef.current) {
        patch({ busy: false, error: "The live stage is not ready yet." });
        return;
      }

      const handle = await openStage(
        { authId: outcome.live.authId, sessionId: outcome.live.sessionId, token: outcome.live.token },
        { camera: cameraRef.current, screen: screenRef.current },
        {
          onConnection: (connection) => patch({ connection }),
          onRemoteStreams: (remoteStreams) => patch({ remoteStreams }),
          onError: (error) => patch({ error }),
        },
      );
      stageRef.current = handle;
      patch({ availability: "available", busy: false });
      // Joining publishes nothing on its own; only standing consent does.
      await handle.applyPermissions(permitted);
    } catch (error) {
      patch({ busy: false, error: safeMessageOf(error, "The live stage could not be joined.") });
    }
  }, [jamId, patch, permitted]);

  const leave = useCallback(async () => {
    const handle = stageRef.current;
    stageRef.current = null;
    if (handle) await handle.leave();
    patch({ connection: "idle", remoteStreams: 0 });
  }, [patch]);

  const grant = useCallback(async (kind: LiveTrackKind, purpose: string) => {
    if (!jamId) return;
    patch({ busy: true, error: null });
    try {
      register.add(await grantLiveConsent(jamId, kind, purpose));
      patch({ busy: false });
    } catch (error) {
      patch({ busy: false, error: safeMessageOf(error, "That consent could not be recorded.") });
    }
  }, [jamId, patch, register]);

  const withdraw = useCallback(async (consentId: string) => {
    patch({ busy: true, error: null });
    try {
      await withdrawLiveConsent(consentId);
      // Stop locally at once rather than waiting for the row to come back through Realtime.
      register.markWithdrawn(consentId);
      patch({ busy: false });
    } catch (error) {
      patch({ busy: false, error: safeMessageOf(error, "That consent could not be withdrawn.") });
    }
  }, [patch, register]);

  // Unmounting the studio, navigating away or losing the room stops every track.
  useEffect(() => () => {
    const handle = stageRef.current;
    stageRef.current = null;
    if (handle) void handle.leave();
  }, []);

  return {
    state,
    permitted,
    joined: stageRef.current !== null || state.connection !== "idle",
    refs: { camera: cameraRef, screen: screenRef },
    actions: { join, leave, grant, withdraw },
  };
}
