import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isConsentEffective,
  permittedKinds,
  type LiveConsent,
  type LiveTrackKind,
} from "../core/liveMedia";
import { safeMessageOf } from "../lib/errors";
import {
  grantLiveConsent,
  loadLiveConsents,
  requestLiveToken,
  subscribeToLiveConsents,
  withdrawLiveConsent,
} from "../lib/liveMedia";
import { openStage, type StageConnection, type StageHandle } from "./vonageStage";

export type LiveAvailability = "unknown" | "available" | "not_configured";

export type LiveStageState = {
  availability: LiveAvailability;
  connection: StageConnection;
  consents: readonly LiveConsent[];
  remoteStreams: number;
  busy: boolean;
  error: string | null;
};

const INITIAL: LiveStageState = {
  availability: "unknown",
  connection: "idle",
  consents: [],
  remoteStreams: 0,
  busy: false,
  error: null,
};

function mergeConsent(current: readonly LiveConsent[], incoming: LiveConsent): LiveConsent[] {
  const others = current.filter((consent) => consent.id !== incoming.id);
  return [...others, incoming].sort((a, b) =>
    a.granted_at === b.granted_at ? a.id.localeCompare(b.id) : a.granted_at < b.granted_at ? -1 : 1,
  );
}

/**
 * Owns one participant's live stage: the consent register, the Vonage connection, and the
 * rule that the two stay in step. A consent that is withdrawn or expires stops the track
 * on the next evaluation, and leaving or unmounting tears everything down.
 */
export function useLiveStage(jamId: string | null, userId: string | null, canJoin: boolean) {
  const [state, setState] = useState<LiveStageState>(INITIAL);
  const stageRef = useRef<StageHandle | null>(null);
  const cameraRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const [tick, setTick] = useState(0);

  const patch = useCallback((next: Partial<LiveStageState>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);

  // The register is readable by every active member, so the room can always see who is
  // live and for what, whether or not this participant has joined the stage.
  useEffect(() => {
    if (!jamId || !canJoin) return;
    let active = true;

    void loadLiveConsents(jamId)
      .then((consents) => { if (active) patch({ consents }); })
      .catch((error: unknown) => { if (active) patch({ error: safeMessageOf(error, "The live consent register could not be loaded.") }); });

    const stop = subscribeToLiveConsents(jamId, (consent) => {
      if (!active) return;
      setState((current) => ({ ...current, consents: mergeConsent(current.consents, consent) }));
    });

    return () => { active = false; stop(); };
  }, [jamId, canJoin, patch]);

  const permitted = useMemo(
    () => (userId ? permittedKinds(state.consents, userId) : new Set<LiveTrackKind>()),
    // `tick` is a deliberate dependency: an expiry changes the answer with no new event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.consents, userId, tick],
  );

  // Expiry is a deadline, not an event. Re-evaluate exactly when the next one passes.
  useEffect(() => {
    const now = Date.now();
    const deadlines = state.consents
      .filter((consent) => isConsentEffective(consent, now))
      .map((consent) => Date.parse(consent.expires_at) - now)
      .filter((delay) => Number.isFinite(delay) && delay > 0);
    if (deadlines.length === 0) return;

    const timer = setTimeout(() => setTick((value) => value + 1), Math.min(...deadlines) + 250);
    return () => clearTimeout(timer);
  }, [state.consents, tick]);

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
      const consent = await grantLiveConsent(jamId, kind, purpose);
      setState((current) => ({ ...current, busy: false, consents: mergeConsent(current.consents, consent) }));
    } catch (error) {
      patch({ busy: false, error: safeMessageOf(error, "That consent could not be recorded.") });
    }
  }, [jamId, patch]);

  const withdraw = useCallback(async (consentId: string) => {
    patch({ busy: true, error: null });
    try {
      await withdrawLiveConsent(consentId);
      // Stop locally at once rather than waiting for the row to come back through Realtime.
      setState((current) => ({
        ...current,
        busy: false,
        consents: current.consents.map((consent) =>
          consent.id === consentId ? { ...consent, withdrawn_at: new Date().toISOString() } : consent,
        ),
      }));
    } catch (error) {
      patch({ busy: false, error: safeMessageOf(error, "That consent could not be withdrawn.") });
    }
  }, [patch]);

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
