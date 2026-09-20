import type { ReactNode } from "react";
import { formatClock } from "../core/clock";
import type { DirectorState } from "../core/directorProtocol";
import type { TimelineBeat } from "../core/directorTimeline";
import type { DirectorSession } from "./useDirectorSession";

export const STAGE_ROW = "stage";

/** Which of the three the stage is showing. */
export type StagePhase = "empty" | "generating" | "still";

export function stagePhaseOf(session: DirectorSession): StagePhase {
  if (session.live) return "generating";
  return session.recording ? "still" : "empty";
}

type StageProps = {
  session: DirectorSession;
  beats: readonly TimelineBeat[];
  /** The beat the stream is on, when it is on one. */
  currentBeat: TimelineBeat | null;
  /** Blocking reason, when a session cannot be opened at all. */
  cannotStart: string | null;
  cellProps: (row: string, index: number) => Record<string, unknown>;
  /** The transport bar, drawn under a finished frame. */
  transport: ReactNode;
};

/**
 * The frame, in its three states.
 *
 * Empty asks for the first shot rather than apologising for not having one.
 * Generating is the live stream with its progress and the beat it is on.
 * Still is the finished session held as a frame with the room's clock under it.
 */
export function Stage({
  session,
  beats,
  currentBeat,
  cannotStart,
  cellProps,
  transport,
}: StageProps) {
  const phase = stagePhaseOf(session);

  return (
    <section className="director-stage" aria-label="The stage" data-phase={phase}>
      <div className="director-frame">
        {/* One element across states: remounting it would drop the live track. */}
        <video
          ref={session.videoRef}
          autoPlay
          playsInline
          muted
          hidden={phase !== "generating"}
          data-testid="director-live"
        />
        {phase === "still" && session.recording && (
          <video
            src={session.recording}
            controls
            playsInline
            data-testid="director-recording"
          />
        )}
        {phase === "empty" && (
          <div className="director-frame-empty">
            <p className="eyebrow">NOTHING IS MADE YET</p>
            <h2>What is the first shot?</h2>
            <p>
              Say it or type it below, and the stream opens on it. Every second of it is billed,
              so it starts when you ask and stops when you say so.
            </p>
          </div>
        )}
      </div>

      <div className="director-stage-foot">
        {phase === "generating" ? (
          <Progress state={session.state} currentBeat={currentBeat} total={beats.length} />
        ) : (
          <p className="director-stage-line" role="status">
            {phase === "still"
              ? "This is the session that just ran, exactly as it was generated."
              : cannotStart ?? "Nothing is streaming."}
          </p>
        )}

        <div className="director-stage-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => void session.start()}
            disabled={session.busy || session.live || cannotStart !== null}
            {...cellProps(STAGE_ROW, 0)}
          >
            {session.busy && !session.live ? "Starting…" : session.live ? "Playing" : "Play"} <span>▶</span>
          </button>
          <button
            type="button"
            className="button button-quiet"
            onClick={() => void session.stop()}
            disabled={!session.live || session.busy}
            {...cellProps(STAGE_ROW, 1)}
          >
            Stop
          </button>
        </div>
      </div>

      {phase === "still" && transport}

      {session.attached && (
        <p className="director-zone-note">
          You joined a stream this jam already had open, rather than paying for a second copy of it.
        </p>
      )}
    </section>
  );
}

/** What the stream has produced, and where it has got to. */
function Progress({
  state,
  currentBeat,
  total,
}: {
  state: DirectorState;
  currentBeat: TimelineBeat | null;
  total: number;
}) {
  return (
    <p className="director-stage-line" role="status">
      <span className="director-live-dot" aria-hidden="true" />
      {state.status === "streaming"
        ? `${formatClock(state.generatedSeconds)} generated across ${state.chunksReceived} chunk${state.chunksReceived === 1 ? "" : "s"}.`
        : "Connected. The opening of the script is being generated."}{" "}
      {currentBeat
        ? `Beat ${currentBeat.number} of ${total} is on screen.`
        : "No beat is on screen yet."}
    </p>
  );
}
