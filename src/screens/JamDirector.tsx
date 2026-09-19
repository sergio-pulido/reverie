import { useCallback, useEffect, useRef, useState } from "react";
import { hasRecording, lifecycleLabel, type JamLifecycle } from "../core/jamLifecycle";
import {
  directorArchivePieceSrc,
  directorArchiveVideoSrc,
  listDirectorArchive,
  readDirectorArchive,
  readJamLifecycle,
  type ArchivedPiece,
} from "../lib/directorSession";
import { Notice } from "../chrome";
import {
  initialDirectorState,
  type DirectorState,
} from "../core/directorProtocol";
import type { DirectorAuditEntry } from "../core/directorAudit";
import type { DirectorBeatWindow } from "../core/directorBeats";
import type { SessionSettings } from "../core/session";
import { attachHlsStream } from "../lib/hlsPlayback";
import {
  attachDirectorSession,
  directorPlaylistSrc,
  directorRecordingSrc,
  DirectorSessionError,
  endDirectorSession,
  readDirectorSession,
  renewDirectorSession,
  sendDirection,
  startDirectorSession,
  watchDirectorStream,
  type OpenedDirectorSession,
} from "../lib/directorSession";

type JamDirectorProps = {
  jamId: string;
  /** Only the host opens a stream: it bills by the second. */
  canDrive: boolean;
  /** Viewers on the same configuration share one stream. */
  configuration: SessionSettings | null;
};

const POLL_MS = 2_000;
const RENEW_MS = 30_000;
/** How often a room that is not yet streaming checks whether it has started. */
const ATTACH_MS = 3_000;

/**
 * The live director: one continuous MiniMax H3 Max stream the room directs.
 *
 * The stream itself lives on the server, which is the WebRTC peer. This screen
 * never touches the provider — it asks the server to send direction and reads
 * back what happened. The recording is what you watch, and the audit trail is
 * what you check it against.
 */
export function JamDirector({ jamId, canDrive, configuration }: JamDirectorProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<DirectorState>(initialDirectorState);
  const [audit, setAudit] = useState<DirectorAuditEntry[]>([]);
  const [durable, setDurable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [direction, setDirection] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  /** The finished film's pieces, so a viewer can go straight to a minute. */
  const [pieces, setPieces] = useState<ArchivedPiece[]>([]);
  const [archivedSession, setArchivedSession] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const [beats, setBeats] = useState<DirectorBeatWindow | null>(null);
  const [attached, setAttached] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [liveDelivery, setLiveDelivery] = useState(false);
  const [playbackFailure, setPlaybackFailure] = useState<string | null>(null);
  // The room's life, as the server holds it. Read once on mount so a reopened
  // tab shows an ended room as ended, then kept current by start and stop.
  const [lifecycle, setLifecycle] = useState<JamLifecycle>("live");
  const live = sessionId !== null;
  const active = useRef<{ sessionId: string; viewerId: string | null } | null>(null);
  const screen = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    active.current = sessionId ? { sessionId, viewerId } : null;
  }, [sessionId, viewerId]);

  /** Takes up a stream this viewer has just opened or joined. */
  const adopt = useCallback((opened: OpenedDirectorSession) => {
    setSessionId(opened.sessionId);
    setViewerId(opened.viewerId ?? null);
    setLiveDelivery(opened.liveDelivery ?? false);
    setState(opened.state);
    setBeats(opened.beats);
    setAttached(opened.attached);
    setDurable(opened.recordingDurable);
  }, []);

  /**
   * Plays the shared stream.
   *
   * The playlist is the same address for everyone watching this configuration,
   * so a second viewer costs a cache hit rather than a second paid session.
   */
  useEffect(() => {
    const video = screen.current;
    if (!video || !sessionId || !liveDelivery) return;
    setPlaybackFailure(null);
    const attachment = attachHlsStream(video, directorPlaylistSrc(jamId, sessionId), {
      onFailure: setPlaybackFailure,
    });
    return () => attachment.detach();
  }, [jamId, liveDelivery, sessionId]);

  /**
   * Joins a stream that is already running.
   *
   * Opening a jam where the room is watching something should show the film,
   * not a button. This never starts a stream — starting bills a sixty-second
   * minimum, and only the host does it — so a participant either attaches to
   * what is running or waits, which is also how the host rejoins their own
   * stream after reopening the jam.
   */
  useEffect(() => {
    if (sessionId) return;
    let cancelled = false;
    const join = async () => {
      try {
        const opened = await attachDirectorSession(jamId, configuration);
        if (cancelled) return;
        adopt(opened);
      } catch {
        // `no_stream` is the ordinary answer before the host presses start.
      }
    };
    void join();
    const poll = setInterval(() => void join(), ATTACH_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
    // `configuration` is memoized per jam by the studio, so this does not
    // re-attach on every render; the server normalizes it, so two settings that
    // differ only cosmetically resolve to the same stream there regardless.
  }, [adopt, configuration, jamId, sessionId]);

  /**
   * Reads the room's life on mount, and finds its recording if it has ended.
   *
   * Without this a reopened tab would show a finished room as if it were
   * waiting to start, and offer a Start button the server would refuse.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = await readJamLifecycle(jamId);
        if (cancelled) return;
        setLifecycle(current);
        if (!hasRecording(current)) return;
        const archive = await listDirectorArchive(jamId);
        // Newest first, so the room's last session is the one to play.
        const latest = archive.sessions[0];
        if (cancelled || !latest) return;
        const detail = await readDirectorArchive(jamId, latest.id);
        if (cancelled) return;
        const storedPieces = detail.segments ?? [];
        setPieces(storedPieces);
        // A session record can exist even when recording was disabled or no
        // media track arrived. Do not render a video whose URL can only 404.
        if (storedPieces.length > 0) {
          setRecording(directorArchiveVideoSrc(jamId, latest.id));
          setArchivedSession(latest.id);
        }
      } catch {
        // The room still works without this; it just starts from `live`.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jamId]);

  // Polling is the surface until Realtime events land, matching the player.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const snapshot = await readDirectorSession(jamId, sessionId);
        if (cancelled) return;
        setState(snapshot.state);
        setAudit(snapshot.audit);
        setBeats(snapshot.beats);
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
  }, [jamId, sessionId, viewerId]);

  // Watch it as it is generated rather than waiting for the recording. The
  // browser peers with our server, which is already holding the provider
  // connection, so nothing here talks to fal.
  useEffect(() => {
    // The server says which delivery it offers; the relay is the default and
    // HLS displaces it only where it is switched on.
    if (!sessionId || liveDelivery) return;
    let cancelled = false;
    void watchDirectorStream(jamId, sessionId, (stream) => {
      if (video.current) video.current.srcObject = stream;
    })
      .then((close) => {
        if (cancelled) close();
        else detach.current = close;
      })
      .catch(() => {
        // Live viewing is an addition, not the session: a viewer that cannot
        // attach still has state, the audit trail and the recording.
      });
    return () => {
      cancelled = true;
      detach.current?.();
      detach.current = null;
      if (video.current) video.current.srcObject = null;
    };
  }, [jamId, liveDelivery, sessionId]);

  // A stream left open keeps billing, so this viewer leaves it when this
  // unmounts — which ends it only if nobody else is still watching.
  useEffect(
    () => () => {
      const open = active.current;
      // Leaving is always a detach, never an outright end. An `/end` with no
      // viewer id stops the stream for the whole room, and closing a tab is
      // not a claim to do that — only the host's deliberate Stop is. Before
      // auto-attach, participants never held a session and never reached this
      // path; now everyone does, so a viewer with nothing to detach must send
      // nothing rather than end the film everyone else is watching.
      if (open?.viewerId) {
        void endDirectorSession(jamId, open.sessionId, open.viewerId).catch(
          () => undefined,
        );
      }
    },
    [jamId],
  );

  const start = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    setRecording(null);
    try {
      const opened = await startDirectorSession(jamId, configuration);
      adopt(opened);
      setLifecycle(opened.lifecycle);
    } catch (error) {
      setFailure(
        error instanceof DirectorSessionError
          ? error.message
          : "The live director could not be started.",
      );
    } finally {
      setBusy(false);
    }
  }, [adopt, configuration, jamId]);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      // The host's stop ends the stream for the room, so it names no viewer.
      // Leaving as a viewer is what closing the screen does; this is the
      // deliberate end of something the host is paying for.
      const stopped = await endDirectorSession(jamId, sessionId);
      setLifecycle(stopped.lifecycle);
      // The pieces land as the muxer finishes them; read what is there now.
      void readDirectorArchive(jamId, sessionId)
        .then((detail) => {
          const storedPieces = detail.segments ?? [];
          setPieces(storedPieces);
          if (storedPieces.length > 0) {
            setRecording(directorArchiveVideoSrc(jamId, sessionId));
            setArchivedSession(sessionId);
          }
        })
        .catch(() => undefined);
    } catch {
      // Ending is idempotent server-side; nothing useful to say here.
    } finally {
      setSessionId(null);
      setViewerId(null);
      setBusy(false);
    }
  }, [jamId, sessionId]);

  const send = useCallback(async () => {
    const body = direction.trim();
    if (!body || !sessionId) return;
    setFailure(null);
    try {
      const sent = await sendDirection(jamId, sessionId, { body });
      setState(sent.state);
      setBeats(sent.beats);
      setDirection("");
    } catch (error) {
      setFailure(
        error instanceof DirectorSessionError
          ? error.message
          : "That direction could not be sent.",
      );
    }
  }, [direction, jamId, sessionId]);

  return <div className="player-card" aria-label="Live director">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">LIVE DIRECTOR</p>
        <h2>Direct it while it runs.</h2>
      </div>
      <span className="playback-status" role="status" data-testid="jam-lifecycle">
        {badge(state, busy, live, lifecycle)}
      </span>
    </div>

    <div className="player-frame">
      {recording ? (
        <video src={recording} controls playsInline data-testid="jam-director-recording" />
      ) : null}
      {!recording && live && liveDelivery ? (
        <video
          ref={screen}
          autoPlay
          muted
          playsInline
          controls
          data-testid="jam-director-live"
        />
      ) : null}
      {/*
        * The relay's element is kept mounted rather than conditionally
        * rendered, because its srcObject is set by an effect that would
        * otherwise race the element into existence.
        */}
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        hidden={!live || liveDelivery}
        data-testid="jam-director-relay"
      />
      {!live && recording && (
        <video src={recording} controls playsInline data-testid="jam-director-recording" />
      )}
      {!live && recording && archivedSession && pieces.length > 1 && (
        <PieceJump
          pieces={pieces}
          onJump={(index) =>
            setRecording(directorArchivePieceSrc(jamId, archivedSession, index))
          }
          onWhole={() => setRecording(directorArchiveVideoSrc(jamId, archivedSession))}
        />
      )}
      {!live && !recording && (
        <p className="player-placeholder">{placeholder(state, live, canDrive)}</p>
      )}
    </div>
    {playbackFailure ? <Notice tone="alert">{playbackFailure}</Notice> : null}

    <p className="form-note" aria-live="polite">{statusLine(state, live, canDrive)}</p>
    {live && beats && <BeatWindow beats={beats} attached={attached} />}

    {/*
      * Only whoever started the stream directs it. Everyone else is watching
      * the same film and is given no controls at all — not disabled ones,
      * which would read as something they could earn. Starting and directing
      * spend money and change what the room sees; both belong to one person.
      */}
    {canDrive ? <>
      <div className="hero-actions">
        <button
          className="button button-primary"
          onClick={() => void start()}
          disabled={busy || live || lifecycle === "ended"}
        >
          {busy && !live ? "Starting…" : "Start the stream"} <span>▶</span>
        </button>
        <button className="button button-quiet" onClick={() => void stop()} disabled={!live || busy}>
          Stop
        </button>
      </div>

      <label className="field">
        <span>New direction</span>
        <input
          value={direction}
          onChange={(event) => setDirection(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
          placeholder="Cut to the lighthouse at dusk."
          disabled={!live}
          maxLength={2000}
        />
      </label>
      <div className="hero-actions">
        <button
          className="button button-quiet"
          onClick={() => void send()}
          disabled={!live || !direction.trim()}
        >
          Direct
        </button>
      </div>
    </> : null}

    <DirectionLog entries={audit} />

    <p className="form-note">
      {canDrive
        ? <>Every direction goes through this server, which holds the stream and
            records it. The stream bills by the second with a one-minute minimum,
            so stop it when you are done.
            {durable ? "" : " This server has no recording storage configured, so the recording is lost when it restarts."}</>
        : <>You are watching the room's stream. Whoever started it directs it;
            everyone here sees the same film.</>}
    </p>

    {failure && <Notice>{failure}</Notice>}
    {state.error && <Notice>{state.error}</Notice>}
  </div>;
}

/**
 * Which beats are closed and which can still change.
 *
 * The beat on screen and the one behind it are already with the provider, so
 * an edit there would arrive too late to matter. Saying so is the point: the
 * gap is the room's window to react to a change before it is rendered.
 */
function BeatWindow({
  beats,
  attached,
}: {
  beats: DirectorBeatWindow;
  attached: boolean;
}) {
  const playing = beats.currentBeatIndex;
  return <p className="form-note">
    {playing === null
      ? "Beat 1 is already being generated."
      : `Beat ${playing + 1} is playing${
          beats.lockedBeatIndex === null
            ? " and it is the last one"
            : `, beat ${beats.lockedBeatIndex + 1} is already being generated`
        }.`}
    {" "}Edits from beat {beats.minEditableBeatIndex + 1} onward still change the film.
    {attached ? " You joined a stream this room already had open." : ""}
  </p>;
}

/** What was asked for and what the model did with it. */
function DirectionLog({ entries }: { entries: DirectorAuditEntry[] }) {
  const directions = entries.filter((entry) => entry.kind === "direction_sent");
  if (directions.length === 0) return null;
  return <ol className="contribution-list" aria-label="Directions sent">
    {directions.map((entry) => {
      const applied = entries.some(
        (other) =>
          other.kind === "direction_applied" && other.promptVersion === entry.promptVersion,
      );
      const rejected = entries.some(
        (other) =>
          other.kind === "direction_rejected" && other.promptVersion === entry.promptVersion,
      );
      return <article className="contribution director" key={`${entry.promptVersion}-${entry.at}`}>
        <span>{applied ? "applied" : rejected ? "refused" : "pending"}</span>
        <p>{entry.body}</p>
      </article>;
    })}
  </ol>;
}

/**
 * What the room shows about itself.
 *
 * The lifecycle is the base — live, playing, ended — with the transitional
 * detail the stream reports laid over it, so "PLAYING" does not appear while
 * the provider is still warming up and the screen is still blank.
 */
function badge(
  state: DirectorState,
  busy: boolean,
  live: boolean,
  lifecycle: JamLifecycle,
): string {
  if (busy && !live) return "STARTING";
  if (state.status === "failed") return "FAILED";
  if (live && state.status !== "streaming") return "WARMING UP";
  return lifecycleLabel(lifecycle).toUpperCase();
}

function placeholder(state: DirectorState, live: boolean, canDrive: boolean): string {
  if (state.status === "failed") return "The stream stopped.";
  if (live) {
    return canDrive
      ? "The stream is running on the server and forwarded here as it is generated."
      : "The stream is running on the server.";
  }
  if (!canDrive) return "The host starts the live stream. It appears here when they do.";
  return "Nothing is streaming yet.";
}

function statusLine(state: DirectorState, live: boolean, canDrive: boolean): string {
  if (live && state.status === "streaming") {
    const seconds = Math.round(state.generatedSeconds);
    return `Live: ${seconds}s recorded across ${state.chunksReceived} chunk(s). Direction ${state.appliedPromptVersion} is playing.`;
  }
  if (live) return "Connected. The opening of the script is being generated.";
  if (state.endedReason === "session_limit") {
    return "The stream reached this server's session limit.";
  }
  return canDrive
    ? "Starting a stream opens a paid session that bills for at least a minute."
    : "Only the host can open the live stream.";
}

/**
 * Go to a minute of the film by picking the piece that contains it.
 *
 * A piece is playable on its own and begins on a keyframe, so jumping costs
 * one small request rather than downloading everything before the target.
 */
function PieceJump({
  pieces,
  onJump,
  onWhole,
}: {
  pieces: ArchivedPiece[];
  onJump: (index: number) => void;
  onWhole: () => void;
}) {
  return (
    <nav className="hero-actions" aria-label="Go to a moment in the film">
      <button className="button button-quiet" onClick={onWhole}>
        Whole film
      </button>
      {pieces.map((piece) => (
        <button
          key={piece.segmentIndex}
          className="button button-quiet"
          onClick={() => onJump(piece.segmentIndex)}
          data-testid={`jam-piece-${piece.segmentIndex}`}
        >
          {clock(piece.startSeconds)}
        </button>
      ))}
    </nav>
  );
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
