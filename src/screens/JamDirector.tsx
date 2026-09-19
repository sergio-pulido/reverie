import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "../chrome";
import {
  initialDirectorState,
  type DirectorState,
} from "../core/directorProtocol";
import type { DirectorAuditEntry } from "../core/directorAudit";
import {
  directorRecordingSrc,
  DirectorSessionError,
  endDirectorSession,
  readDirectorSession,
  renewDirectorSession,
  sendDirection,
  startDirectorSession,
} from "../lib/directorSession";

type JamDirectorProps = {
  jamId: string;
  /** Only the host opens a stream: it bills by the second. */
  canDrive: boolean;
};

const POLL_MS = 2_000;
const RENEW_MS = 30_000;

/**
 * The live director: one continuous MiniMax H3 Max stream the room directs.
 *
 * The stream itself lives on the server, which is the WebRTC peer. This screen
 * never touches the provider — it asks the server to send direction and reads
 * back what happened. The recording is what you watch, and the audit trail is
 * what you check it against.
 */
export function JamDirector({ jamId, canDrive }: JamDirectorProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<DirectorState>(initialDirectorState);
  const [audit, setAudit] = useState<DirectorAuditEntry[]>([]);
  const [durable, setDurable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [direction, setDirection] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const live = sessionId !== null;
  const active = useRef<string | null>(null);

  useEffect(() => {
    active.current = sessionId;
  }, [sessionId]);

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
  }, [jamId, sessionId]);

  // A stream left open keeps billing, so it is closed when this unmounts.
  useEffect(
    () => () => {
      const open = active.current;
      if (open) void endDirectorSession(jamId, open).catch(() => undefined);
    },
    [jamId],
  );

  const start = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    setRecording(null);
    try {
      const opened = await startDirectorSession(jamId);
      setSessionId(opened.sessionId);
      setState(opened.state);
      setDurable(opened.recordingDurable);
    } catch (error) {
      setFailure(
        error instanceof DirectorSessionError
          ? error.message
          : "The live director could not be started.",
      );
    } finally {
      setBusy(false);
    }
  }, [jamId]);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      await endDirectorSession(jamId, sessionId);
      setRecording(directorRecordingSrc(jamId, sessionId));
    } catch {
      // Ending is idempotent server-side; nothing useful to say here.
    } finally {
      setSessionId(null);
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
      <span className="playback-status" role="status">{badge(state, busy, live)}</span>
    </div>

    <div className="player-frame">
      {recording
        ? <video src={recording} controls playsInline data-testid="jam-director-recording" />
        : <p className="player-placeholder">{placeholder(state, live, canDrive)}</p>}
    </div>

    <p className="form-note" aria-live="polite">{statusLine(state, live, canDrive)}</p>

    <div className="hero-actions">
      <button
        className="button button-primary"
        onClick={() => void start()}
        disabled={!canDrive || busy || live}
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

    <DirectionLog entries={audit} />

    <p className="form-note">
      Every direction goes through this server, which holds the stream and records
      it. The stream bills by the second with a one-minute minimum, so stop it when
      you are done.{durable ? "" : " This server has no recording storage configured, so the recording is lost when it restarts."}
    </p>

    {failure && <Notice>{failure}</Notice>}
    {state.error && <Notice>{state.error}</Notice>}
  </div>;
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

function badge(state: DirectorState, busy: boolean, live: boolean): string {
  if (busy && !live) return "STARTING";
  if (!live) return state.status === "failed" ? "FAILED" : "IDLE";
  if (state.status === "streaming") return "LIVE";
  if (state.status === "failed") return "FAILED";
  return "WARMING UP";
}

function placeholder(state: DirectorState, live: boolean, canDrive: boolean): string {
  if (state.status === "failed") return "The stream stopped.";
  if (live) return "The stream is running on the server. Its recording appears when you stop.";
  if (!canDrive) return "The host starts the live stream.";
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
