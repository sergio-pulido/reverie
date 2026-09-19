import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  configurationKey,
  nextPlayerAction,
  playingPortionIndex,
  DEFAULT_CONFIGURATION,
  type PlaybackSnapshot,
} from "../core/portionPlayback";
import type { SessionSettings } from "../core/session";
import {
  advancePortionPlayback,
  getPortionPlayback,
  portionVideoSrc,
  PortionPlaybackError,
  startPortionPlayback,
} from "../lib/portionPlayback";

/**
 * How often a viewer re-reads the jam's portion playback state. Like the room
 * clock's poll, this is the interim surface: `docs/API_CONTRACTS.md` makes the
 * `portion.locked` / `media.*` Realtime events the contract, so this stays one
 * named constant a later slice replaces with a subscription.
 */
export const PORTION_POLL_MS = 5_000;

export type PortionPlayerState = {
  snapshot: PlaybackSnapshot | null;
  /** The clip currently addressed by the player, if playback reached one. */
  portionIndex: number | null;
  src: string | null;
  /** The portion whose clip is still being generated, if the room waits. */
  generatingIndex: number | null;
  portionCount: number;
  /** The viewer asked to watch; the film continues on its own from here. */
  watching: boolean;
  busy: boolean;
  finished: boolean;
  error: string | null;
  /** Set when this server cannot generate video at all. Not a transient error. */
  disabled: string | null;
  configuration: SessionSettings;
};

/**
 * Drives one viewer's reproduction of a jam's generated portions.
 *
 * The server owns the cursor: this hook reads the snapshot, asks it to start or
 * advance under the rules in `src/core/portionPlayback.ts`, and never decides on
 * its own that a clip is ready. Advancing happens only when the clip that is
 * playing has ended, so a portion finishing generation early never cuts the
 * current one short.
 *
 * `canDrive` separates watching from driving: per `docs/API_CONTRACTS.md`
 * start and advance are host-only. The server does not enforce that yet (no
 * authorization on those routes), so this is an honest UI boundary, not a
 * security control.
 */
export function usePortionPlayback(
  jamId: string | null,
  options: { enabled: boolean; canDrive: boolean; configuration?: SessionSettings | null },
) {
  const { enabled, canDrive } = options;
  const configuration = options.configuration ?? DEFAULT_CONFIGURATION;
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState<string | null>(null);
  // True between "this clip is over" (or "nothing is playing yet") and the
  // server actually moving the cursor forward.
  const wantsNext = useRef(false);
  const latest = useRef<PlaybackSnapshot | null>(null);
  const driving = useRef(false);

  const apply = useCallback((next: PlaybackSnapshot) => {
    latest.current = next;
    setSnapshot(next);
  }, []);

  const watchingRef = useRef(false);

  const handleFailure = useCallback((caught: unknown) => {
    if (caught instanceof PortionPlaybackError) {
      if (caught.code === "generation_disabled") {
        // Not a transient failure: this server cannot make video at all, and
        // says so instead of pretending a clip is coming.
        setDisabled(caught.safeMessage);
        setWatching(false);
        watchingRef.current = false;
        return;
      }
      setError(caught.safeMessage);
      return;
    }
    setError("This jam's playback could not be read.");
  }, []);

  /** One step forward, and only the step the snapshot allows. */
  const pump = useCallback(async () => {
    const current = latest.current;
    if (!jamId || !canDrive || driving.current || !watchingRef.current || !current) return;
    const action = nextPlayerAction(current);
    if (action.kind === "wait") return;
    if (action.kind === "finished") {
      wantsNext.current = false;
      return;
    }
    if (action.kind === "failed") {
      setError("The video for this portion could not be generated.");
      return;
    }
    // A ready next clip waits for the current one to end: the cursor is the
    // room's position, so moving it early would cut the portion short.
    if (action.kind === "advance" && !wantsNext.current) return;

    driving.current = true;
    setBusy(true);
    try {
      const next = action.kind === "start"
        ? await startPortionPlayback(jamId)
        : await advancePortionPlayback(jamId, action.expectedStateVersion);
      apply(next);
      setError(null);
      if (action.kind === "advance") wantsNext.current = false;
    } catch (caught) {
      const code = caught instanceof PortionPlaybackError ? caught.code : null;
      if (code === "media_not_ready") {
        // Expected while the clip is still generating: hold, the poll returns.
      } else if (code === "stale_state_version" || code === "invalid_transition") {
        // Somebody else moved the room on. Re-read and act on what is true now.
        try {
          apply(await getPortionPlayback(jamId));
        } catch {
          /* the poll below retries */
        }
      } else {
        handleFailure(caught);
      }
    } finally {
      driving.current = false;
      setBusy(false);
    }
  }, [jamId, canDrive, apply, handleFailure]);

  useEffect(() => {
    if (!jamId || !enabled) {
      latest.current = null;
      setSnapshot(null);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function read() {
      if (!live || !jamId) return;
      try {
        const next = await getPortionPlayback(jamId);
        if (!live) return;
        apply(next);
        setError(null);
      } catch (caught) {
        if (!live) return;
        handleFailure(caught);
      }
      if (live) await pump();
      if (live) timer = setTimeout(() => void read(), PORTION_POLL_MS);
    }

    void read();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      timer = null;
    };
  }, [jamId, enabled, apply, handleFailure, pump]);

  const play = useCallback(() => {
    setError(null);
    setWatching(true);
    watchingRef.current = true;
    wantsNext.current = true;
    void pump();
  }, [pump]);

  /** Stop watching. The room's cursor only moves forward, so this is a local
   * stop: it never rewinds or pauses the jam for anyone else. */
  const stop = useCallback(() => {
    setWatching(false);
    watchingRef.current = false;
  }, []);

  /** The clip in the player reached its end: now the cursor may move. */
  const portionEnded = useCallback(() => {
    wantsNext.current = true;
    void pump();
  }, [pump]);

  const state: PortionPlayerState = useMemo(() => {
    const portionIndex = snapshot ? playingPortionIndex(snapshot) : null;
    const pending = snapshot ? nextPlayerAction(snapshot) : null;
    return {
      snapshot,
      portionIndex,
      src: jamId !== null && portionIndex !== null
        ? portionVideoSrc(jamId, portionIndex, configurationKey(configuration))
        : null,
      generatingIndex: pending?.kind === "wait" ? pending.portionIndex : null,
      portionCount: snapshot?.portions.length ?? 0,
      watching,
      busy,
      finished: snapshot?.playback.status === "finished",
      error,
      disabled,
      configuration,
    };
  }, [snapshot, jamId, configuration, watching, busy, error, disabled]);

  useEffect(() => {
    if (state.finished && watchingRef.current) {
      setWatching(false);
      watchingRef.current = false;
    }
  }, [state.finished]);

  return { state, actions: { play, stop, portionEnded } };
}
