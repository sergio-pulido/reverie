import type { CSSProperties } from "react";
import { formatClock } from "../core/clock";
import type { TimelineBeat } from "../core/directorTimeline";
import type { PlaybackClock } from "./usePlaybackClock";

export const TRANSPORT_ROW = "transport";

/**
 * Where the bar's playhead comes from, which is a different question in the
 * two situations the bar appears in.
 *
 * `live` is a running take: the position is the media element's own clock and
 * nobody can scrub it, so the bar is a readout with no controls. It also knows
 * the generation frontier, which sits AHEAD of the playhead — the provider
 * runs ten seconds or so in front of the viewer, and showing that gap is how
 * the lock window stops looking arbitrary.
 *
 * `room` is a finished film: the position is the room's shared clock from the
 * database, and the host can drive it.
 */
export type TransportPosition =
  | { kind: "live"; playheadSeconds: number; frontierSeconds: number | null }
  | { kind: "room"; clock: PlaybackClock };

type TransportBarProps = {
  position: TransportPosition;
  beats: readonly TimelineBeat[];
  runtimeSeconds: number;
  /** Only the host may drive the room's clock; the database enforces it too. */
  canDrive: boolean;
  cellProps: (row: string, index: number) => Record<string, unknown>;
};

/**
 * The clock under the frame, with a tick where each beat begins.
 *
 * The ticks come from the script's own cumulative offsets, which is why they
 * line up with the timeline above.
 */
export function TransportBar({
  position,
  beats,
  runtimeSeconds,
  canDrive,
  cellProps,
}: TransportBarProps) {
  const clock = position.kind === "room" ? position.clock : null;
  if (clock && !clock.available) {
    return (
      <p className="director-transport-absent" role="status">
        {clock.error ?? "Reading the room's playback clock…"}
      </p>
    );
  }

  const playhead =
    position.kind === "live" ? position.playheadSeconds : (clock?.playhead ?? 0);
  const fraction = share(playhead, runtimeSeconds);
  const frontier =
    position.kind === "live" && position.frontierSeconds !== null
      ? share(position.frontierSeconds, runtimeSeconds)
      : null;
  const playing = clock?.reading?.status === "playing";

  return (
    <div className="director-transport" aria-label="Playback">
      {clock && (
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
      )}

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
            style={{ "--at": share(beat.startSeconds, runtimeSeconds).toFixed(4) } as CSSProperties}
          />
        ))}
        {/* How far ahead of the viewer the provider has generated. */}
        {frontier !== null && (
          <span
            className="director-frontier"
            style={{ "--at": frontier.toFixed(4) } as CSSProperties}
          />
        )}
        <span className="director-playhead" />
      </div>

      <p className="director-transport-clock" role="status">
        {formatClock(playhead)} / {formatClock(runtimeSeconds)}
        <span className="director-transport-state">
          {position.kind === "live"
            ? position.frontierSeconds === null
              ? " · live, nothing generated yet"
              : ` · live · generated through ${formatClock(position.frontierSeconds)}`
            : ` · ${clock?.reading?.status ?? "idle"}`}
        </span>
      </p>
      {position.kind === "live" && (
        <p className="director-transport-note">
          The take is running. It moves on its own and cannot be scrubbed; Stop ends it.
        </p>
      )}
      {clock && !canDrive && (
        <p className="director-zone-note">Only the host of this jam can move the room's clock.</p>
      )}
      {clock?.error && <p className="director-zone-note">{clock.error}</p>}
    </div>
  );
}

/** A position as a 0..1 share of the runtime, clamped and safe at zero length. */
function share(seconds: number, runtimeSeconds: number): number {
  if (runtimeSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, seconds / runtimeSeconds));
}
