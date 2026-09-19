import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "../chrome";
import {
  initialDirectorState,
  type DirectorState,
} from "../core/directorProtocol";
import {
  DirectorSessionError,
  openDirectorSession,
  type DirectorSessionHandle,
} from "../lib/directorSession";

type JamDirectorProps = {
  jamId: string;
  /** Only the host opens a stream: it bills by the second. */
  canDrive: boolean;
};

/**
 * The live director: one continuous MiniMax H3 Max stream that can be
 * re-directed while it plays.
 *
 * This is not the portion player. Nothing here is stored — the stream is a
 * WebRTC media track, so when it ends there is no clip to keep. The two live
 * side by side on purpose: the player is the durable film, this is the live
 * room.
 */
export function JamDirector({ jamId, canDrive }: JamDirectorProps) {
  const [state, setState] = useState<DirectorState>(initialDirectorState);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [direction, setDirection] = useState("");
  const video = useRef<HTMLVideoElement | null>(null);
  const session = useRef<DirectorSessionHandle | null>(null);

  // A stream left open keeps billing, so it is torn down when this unmounts.
  useEffect(() => () => void session.current?.stop(), []);

  const start = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      session.current = await openDirectorSession({
        jamId,
        onState: setState,
        onStream: (stream) => {
          if (video.current) video.current.srcObject = stream;
        },
      });
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
    await session.current?.stop();
    session.current = null;
  }, []);

  const send = useCallback(() => {
    const prompt = direction.trim();
    if (!prompt) return;
    if (session.current?.direct(prompt)) setDirection("");
  }, [direction]);

  const live = state.status === "streaming" || state.status === "configuring";

  return <div className="player-card" aria-label="Live director">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">LIVE DIRECTOR</p>
        <h2>Direct it while it runs.</h2>
      </div>
      <span className="playback-status" role="status">{badge(state, busy)}</span>
    </div>

    <div className="player-frame">
      <video
        ref={video}
        autoPlay
        playsInline
        hidden={!live}
        data-testid="jam-director-video"
      />
      {!live && <p className="player-placeholder">{placeholder(state, canDrive)}</p>}
    </div>

    <p className="form-note" aria-live="polite">{statusLine(state, canDrive)}</p>

    <div className="hero-actions">
      <button
        className="button button-primary"
        onClick={() => void start()}
        disabled={!canDrive || busy || live}
      >
        {busy ? "Starting…" : "Start the stream"} <span>▶</span>
      </button>
      <button className="button button-quiet" onClick={() => void stop()} disabled={!live}>
        Stop
      </button>
    </div>

    <label className="field">
      <span>New direction</span>
      <input
        value={direction}
        onChange={(event) => setDirection(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") send();
        }}
        placeholder="Cut to the lighthouse at dusk."
        disabled={state.status !== "streaming"}
        maxLength={2000}
      />
    </label>
    <div className="hero-actions">
      <button
        className="button button-quiet"
        onClick={send}
        disabled={state.status !== "streaming" || !direction.trim()}
      >
        Direct
      </button>
    </div>

    <p className="form-note">
      This stream is live only: it bills by the second with a one-minute minimum,
      and nothing it generates is stored. Stop it when you are done.
    </p>

    {failure && <Notice>{failure}</Notice>}
    {state.error && <Notice>{state.error}</Notice>}
  </div>;
}

function badge(state: DirectorState, busy: boolean): string {
  if (busy) return "STARTING";
  switch (state.status) {
    case "streaming":
      return "LIVE";
    case "configuring":
      return "WARMING UP";
    case "failed":
      return "FAILED";
    case "ended":
      return "ENDED";
    default:
      return "IDLE";
  }
}

function placeholder(state: DirectorState, canDrive: boolean): string {
  if (state.status === "failed") return "The stream stopped.";
  if (state.status === "ended") return "The stream has ended.";
  if (state.status === "configuring") return "The first seconds are being generated…";
  if (!canDrive) return "The host starts the live stream.";
  return "Nothing is streaming yet.";
}

function statusLine(state: DirectorState, canDrive: boolean): string {
  if (state.status === "ended") {
    return state.endedReason === "session_limit"
      ? "The stream reached this server's session limit."
      : "The stream was stopped.";
  }
  if (state.status === "streaming") {
    const seconds = Math.round(state.generatedSeconds);
    return `Live: ${seconds}s generated across ${state.chunksReceived} chunk(s). Direction ${state.appliedPromptVersion} is playing.`;
  }
  if (state.status === "configuring") {
    return "Connected. The opening of the script is being generated.";
  }
  return canDrive
    ? "Starting a stream opens a paid session that bills for at least a minute."
    : "Only the host can open the live stream.";
}
