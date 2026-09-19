import { useEffect, useRef } from "react";
import { Notice } from "../chrome";
import { describeConfiguration } from "../core/portionPlayback";
import type { SessionSettings } from "../core/session";
import { usePortionPlayback, type PortionPlayerState } from "./usePortionPlayback";

type JamPlayerProps = {
  jamId: string;
  /** Per `docs/API_CONTRACTS.md` only the host starts and advances the film. */
  canDrive: boolean;
  configuration: SessionSettings | null;
};

/**
 * Reproduces a jam one generated portion at a time.
 *
 * First iteration: play and stop, nothing else. There is no seeking, because
 * the room's cursor only moves forward — the server locks the next portion and
 * generates it while the current one plays, and a clip that does not exist yet
 * cannot be scrubbed to.
 */
export function JamPlayer({ jamId, canDrive, configuration }: JamPlayerProps) {
  const { state, actions } = usePortionPlayback(jamId, {
    enabled: true,
    canDrive,
    configuration,
  });
  const video = useRef<HTMLVideoElement | null>(null);

  // The element follows the room's cursor: a new portion becomes the source and
  // continues straight on while the viewer is watching.
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (state.watching && state.src) {
      void element.play().catch(() => {
        /* the browser refused to start on its own; the play button still works */
      });
    } else {
      element.pause();
    }
  }, [state.watching, state.src]);

  return <div className="player-card" aria-label="Jam video">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">THE FILM</p>
        <h2>{state.finished ? "That's the whole film." : "Watch it come together."}</h2>
      </div>
      <span className="playback-status" role="status">{statusBadge(state)}</span>
    </div>

    <div className="player-frame">
      {state.src
        ? <video
            ref={video}
            src={state.src}
            onEnded={actions.portionEnded}
            playsInline
            preload="auto"
            data-testid="jam-player-video"
          />
        : <p className="player-placeholder">{placeholder(state, canDrive)}</p>}
    </div>

    <p className="form-note" aria-live="polite">{statusLine(state, canDrive)}</p>
    <PortionStrip state={state} />

    <div className="hero-actions">
      <button
        className="button button-primary"
        onClick={actions.play}
        disabled={state.busy || state.watching || state.finished || state.disabled !== null || (!canDrive && !state.src)}
      >
        {state.watching ? "Playing…" : "Play"} <span>▶</span>
      </button>
      <button className="button button-quiet" onClick={actions.stop} disabled={!state.watching}>Stop</button>
    </div>

    <p className="form-note">
      Your playback: {describeConfiguration(state.configuration)}. Everyone in this room
      shares one generated stream today — per-configuration streams are specified but not
      built yet.
    </p>

    {state.disabled && <Notice>{state.disabled}</Notice>}
    {state.error && <Notice>{state.error}</Notice>}
  </div>;
}

function statusBadge(state: PortionPlayerState): string {
  if (state.disabled) return "UNAVAILABLE";
  if (state.finished) return "FINISHED";
  if (state.watching) return "PLAYING";
  if (state.generatingIndex !== null) return "GENERATING";
  return "READY";
}

function placeholder(state: PortionPlayerState, canDrive: boolean): string {
  if (state.disabled) return "This server cannot generate video.";
  if (state.generatingIndex !== null) return "The first portion is being generated…";
  if (!canDrive) return "The host starts the film.";
  return "Nothing has been generated yet.";
}

function statusLine(state: PortionPlayerState, canDrive: boolean): string {
  if (!state.snapshot) return "Reading this jam's playback…";
  const count = state.portionCount;
  if (state.finished) return `All ${count} portions have played.`;
  if (state.generatingIndex !== null) {
    return `Generating portion ${state.generatingIndex + 1} of ${count}. The film continues by itself when it is ready.`;
  }
  if (state.portionIndex !== null) {
    return state.watching
      ? `Portion ${state.portionIndex + 1} of ${count}.`
      : `Stopped on portion ${state.portionIndex + 1} of ${count}.`;
  }
  return canDrive
    ? `Press play: the first of ${count} portions is generated, then the next one while it plays.`
    : `${count} portions are waiting for the host to start.`;
}

/** Every portion and what the server has for it, so a viewer can see the
 * generation running one portion ahead. */
function PortionStrip({ state }: { state: PortionPlayerState }) {
  if (!state.snapshot) return null;
  return <ol className="portion-strip" aria-label="Portions">
    {state.snapshot.portions.map((portion) => {
      const played = state.portionIndex !== null && portion.portionIndex < state.portionIndex;
      const current = portion.portionIndex === state.portionIndex;
      return <li
        key={portion.portionIndex}
        className={`portion-pip portion-${portion.media}${current ? " current" : ""}${played ? " played" : ""}`}
        title={`Portion ${portion.portionIndex + 1} · ${portion.durationSeconds}s · ${portion.media}`}
      ><span className="sr-only">Portion {portion.portionIndex + 1}: {portion.media}</span></li>;
    })}
  </ol>;
}
