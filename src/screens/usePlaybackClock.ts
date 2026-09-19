import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  playbackPosition,
  type JamPlaybackClock,
  type PlaybackPosition,
} from "../core/playbackClock";
import { safeMessageOf } from "../lib/errors";
import {
  getJamPlayback,
  pauseJamPlayback,
  resetJamPlayback,
  startJamPlayback,
} from "../lib/playback";

/**
 * How often a viewer re-reads the server anchor. This is the interim polling
 * surface: the contract is Realtime events, so this value is deliberately a
 * single named constant that a later slice replaces with a subscription.
 */
export const PLAYBACK_POLL_MS = 2_500;

/** Local re-render cadence while playing, so the counter advances smoothly between polls. */
const TICK_MS = 200;

/** A monotonic reading. Never the wall clock, so a device with the wrong time cannot drift. */
function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export type PlaybackClockState = {
  clock: JamPlaybackClock | null;
  position: PlaybackPosition;
  error: string | null;
  busy: boolean;
};

/**
 * Tracks one room's shared position. The server owns the anchor; this hook reads it,
 * re-reads it on an interval, and advances it locally with a monotonic clock so every
 * viewer shows the same counter without trusting anyone's wall clock.
 *
 * `enabled` is false for a viewer who is not an active member, so a waiting participant
 * neither polls nor sees a position.
 *
 * No screen mounts this in the current build (see `PlaybackBar`).
 */
export function usePlaybackClock(jamId: string | null, enabled: boolean) {
  const [clock, setClock] = useState<JamPlaybackClock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const receivedAt = useRef(0);

  const apply = useCallback((next: JamPlaybackClock) => {
    receivedAt.current = monotonicNow();
    setClock(next);
  }, []);

  useEffect(() => {
    if (!jamId || !enabled) {
      setClock(null);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function read() {
      if (!live || !jamId) return;
      try {
        const next = await getJamPlayback(jamId);
        if (!live) return;
        apply(next);
        setError(null);
      } catch (caught) {
        if (!live) return;
        setError(safeMessageOf(caught, "The room's position could not be read."));
      }
      if (live) timer = setTimeout(() => void read(), PLAYBACK_POLL_MS);
    }

    void read();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      timer = null;
    };
  }, [jamId, enabled, apply]);

  // Only a playing clock needs local ticks; paused and idle positions are static.
  useEffect(() => {
    if (clock?.status !== "playing") return;
    const interval = setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => clearInterval(interval);
  }, [clock?.status]);

  const position = useMemo(
    () => playbackPosition(clock, receivedAt.current, monotonicNow()),
    // `tick` is the render trigger while the clock plays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clock, tick],
  );

  const control = useCallback(
    async (run: (id: string) => Promise<JamPlaybackClock>, fallback: string) => {
      if (!jamId || busy) return;
      setBusy(true);
      setError(null);
      try {
        apply(await run(jamId));
      } catch (caught) {
        setError(safeMessageOf(caught, fallback));
      } finally {
        setBusy(false);
      }
    },
    [jamId, busy, apply],
  );

  const actions = useMemo(() => ({
    start: () => control(startJamPlayback, "Playback could not be started."),
    pause: () => control(pauseJamPlayback, "Playback could not be paused."),
    reset: () => control(resetJamPlayback, "Playback could not be reset."),
  }), [control]);

  const state: PlaybackClockState = { clock, position, error, busy };
  return { state, actions };
}
