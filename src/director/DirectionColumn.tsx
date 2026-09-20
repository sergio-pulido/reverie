import type { OutlineEditRecord } from "../core/outlineEdit";
import type { BeatState, DirectionTurn, TimelineBeat } from "../core/directorTimeline";
import { BEAT_STATE_LABEL } from "./beatLabels";

const OUTCOME_LABEL = {
  applied: "applied",
  rejected: "refused",
  pending: "pending",
} as const;

/** What the queue is doing with one ask, in the room's words rather than the queue's. */
const ASK_LABEL: Readonly<Record<OutlineEditRecord["status"], string>> = {
  queued: "waiting",
  processing: "rewriting",
  landed: "landed",
  failed: "refused",
};

type DirectionColumnProps = {
  /** What the room asked for, newest first: the story queue's own ledger. */
  asks: readonly OutlineEditRecord[];
  turns: readonly DirectionTurn[];
  beats: readonly TimelineBeat[];
  highlighted: number | null;
  onHighlight: (beatIndex: number | null) => void;
  /** Aims the composer at this beat, the same act as choosing it on the timeline. */
  onSelect: (beatIndex: number | null) => void;
  live: boolean;
};

/**
 * What was asked for, and what became of it.
 *
 * This is the idea the screen rests on. An ask is not a chat line — it names a
 * beat, and that beat wears the same treatment here as it does on the
 * timeline, so a glance down this column tells you which parts of the film
 * are still yours to change. Resting on either end lights the other.
 *
 * Two lists, because they answer two different questions. The asks are what
 * the room wanted and what the story queue did with each one: which beat it
 * was aimed at, and whether the rewrite landed. The turns below are the
 * narrower fact of what reached the provider — only the beat a stream is
 * about to render is ever sent to it — and the provider can refuse one.
 */
export function DirectionColumn({
  asks,
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
            {asks.length} ask{asks.length === 1 ? "" : "s"}
          </h2>
        </div>
      </div>

      {asks.length === 0 ? (
        <p className="director-empty-line">
          {live
            ? "Nothing has been asked for yet. What you say is aimed at the beat it is most about, and every beat after it is rewritten to follow from it."
            : "Nothing has been asked for yet. The stream is stopped, so what you say changes the story the next take will play."}
        </p>
      ) : (
        <ol className="director-turns">
          {asks.map((ask) => {
            const beat = beats[ask.beatIndex] ?? null;
            return (
              <li key={ask.id}>
                <article
                  className="director-turn"
                  data-linked={ask.beatIndex === highlighted ? "" : undefined}
                  data-status={ask.status}
                  onMouseEnter={() => onHighlight(ask.beatIndex)}
                  onMouseLeave={() => onHighlight(null)}
                >
                  {/* What the room said, where the room said something. An edit
                      made by hand has only its phrase, and that is what it
                      asked for. */}
                  <p className="director-turn-body">
                    {ask.said ?? (ask.intent === "set" ? ask.summary : "Asked for something else.")}
                  </p>
                  {ask.said && ask.summary && ask.status === "landed" && (
                    <p className="director-turn-landed">Beat {ask.beatIndex + 1} now reads “{ask.summary}”.</p>
                  )}
                  <p className="director-turn-meta">
                    <BeatTag
                      beat={beat}
                      number={ask.beatIndex + 1}
                      onSelect={onSelect}
                      onHighlight={onHighlight}
                    />
                    <span className="director-turn-outcome">
                      {ASK_LABEL[ask.status]}
                      {ask.status === "landed" && ask.revision ? ` · revision ${ask.revision}` : ""}
                    </span>
                  </p>
                  {/* Why this beat, in the chooser's own words, so an aim that
                      reads as wrong can be judged rather than guessed at. */}
                  {ask.chosenBecause && <p className="director-turn-why">{ask.chosenBecause}</p>}
                  {ask.error && <p className="director-turn-why">{ask.error.safeMessage}</p>}
                </article>
              </li>
            );
          })}
        </ol>
      )}

      {/* What actually reached the provider. A separate question from what was
          asked for: only a beat the stream is about to render is sent to it,
          and the provider can still refuse one. */}
      {turns.length > 0 && (
        <div className="director-sent">
          <p className="eyebrow">REACHED THE STREAM</p>
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
        </div>
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
