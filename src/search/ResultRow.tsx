import type { CatalogueTitle } from "../catalogue/contract";
import type { Critique } from "../conversation/contract";
import type { ResultSet } from "../conversation/transcript";
import { ResultCard, type CardHover } from "./ResultCard";
import { captionOf } from "./results";

type ResultRowProps = {
  rowKey: string;
  results: ResultSet;
  /** What the row is, for a screen reader: "Films for “a thriller”". */
  label: string;
  cellProps: (row: string, index: number) => { "data-row": string; "data-index": number; tabIndex: number };
  onOpen: (title: CatalogueTitle, card: HTMLElement, critique: Critique | null) => void;
  hover: CardHover;
};

/**
 * A turn's films, in the order they were shown then, with a line saying whose order it is. It
 * runs to the right edge and scrolls sideways; a remote walks it with Left and Right.
 */
export function ResultRow({ rowKey, results, label, cellProps, onOpen, hover }: ResultRowProps) {
  if (results.titles.length === 0) {
    return <p className="search-results-empty">Nothing fits all of that. Remove something below to widen it.</p>;
  }
  const picks = new Set(results.pickIds);
  return (
    <div className="search-results">
      <p className="search-results-caption">
        {captionOf(results)}
        {results.note && <span className="search-results-note"> — {results.note}</span>}
      </p>
      <ul className="search-track" data-track="" aria-label={label}>
        {results.titles.map((title, index) => (
          <ResultCard
            key={title.id}
            title={title}
            pick={picks.has(title.id)}
            reason={results.reasons[title.id] ?? null}
            critique={results.critiques[title.id] ?? null}
            navigation={cellProps(rowKey, index)}
            onOpen={onOpen}
            hover={hover}
          />
        ))}
      </ul>
    </div>
  );
}

/** The shape of a row still being read or ranked, so the films arriving never move the page. */
export function ResultRowWaiting() {
  return (
    <div className="search-results search-results-waiting" aria-busy="true">
      <p className="search-results-caption">Finding films…</p>
      <ul className="search-track" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <li key={index} className="search-card-slot">
            <span className="search-card search-card-ghost">
              <span className="search-card-poster" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
