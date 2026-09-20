import { useCallback, useEffect, useRef, useState } from "react";
import type { DirectorAuditEntry } from "../core/directorAudit";
import type { DirectorBeatWindow } from "../core/directorBeats";
import { initialDirectorState, type DirectorState } from "../core/directorProtocol";
import { unopenedSpend, type DirectorSpend } from "../core/directorSpend";
import type { SessionSettings } from "../core/session";
import {
  attachDirectorSession,
  directorPlaylistSrc,
  directorRecordingSrc,
  DirectorSessionError,
  endDirectorSession,
  readDirectorBudget,
  readDirectorSession,
  renewDirectorSession,
  sendDirection,
  startDirectorSession,
  watchDirectorStream,
  type OpenedDirectorSession,
} from "../lib/directorSession";
import { attachHlsStream } from "../lib/hlsPlayback";

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
const ATTACH_MS = 3_000;
/** Four times a second: a playhead that visibly moves without a frame loop. */
const PLAYHEAD_MS = 250;

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
  /**
   * Where the viewer is in the live take, in seconds, or null when nothing is
   * playing.
   *
   * Read off the media element rather than derived from the session snapshot,
   * because the snapshot's position is the provider's generation frontier and
   * moves once per chunk. This is what the viewer is actually watching, and it
   * is the only signal in the session that advances continuously.
   */
  playheadSeconds: number | null;
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
  const [playheadSeconds, setPlayheadSeconds] = useState<number | null>(null);
  const [audit, setAudit] = useState<DirectorAuditEntry[]>([]);
  const [spend, setSpend] = useState<DirectorSpend>(UNKNOWN_SPEND);
  const [configured, setConfigured] = useState(true);
  const [recordingDurable, setRecordingDurable] = useState(true);
  const [recording, setRecording] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [liveDelivery, setLiveDelivery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const open = useRef<{ sessionId: string; viewerId: string | null } | null>(null);
  const starting = useRef(false);
  const live = sessionId !== null;

  useEffect(() => {
    open.current = sessionId ? { sessionId, viewerId } : null;
  }, [sessionId, viewerId]);

  /** The furthest the stream got, remembered so a finished film still says so. */
  const remember = useCallback((window: DirectorBeatWindow | null) => {
    setBeats(window);
    const reached = window?.currentBeatIndex;
    if (reached === null || reached === undefined) return;
    setProducedThrough((furthest) => (furthest === null ? reached : Math.max(furthest, reached)));
  }, []);

  const adopt = useCallback((opened: OpenedDirectorSession) => {
    setSessionId(opened.sessionId);
    setViewerId(opened.viewerId ?? null);
    setLiveDelivery(opened.liveDelivery ?? false);
    setState(opened.state);
    setSpend(opened.spend);
    setAttached(opened.attached);
    setRecordingDurable(opened.recordingDurable);
    setProducedThrough(null);
    remember(opened.beats);
  }, [remember]);

  // Every screen joins the shared stream if one already exists, but this call
  // can never open a paid session. Only the host's explicit Start does that.
  useEffect(() => {
    if (!jamId || sessionId) return;
    let cancelled = false;
    let joining = false;
    const join = async () => {
      if (joining || starting.current) return;
      joining = true;
      try {
        const opened = await attachDirectorSession(jamId, configuration);
        if (cancelled) {
          void endDirectorSession(jamId, opened.sessionId, opened.viewerId).catch(
            () => undefined,
          );
          return;
        }
        adopt(opened);
      } catch {
        // `no_stream` is the ordinary answer before the host starts.
      } finally {
        joining = false;
      }
    };
    void join();
    const poll = setInterval(() => void join(), ATTACH_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [adopt, configuration, jamId, sessionId]);

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
    const renew = setInterval(
      () => renewDirectorSession(jamId, sessionId, viewerId ?? undefined),
      RENEW_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(renew);
    };
  }, [jamId, sessionId, viewerId, remember]);

  // HLS is the room-wide delivery path where the server has enabled it.
  useEffect(() => {
    const element = video.current;
    if (!element || !jamId || !sessionId || !liveDelivery) return;
    const attachment = attachHlsStream(
      element,
      directorPlaylistSrc(jamId, sessionId),
      { onFailure: setFailure },
    );
    return () => attachment.detach();
  }, [jamId, liveDelivery, sessionId]);

  // Watched as it is generated rather than after it. The browser peers with
  // our server, which already holds the provider connection.
  useEffect(() => {
    if (!jamId || !sessionId || liveDelivery) return;
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
  }, [jamId, liveDelivery, sessionId]);

  // A stream left open keeps billing, so it is closed when this unmounts.
  useEffect(
    () => () => {
      const running = open.current;
      // Unmount is one viewer leaving, never authority to stop the room.
      if (jamId && running?.viewerId) {
        void endDirectorSession(jamId, running.sessionId, running.viewerId).catch(
          () => undefined,
        );
      }
    },
    [jamId],
  );

  const start = useCallback(async () => {
    if (!jamId) return;
    starting.current = true;
    setBusy(true);
    setFailure(null);
    setRecording(null);
    try {
      const opened = await startDirectorSession(jamId, configuration);
      adopt(opened);
    } catch (error) {
      setFailure(
        error instanceof DirectorSessionError
          ? error.message
          : "The live director could not be started.",
      );
    } finally {
      starting.current = false;
      setBusy(false);
    }
  }, [adopt, configuration, jamId]);

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
      setViewerId(null);
      setLiveDelivery(false);
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

  /**
   * The media element's own clock, re-read on an interval.
   *
   * `timeupdate` is not enough on its own: it stops firing when a live stream
   * stalls, so a reading kept from the last event would sit still and be read
   * as a film that has stopped advancing rather than one that is waiting.
   * Re-reading the element says what is true right now either way.
   */
  const readPlayhead = useCallback(() => {
    const element = video.current;
    if (!element) return;
    // A paused element, or one with nothing decoded yet, reports currentTime 0
    // — which is a real position for beat one and would put it on screen
    // before a single frame had arrived. Only a playing element has a playhead.
    if (element.paused || element.readyState < 2) {
      setPlayheadSeconds(null);
      return;
    }
    const at = element.currentTime;
    setPlayheadSeconds(Number.isFinite(at) && at >= 0 ? at : null);
  }, []);

  useEffect(() => {
    if (!live) {
      setPlayheadSeconds(null);
      return;
    }
    readPlayhead();
    const tick = setInterval(readPlayhead, PLAYHEAD_MS);
    return () => clearInterval(tick);
  }, [live, readPlayhead]);

  const videoRef = useCallback(
    (element: HTMLVideoElement | null) => {
      video.current = element;
      if (element) readPlayhead();
    },
    [readPlayhead],
  );

  return {
    sessionId,
    live,
    busy,
    state,
    beats,
    producedThrough,
    playheadSeconds,
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
