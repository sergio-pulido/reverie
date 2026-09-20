import type { TimelineBeat } from "../core/directorTimeline";
import { formatClock } from "../core/clock";
import { BEAT_STATE_LABEL } from "./beatLabels";

export const TIMELINE_ROW = "timeline";

type TimelineProps = {
  beats: readonly TimelineBeat[];
  runtimeSeconds: number;
  /** The beat the pointer or focus is resting on, anywhere on the screen. */
  highlighted: number | null;
  /** The beat a direction is aimed at, or null for "wherever the stream is". */
  selected: number | null;
  onHighlight: (beatIndex: number | null) => void;
  onSelect: (beatIndex: number | null) => void;
  cellProps: (row: string, index: number) => Record<string, unknown>;
  /** Shown when the room has no script on this server. */
  emptyReason: string | null;
};

/**
 * The film's beats, in order, each one telling you what it is doing.
 *
 * It has to read the same at three beats and at twenty-four, so the row is one
 * horizontal run with a fixed beat width rather than a grid that divides the
 * width between however many there are: twenty-four beats scroll, they do not
 * shrink to slivers.
 *
 * No beat carries a still. Nothing in this build produces one — the stream is
 * forwarded and recorded whole, never sampled per beat — so the frame holds
 * the beat's own phrase and the zone says why, instead of a grey rectangle
 * implying an image that failed to load.
 */
export function Timeline({
  beats,
  runtimeSeconds,
  highlighted,
  selected,
  onHighlight,
  onSelect,
  cellProps,
  emptyReason,
}: TimelineProps) {
  return (
    <section className="director-timeline" aria-label="The film's beats">
      <div className="director-zone-head">
        <div>
          <p className="eyebrow">TIMELINE</p>
          <h2>
            {beats.length} beat{beats.length === 1 ? "" : "s"} · {formatClock(runtimeSeconds)}
          </h2>
        </div>
        <p className="director-zone-note">
          No beat has a still: this build records the stream whole and never samples it per beat.
        </p>
      </div>

      {beats.length === 0 ? (
        <p className="director-empty-line">
          {emptyReason ?? "This film has no beats yet."}
        </p>
      ) : (
        <ol className="director-beats" data-track="">
          {beats.map((beat, index) => (
            <li key={beat.portionIndex}>
              <button
                type="button"
                className="director-beat"
                data-state={beat.state}
                data-beat={beat.portionIndex}
                data-linked={highlighted === beat.portionIndex ? "" : undefined}
                aria-pressed={selected === beat.portionIndex}
                onMouseEnter={() => onHighlight(beat.portionIndex)}
                onMouseLeave={() => onHighlight(null)}
                onFocus={() => onHighlight(beat.portionIndex)}
                onBlur={() => onHighlight(null)}
                onClick={() =>
                  onSelect(selected === beat.portionIndex ? null : beat.portionIndex)
                }
                {...cellProps(TIMELINE_ROW, index)}
              >
                <span className="director-beat-top">
                  <span className="director-beat-number">{beat.number}</span>
                  <span className="director-beat-time">{formatClock(beat.startSeconds)}</span>
                </span>
                <span className="director-beat-frame">
                  {beat.summary ? (
                    <span className="director-beat-phrase">{beat.summary}</span>
                  ) : (
                    <span className="director-beat-unnamed">No phrase</span>
                  )}
                </span>
                <span className="director-beat-foot">
                  <span className="director-beat-duration">{beat.durationSeconds}s</span>
                  <span className="director-beat-state">{BEAT_STATE_LABEL[beat.state]}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
