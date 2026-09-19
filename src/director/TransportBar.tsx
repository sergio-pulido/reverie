import type { CSSProperties } from "react";
import { formatClock } from "../core/clock";
import type { TimelineBeat } from "../core/directorTimeline";
import type { PlaybackClock } from "./usePlaybackClock";

export const TRANSPORT_ROW = "transport";

type TransportBarProps = {
  clock: PlaybackClock;
  beats: readonly TimelineBeat[];
  runtimeSeconds: number;
  /** Only the host may drive the room's clock; the database enforces it too. */
  canDrive: boolean;
  cellProps: (row: string, index: number) => Record<string, unknown>;
};

/**
 * The room's clock under the frame, with a tick where each beat begins.
 *
 * It is the shared playback clock, not this video element's currentTime: the
 * position is the room's, derived from the database's anchor, so two screens
 * on one room read the same number. The ticks come from the script's own
 * cumulative offsets, which is why they line up with the timeline above.
 */
export function TransportBar({
  clock,
  beats,
  runtimeSeconds,
  canDrive,
  cellProps,
}: TransportBarProps) {
  const playing = clock.reading?.status === "playing";
  const fraction = runtimeSeconds > 0 ? Math.min(1, clock.playhead / runtimeSeconds) : 0;

  if (!clock.available) {
    return (
      <p className="director-transport-absent" role="status">
        {clock.error ?? "Reading the room's playback clock…"}
      </p>
    );
  }

  return (
    <div className="director-transport" aria-label="Playback">
      <div className="director-transport-controls">
        <button
          type="button"
          className="director-transport-button"
          onClick={() => (playing ? clock.pause() : clock.start())}
          disabled={!canDrive}
          {...cellProps(TRANSPORT_ROW, 0)}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          className="director-transport-button director-transport-quiet"
          onClick={clock.reset}
          disabled={!canDrive}
          {...cellProps(TRANSPORT_ROW, 1)}
        >
          Reset
        </button>
      </div>

      <div
        className="director-track"
        style={{ "--playhead": fraction.toFixed(4) } as CSSProperties}
        aria-hidden="true"
      >
        {/* A tick where each beat begins, so the bar and the timeline agree. */}
        {beats.map((beat) => (
          <span
            key={beat.portionIndex}
            className="director-tick"
            data-state={beat.state}
            style={
              {
                "--at": runtimeSeconds > 0 ? (beat.startSeconds / runtimeSeconds).toFixed(4) : "0",
              } as CSSProperties
            }
          />
        ))}
        <span className="director-playhead" />
      </div>

      <p className="director-transport-clock" role="status">
        {formatClock(clock.playhead)} / {formatClock(runtimeSeconds)}
        <span className="director-transport-state"> · {clock.reading?.status ?? "idle"}</span>
      </p>
      {!canDrive && (
        <p className="director-zone-note">Only the host of this jam can move the room's clock.</p>
      )}
      {clock.error && <p className="director-zone-note">{clock.error}</p>}
    </div>
  );
}
