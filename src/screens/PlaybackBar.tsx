import { Notice } from "../chrome";
import type { PlaybackClockState } from "./usePlaybackClock";

type PlaybackBarProps = {
  state: PlaybackClockState;
  isHost: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
};

const STATUS_LABEL: Record<string, string> = {
  idle: "READY",
  playing: "PLAYING",
  paused: "PAUSED",
};

/**
 * The shared position. Everyone in the room reads the same server-anchored clock, so
 * two viewers should show the same counter. Only the host gets the controls; a member
 * sees the position and who is driving it.
 */
export function PlaybackBar({ state, isHost, onStart, onPause, onReset }: PlaybackBarProps) {
  const { clock, position, error, busy } = state;
  const status = clock?.status ?? "idle";
  const playing = status === "playing";

  return <div className="playback-card" aria-label="Shared playback">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">SHARED PLAYBACK</p>
        <h2>The room's position</h2>
      </div>
      <span className={`playback-status playback-${status}`} role="status">{STATUS_LABEL[status] ?? "READY"}</span>
    </div>

    <p className="playback-clock" aria-live="off" data-testid="playback-clock">{position.clock}</p>
    <p className="form-note">
      {isHost
        ? "Press play and every participant in this room follows the same starting point."
        : "The host drives this clock. Everyone in the room sees the same position."}
    </p>

    {isHost && <div className="hero-actions">
      <button className="button button-primary" onClick={onStart} disabled={busy || playing}>
        {playing ? "Playing…" : "Play for everyone"} <span>▶</span>
      </button>
      <button className="button button-quiet" onClick={onPause} disabled={busy || !playing}>Pause</button>
      <button className="button button-quiet" onClick={onReset} disabled={busy || status === "idle"}>Reset</button>
    </div>}

    {error && <Notice>{error}</Notice>}
  </div>;
}
