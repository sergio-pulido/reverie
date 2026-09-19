import { useCallback, useEffect, useRef, useState } from "react";
import type { DirectorAuditEntry } from "../core/directorAudit";
import type { DirectorBeatWindow } from "../core/directorBeats";
import { initialDirectorState, type DirectorState } from "../core/directorProtocol";
import { unopenedSpend, type DirectorSpend } from "../core/directorSpend";
import type { SessionSettings } from "../core/session";
import {
  directorRecordingSrc,
  DirectorSessionError,
  endDirectorSession,
  readDirectorBudget,
  readDirectorSession,
  renewDirectorSession,
  sendDirection,
  startDirectorSession,
  watchDirectorStream,
} from "../lib/directorSession";

/**
 * One person's live Director session.
 *
 * The stream lives on the server, which is the WebRTC peer: this hook asks it
 * to open a session, asks it to send direction, and reads back what happened.
 * Nothing here talks to the provider, and nothing here decides what a beat
 * costs — both are the server's, and both are read from it.
 */

const POLL_MS = 2_000;
const RENEW_MS = 30_000;

/** Until the server answers, a budget of nothing: it is what cannot be disproved. */
const UNKNOWN_SPEND: DirectorSpend = unopenedSpend({
  budgetUsd: 0,
  usdPerSecond: 0,
  minBilledSeconds: 0,
});

export interface DirectorSession {
  sessionId: string | null;
  live: boolean;
  busy: boolean;
  state: DirectorState;
  /** The stream's beat window while a session is open; null when none is. */
  beats: DirectorBeatWindow | null;
  /** Highest beat this screen has seen the stream reach, kept after it stops. */
  producedThrough: number | null;
  audit: DirectorAuditEntry[];
  spend: DirectorSpend;
  /** False when no director is configured on this server at all. */
  configured: boolean;
  /** False when the server has no storage: the recording is lost on restart. */
  recordingDurable: boolean;
  /** The finished session's video, once one has ended here. */
  recording: string | null;
  /** True when this joined a stream this jam already had open. */
  attached: boolean;
  failure: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  direct: (body: string, beatIndex?: number) => Promise<boolean>;
  dismissFailure: () => void;
  /** Hands the live track to a video element, or takes it back on unmount. */
  videoRef: (element: HTMLVideoElement | null) => void;
}

export function useDirectorSession(
  jamId: string | null,
  configuration: SessionSettings | null,
): DirectorSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<DirectorState>(initialDirectorState);
  const [beats, setBeats] = useState<DirectorBeatWindow | null>(null);
  const [producedThrough, setProducedThrough] = useState<number | null>(null);
  const [audit, setAudit] = useState<DirectorAuditEntry[]>([]);
  const [spend, setSpend] = useState<DirectorSpend>(UNKNOWN_SPEND);
  const [configured, setConfigured] = useState(true);
  const [recordingDurable, setRecordingDurable] = useState(true);
  const [recording, setRecording] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const open = useRef<string | null>(null);
  const live = sessionId !== null;

  useEffect(() => {
    open.current = sessionId;
  }, [sessionId]);

  /** The furthest the stream got, remembered so a finished film still says so. */
  const remember = useCallback((window: DirectorBeatWindow | null) => {
    setBeats(window);
    const reached = window?.currentBeatIndex;
    if (reached === null || reached === undefined) return;
    setProducedThrough((furthest) => (furthest === null ? reached : Math.max(furthest, reached)));
  }, []);

  // What this server will spend, read before anything is spent on it.
  useEffect(() => {
    if (!jamId) return;
    let active = true;
    void readDirectorBudget(jamId)
      .then((budget) => {
        if (!active) return;
        setConfigured(budget.configured);
        setSpend(budget.spend);
      })
      .catch(() => {
        // A server that cannot answer leaves the budget unknown, which reads
        // as nothing available — never as an unlimited one.
      });
    return () => {
      active = false;
    };
  }, [jamId]);

  // Polling is the surface until Realtime events land, matching the player.
  useEffect(() => {
    if (!jamId || !sessionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const snapshot = await readDirectorSession(jamId, sessionId);
        if (cancelled) return;
        setState(snapshot.state);
        setAudit(snapshot.audit);
        setSpend(snapshot.spend);
        remember(snapshot.beats);
      } catch {
        // A closed session stops answering; the stop path owns that state.
      }
    };
    void tick();
    const poll = setInterval(() => void tick(), POLL_MS);
    const renew = setInterval(() => renewDirectorSession(jamId, sessionId), RENEW_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(renew);
    };
  }, [jamId, sessionId, remember]);

  // Watched as it is generated rather than after it. The browser peers with
  // our server, which already holds the provider connection.
  useEffect(() => {
    if (!jamId || !sessionId) return;
    let cancelled = false;
    void watchDirectorStream(jamId, sessionId, (stream) => {
      if (video.current) video.current.srcObject = stream;
    })
      .then((close) => {
        if (cancelled) close();
        else detach.current = close;
      })
      .catch(() => {
        // Live viewing is an addition, not the session: a screen that cannot
        // attach still has state, the trail and the recording.
      });
    return () => {
      cancelled = true;
      detach.current?.();
      detach.current = null;
      if (video.current) video.current.srcObject = null;
    };
  }, [jamId, sessionId]);

  // A stream left open keeps billing, so it is closed when this unmounts.
  useEffect(
    () => () => {
      const running = open.current;
      if (jamId && running) void endDirectorSession(jamId, running).catch(() => undefined);
    },
    [jamId],
  );

  const start = useCallback(async () => {
    if (!jamId) return;
    setBusy(true);
    setFailure(null);
    setRecording(null);
    try {
      const opened = await startDirectorSession(jamId, configuration);
      setSessionId(opened.sessionId);
      setState(opened.state);
      setSpend(opened.spend);
      setAttached(opened.attached);
      setRecordingDurable(opened.recordingDurable);
      setProducedThrough(null);
      remember(opened.beats);
    } catch (error) {
      setFailure(
        error instanceof DirectorSessionError
          ? error.message
          : "The live director could not be started.",
      );
    } finally {
      setBusy(false);
    }
  }, [configuration, jamId, remember]);

  const stop = useCallback(async () => {
    if (!jamId || !sessionId) return;
    setBusy(true);
    try {
      await endDirectorSession(jamId, sessionId);
      setRecording(directorRecordingSrc(jamId, sessionId));
    } catch {
      // Ending is idempotent server-side; nothing useful to say here.
    } finally {
      setSessionId(null);
      setBeats(null);
      setBusy(false);
    }
  }, [jamId, sessionId]);

  const direct = useCallback(
    async (body: string, beatIndex?: number) => {
      const said = body.trim();
      if (!jamId || !sessionId || !said) return false;
      setFailure(null);
      try {
        const sent = await sendDirection(jamId, sessionId, {
          body: said,
          ...(beatIndex === undefined ? {} : { beatIndex }),
        });
        setState(sent.state);
        remember(sent.beats);
        return true;
      } catch (error) {
        setFailure(
          error instanceof DirectorSessionError
            ? error.message
            : "That direction could not be sent.",
        );
        return false;
      }
    },
    [jamId, sessionId, remember],
  );

  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    video.current = element;
  }, []);

  return {
    sessionId,
    live,
    busy,
    state,
    beats,
    producedThrough,
    audit,
    spend,
    configured,
    recordingDurable,
    recording,
    attached,
    failure,
    start,
    stop,
    direct,
    dismissFailure: useCallback(() => setFailure(null), []),
    videoRef,
  };
}
