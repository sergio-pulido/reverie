import { useEffect, useMemo } from "react";
import type { CatalogueTitle } from "../catalogue/contract";
import { FILTER_GROUPS, isApplied, type Refinement } from "../catalogue/refinements";
import type { ShownShortlist } from "../discover/rankedShortlist";
import type { PreferenceState } from "../preferences/schema";
import { dialogKey } from "./dialog";
import type { CardHover } from "./ResultCard";
import { ResultRow } from "./ResultRow";
import { snapshotOf } from "./results";
import { useRows, type Row } from "../shell/useRows";

type FilterPanelProps = {
  state: PreferenceState;
  /** Something is narrowing the results, so there are films to show. */
  refined: boolean;
  /** The shortlist for the state as it is now, ordered by the scorer; null while it is read. */
  live: { shown: ShownShortlist; total: number } | null;
  failure: string | null;
  notice: string | null;
  attribution: string;
  onChoose: (filter: Refinement) => void;
  onUnchoose: (filter: Refinement) => void;
  onClose: () => void;
  onOpen: (title: CatalogueTitle, card: HTMLElement) => void;
  hover: CardHover;
};

const RESULTS_ROW = "filter-results";
const DONE_ROW = "filter-done";
const groupRow = (id: string) => `filter-${id}`;

/**
 * Filters for the viewer who already knows: genre, era and running time, over the same state the
 * conversation narrows, so a spoken "something funny" and a chosen era compose. It is its own
 * surface, never part of the conversation: choosing a filter says nothing in the transcript and
 * rewrites no turn's films. What the filters match shows here, live, ordered by genre match.
 *
 * Rows go down the panel and chips along each row, as everywhere else. Back or Done closes it and
 * returns focus to the control that opened it.
 */
export function FilterPanel({ state, refined, live, failure, notice, attribution, onChoose, onUnchoose, onClose, onOpen, hover }: FilterPanelProps) {
  const results = useMemo(() => (live ? snapshotOf(live.shown, live.total) : null), [live]);
  const rows = useMemo<Row[]>(
    () => [
      ...FILTER_GROUPS.map(({ id, filters }) => ({ key: groupRow(id), count: filters.length })),
      ...(results && results.titles.length > 0 ? [{ key: RESULTS_ROW, count: results.titles.length }] : []),
      { key: DONE_ROW, count: 1 },
    ],
    [results],
  );
  const { containerRef, cellProps, onKeyDown, onFocus, focusCell } = useRows(rows);

  useEffect(() => {
    focusCell(groupRow(FILTER_GROUPS[0].id), 0);
  }, [focusCell]);

  const count = !refined || failure ? null : live ? `${live.total.toLocaleString("en")} ${live.total === 1 ? "film matches" : "films match"}` : "Counting…";

  return (
    <div className="search-overlay search-overlay-panel" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        ref={containerRef}
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-panel-title"
        onFocus={onFocus}
        onKeyDown={(event) => {
          if (dialogKey(event, onClose)) return;
          if (event.key === "Enter" && !event.defaultPrevented && event.target instanceof HTMLButtonElement) {
            // OK chooses once, here, rather than relying on the browser's own activation.
            event.preventDefault();
            event.target.click();
            return;
          }
          onKeyDown(event);
        }}
      >
        <header className="search-panel-head">
          <h2 id="search-panel-title">Filters</h2>
          {count && (
            <p className="search-panel-count" aria-live="polite">
              {count}
            </p>
          )}
        </header>

        {FILTER_GROUPS.map((group) => (
          <div key={group.id} className="search-panel-group" role="group" aria-labelledby={`search-panel-${group.id}`}>
            <h3 id={`search-panel-${group.id}`}>{group.label}</h3>
            <div className="search-track search-panel-chips" data-track="">
              {group.filters.map((filter, index) => {
                const applied = isApplied(filter, state);
                return (
                  <button
                    key={filter.id}
                    type="button"
                    className="search-chip"
                    aria-pressed={applied}
                    {...cellProps(groupRow(group.id), index)}
                    onClick={() => (applied ? onUnchoose(filter) : onChoose(filter))}
                  >
                    {filter.sentence}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {notice && (
          <p className="search-panel-notice" role="status">
            {notice}
          </p>
        )}
        {failure && (
          <p className="search-panel-notice" role="alert">
            Films could not be loaded. {failure}
          </p>
        )}
        {results && <ResultRow rowKey={RESULTS_ROW} results={results} label="Films matching these filters" cellProps={cellProps} onOpen={onOpen} hover={hover} />}
        {!refined && <p className="search-panel-empty">Choose a genre, an era or a running time.</p>}

        <div className="search-panel-actions">
          <button type="button" className="tv-action tv-action-primary" {...cellProps(DONE_ROW, 0)} onClick={onClose}>
            Done
          </button>
        </div>
        {results && results.titles.length > 0 && (
          <p className="search-preview-attribution">
            <span className="discover-attribution-mark" aria-hidden="true">TMDB</span>
            {attribution}
          </p>
        )}
      </section>
    </div>
  );
}
