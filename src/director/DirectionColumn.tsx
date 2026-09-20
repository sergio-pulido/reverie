import type { BeatState, DirectionTurn, TimelineBeat } from "../core/directorTimeline";
import { BEAT_STATE_LABEL } from "./beatLabels";

const OUTCOME_LABEL = {
  applied: "applied",
  rejected: "refused",
  pending: "pending",
} as const;

type DirectionColumnProps = {
  turns: readonly DirectionTurn[];
  beats: readonly TimelineBeat[];
  highlighted: number | null;
  onHighlight: (beatIndex: number | null) => void;
  /** Aims the composer at this beat, the same act as choosing it on the timeline. */
  onSelect: (beatIndex: number | null) => void;
  live: boolean;
};

/**
 * The turns: what was asked for, and what became of it.
 *
 * This is the idea the screen rests on. A turn is not a chat line — it names a
 * beat, and that beat wears the same treatment here as it does on the
 * timeline, so a glance down this column tells you which parts of the film
 * are still yours to change. Resting on either end lights the other.
 *
 * A turn's beat is the one it named, or the one that was playing when it was
 * sent. Where the trail records neither, the tag says so rather than guessing
 * the opening beat.
 */
export function DirectionColumn({
  turns,
  beats,
  highlighted,
  onHighlight,
  onSelect,
  live,
}: DirectionColumnProps) {
  return (
    <section className="director-directions" aria-label="Directions">
      <div className="director-zone-head">
        <div>
          <p className="eyebrow">DIRECTION</p>
          <h2>
            {turns.length} turn{turns.length === 1 ? "" : "s"}
          </h2>
        </div>
      </div>

      {turns.length === 0 ? (
        <p className="director-empty-line">
          {live
            ? "Nothing has been asked for yet. The next thing you say lands on the beat after the one being generated."
            : "No direction has been sent. Play the stream, then tell it what to do."}
        </p>
      ) : (
        <ol className="director-turns">
          {turns
            .slice()
            .reverse()
            .map((turn) => {
              const beat = turn.beatIndex === null ? null : beats[turn.beatIndex] ?? null;
              const linked = turn.beatIndex !== null && turn.beatIndex === highlighted;
              return (
                <li key={turn.promptVersion}>
                  <article
                    className="director-turn"
                    data-linked={linked ? "" : undefined}
                    data-outcome={turn.outcome}
                    onMouseEnter={() => onHighlight(turn.beatIndex)}
                    onMouseLeave={() => onHighlight(null)}
                  >
                    <p className="director-turn-body">{turn.body}</p>
                    <p className="director-turn-meta">
                      <BeatTag
                        beat={beat}
                        number={turn.beatIndex === null ? null : turn.beatIndex + 1}
                        onSelect={onSelect}
                        onHighlight={onHighlight}
                      />
                      <span className="director-turn-outcome">{OUTCOME_LABEL[turn.outcome]}</span>
                    </p>
                  </article>
                </li>
              );
            })}
        </ol>
      )}
    </section>
  );
}

/**
 * The beat a turn is about, wearing that beat's own state.
 *
 * A tag whose beat is not in the film (a script edited under a running
 * session) is drawn as written rather than dropped: the turn was still sent,
 * and silently losing it would make the column a worse record than the trail.
 */
function BeatTag({
  beat,
  number,
  onSelect,
  onHighlight,
}: {
  beat: TimelineBeat | null;
  number: number | null;
  onSelect: (beatIndex: number | null) => void;
  onHighlight: (beatIndex: number | null) => void;
}) {
  if (number === null) {
    return (
      <span className="director-tag director-tag-none" title="The trail records no beat for this turn">
        No beat
      </span>
    );
  }
  const state: BeatState = beat?.state ?? "written";
  return (
    <button
      type="button"
      className="director-tag"
      data-state={state}
      data-beat={number - 1}
      onClick={() => onSelect(number - 1)}
      onFocus={() => onHighlight(number - 1)}
      onBlur={() => onHighlight(null)}
    >
      Beat {number}
      <span className="sr-only"> · {BEAT_STATE_LABEL[state].toLowerCase()}</span>
    </button>
  );
}
