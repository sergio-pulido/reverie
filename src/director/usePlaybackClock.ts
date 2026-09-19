import { useCallback, useEffect, useRef, useState } from "react";
import { playheadSeconds, type PlaybackAnchor, type PlaybackReading } from "../core/playbackClock";
import { JamError, safeMessageOf } from "../lib/errors";
import { pausePlayback, readPlayback, resetPlayback, startPlayback } from "../lib/playbackClock";

/**
 * The room's shared clock, ticking in this browser.
 *
 * The database is the authority and this only advances the reading it was
 * given, so two screens on one room agree. It re-reads on an interval as well,
 * because another device may have started or paused it.
 */

const REREAD_MS = 5_000;
/** Four times a second: a playhead that visibly moves without a frame loop. */
const TICK_MS = 250;

export interface PlaybackClock {
  reading: PlaybackReading | null;
  /** Seconds into the film, clamped to its runtime. */
  playhead: number;
  /** Null until a reading arrives; "unavailable" when this room has no clock here. */
  error: string | null;
  available: boolean;
  start: () => void;
  pause: () => void;
  reset: () => void;
}

export function usePlaybackClock(jamId: string | null, runtimeSeconds: number): PlaybackClock {
  const [anchor, setAnchor] = useState<PlaybackAnchor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const mounted = useRef(true);

  const take = useCallback((reading: PlaybackReading) => {
    if (!mounted.current) return;
    setAnchor({ reading, receivedAt: performance.now() });
    setError(null);
  }, []);

  const fail = useCallback((cause: unknown, fallback: string) => {
    if (mounted.current) setError(safeMessageOf(cause, fallback));
    // A missing Supabase project or a missing function will not appear between
    // one read and the next, so asking again twelve times a minute only spends
    // renders saying the same thing.
    return cause instanceof JamError && cause.code === "not_configured";
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!jamId) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    const read = () =>
      void readPlayback(jamId)
        .then(take)
        .catch((cause: unknown) => {
          if (fail(cause, "The playback clock could not be read.") && interval !== null) {
            clearInterval(interval);
            interval = null;
          }
        });
    read();
    interval = setInterval(read, REREAD_MS);
    return () => {
      if (interval !== null) clearInterval(interval);
    };
  }, [jamId, take, fail]);

  // Only a playing clock needs a tick; a paused one is already where it is.
  const playing = anchor?.reading.status === "playing";
  useEffect(() => {
    if (!playing) return;
    const tick = setInterval(() => setNow(performance.now()), TICK_MS);
    return () => clearInterval(tick);
  }, [playing]);

  const control = useCallback(
    (action: (id: string) => Promise<PlaybackReading>, fallback: string) => {
      if (!jamId) return;
      void action(jamId)
        .then(take)
        .catch((cause: unknown) => fail(cause, fallback));
    },
    [jamId, take, fail],
  );

  return {
    reading: anchor?.reading ?? null,
    // `now` only matters while the clock is playing; a stopped one is already where it is.
    playhead: playheadSeconds(anchor, now, runtimeSeconds),
    error,
    available: anchor !== null,
    start: useCallback(() => control(startPlayback, "Playback could not be started."), [control]),
    pause: useCallback(() => control(pausePlayback, "Playback could not be paused."), [control]),
    reset: useCallback(() => control(resetPlayback, "Playback could not be reset."), [control]),
  };
}
