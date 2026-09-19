import type { MouseEvent, RefObject } from "react";
import { activeRefinements, type ActiveRefinement } from "../catalogue/refinements";
import type { PreferenceState } from "../preferences/schema";

export const STRIP_ROW = "strip";

type NarrowingStripProps = {
  state: PreferenceState;
  /** How many films match everything in effect, when known. */
  count: number | null;
  notice: string | null;
  filtersRef: RefObject<HTMLButtonElement | null>;
  cellProps: (row: string, index: number) => { "data-row": string; "data-index": number; tabIndex: number };
  onOpenFilters: () => void;
  onWithdraw: (item: ActiveRefinement) => void;
  onRestore: () => void;
  onReset: () => void;
};

/**
 * What is narrowing the results, each item removable, beside the control that opens the filter
 * panel and "Start over". The conversation and the filters narrow the same state, so a genre the
 * assistant heard and one chosen in the panel both show here and both come off the same way.
 */
export function NarrowingStrip({ state, count, notice, filtersRef, cellProps, onOpenFilters, onWithdraw, onRestore, onReset }: NarrowingStripProps) {
  const active = activeRefinements(state);
  const rejected = state.rejectedCandidateIds.length;
  const narrowing = active.length > 0 || rejected > 0;

  /** The pressed chip is about to disappear: focus moves to its neighbour first, so a remote is never left on nothing. */
  function keepFocusNear(event: MouseEvent<HTMLButtonElement>) {
    const chip = event.currentTarget;
    const neighbour = (chip.nextElementSibling ?? chip.previousElementSibling) as HTMLElement | null;
    neighbour?.focus({ preventScroll: true });
  }

  let index = 0;
  const cell = () => cellProps(STRIP_ROW, index++);

  return (
    <div className="search-strip-wrap">
      <div className="search-strip" role="group" aria-label="What is narrowing the results">
        <button ref={filtersRef} type="button" className="search-chip search-chip-filters" aria-haspopup="dialog" {...cell()} onClick={onOpenFilters}>
          <FiltersIcon />
          Filters
        </button>
        <span className="search-strip-label" aria-live="polite">
          {!narrowing ? "No filters yet" : count === null ? "Narrowing…" : `${count.toLocaleString("en")} ${count === 1 ? "film matches" : "films match"}`}
        </span>
        {active.map((item) => (
          <button
            key={item.key}
            type="button"
            className="search-chip search-chip-active"
            aria-label={`Remove ${item.label}`}
            {...cell()}
            onClick={(event) => {
              keepFocusNear(event);
              onWithdraw(item);
            }}
          >
            {item.label} <span aria-hidden="true">×</span>
          </button>
        ))}
        {rejected > 0 && (
          <button
            type="button"
            className="search-chip search-chip-active"
            aria-label={`Bring back ${rejected} turned-down ${rejected === 1 ? "film" : "films"}`}
            {...cell()}
            onClick={(event) => {
              keepFocusNear(event);
              onRestore();
            }}
          >
            {rejected} turned down <span aria-hidden="true">×</span>
          </button>
        )}
        <button type="button" className="search-chip search-chip-reset" {...cell()} onClick={onReset}>
          Start over
        </button>
      </div>
      {notice && (
        <p className="search-strip-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

/** Three sliders, drawn for Reverie. */
function FiltersIcon() {
  return (
    <svg className="search-chip-icon" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
      <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="9" cy="6" r="2.4" fill="currentColor" />
      <circle cx="15" cy="12" r="2.4" fill="currentColor" />
      <circle cx="7" cy="18" r="2.4" fill="currentColor" />
    </svg>
  );
}

/** How many cells the strip holds, for the remote navigation's rows. */
export function stripCells(state: PreferenceState): number {
  return 2 + activeRefinements(state).length + (state.rejectedCandidateIds.length > 0 ? 1 : 0);
}
