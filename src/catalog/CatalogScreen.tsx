import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogueOk, CatalogueTitle } from "../catalogue/contract";
import { isRefined, toShortlistFilters } from "../catalogue/shortlistFilters";
import { Artwork } from "../discover/Artwork";
import { RANKED_BY, orderShortlist, type RankingStatus, type ShownShortlist } from "../discover/rankedShortlist";
import { TMDB_ATTRIBUTION_FALLBACK, TmdbAttribution } from "../discover/TmdbAttribution";
import { useRefinement } from "../discover/useRefinement";
import { MadeGrid } from "../made/MadeGrid";
import { useMadeInReverie, type MadeFilm } from "../made/madeInReverie";
import { TopBar } from "../shell/TopBar";
import type { Feed, FeedController } from "./pageFeed";
import { RefinementBar } from "./RefinementBar";
import { SourceFilter, type CatalogSource } from "./SourceFilter";
import { useCatalogue, type CatalogueState } from "./useCatalogue";
import { useGridNavigation } from "./useGridNavigation";

type CatalogScreenProps = {
  /** A film page opened from here covers the catalogue, which keeps its place underneath. */
  inert?: boolean;
  onOpenFilm: (title: CatalogueTitle) => void;
  /** Opens a room made here. Its own screen is the room's, not a film page. */
  onOpenMade: (film: MadeFilm) => void;
};

/** How far below the viewport the end of the grid starts loading the next page. */
const END_OF_GRID_MARGIN = "0px 0px 900px 0px";

/** Catalog browses; it never asks a model to rank, so the scorer's order is the only one shown. */
const NOT_RANKED: RankingStatus = { phase: "idle" };

/** Where focus goes when the grid comes back: the poster whose film was opened. */
type ReturnFocus = { id: string; index: number };

/**
 * The catalogue: every film Reverie can read, as a grid of posters that grows as the viewer
 * reaches the end of it, with a title search above it and chips that narrow it.
 *
 * Browsing is all it does. There is no conversation and no voice here — that is Discover's job —
 * and nothing on this screen turns a title down. Choosing a poster opens that film's own page at
 * `/discover/:id` as a layer over this screen, which keeps its scroll, its pages and its focus
 * underneath and takes them back when the page closes.
 *
 * Unrefined, the grid pages through the catalogue in the order the query answers. Once a chip is
 * chosen it reads one shortlist instead, filtered in the database and ordered by the deterministic
 * scorer, and says so above the grid rather than implying a ranking it did not make.
 *
 * The source switch at the top decides which shelf is being browsed: the catalogue Reverie
 * reads, or what has been made here. They are the same kind of thing on the same shelf, which
 * is the product's claim, so made work is a filter over this grid rather than a place of its own.
 * A title search and the chips narrow the catalogue, so they are only shown with it.
 */
export function CatalogScreen({ inert = false, onOpenFilm, onOpenMade }: CatalogScreenProps) {
  const [source, setSource] = useState<CatalogSource>("catalogue");
  // The rooms are read when the viewer asks for them, and not before.
  const made = useMadeInReverie(source === "made" && !inert);
  const [searchInput, setSearchInput] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const refineRef = useRef<HTMLElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<ReturnFocus | null>(null);

  const refinement = useRefinement();
  const refined = isRefined(refinement.state);
  const filters = useMemo(() => (refined ? toShortlistFilters(refinement.state) : null), [refined, refinement.state]);
  const { state, retry, feed, more } = useCatalogue(searchInput, filters);
  const response = shownResponse(state);

  const shown = useMemo<ShownShortlist | null>(
    () => (refined && response ? orderShortlist(response.items, refinement.state, NOT_RANKED, false) : null),
    [refined, response, refinement.state],
  );
  const items = refined ? (shown?.items ?? []) : feed.items;
  const pickIds = shown?.pickIds ?? NO_PICKS;

  const focusSearch = useCallback(() => searchRef.current?.focus(), []);
  const focusSource = useCallback(() => sourceRef.current?.querySelector<HTMLButtonElement>("button")?.focus(), []);
  /** Down from the switch: the catalogue's field, or the first thing the made grid shows. */
  const enterSource = useCallback(() => {
    if (searchRef.current) searchRef.current.focus();
    else document.querySelector<HTMLButtonElement>(".catalog-made-card")?.focus();
  }, []);
  const focusRefine = useCallback((rail: "first" | "last") => {
    const rails = refineRef.current?.querySelectorAll<HTMLElement>("[data-rail]");
    const target = rails && rails.length > 0 ? rails[rail === "first" ? 0 : rails.length - 1] : null;
    target?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  const focusFeedEnd = useCallback(() => {
    endRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  const openFilm = useCallback(
    (index: number) => {
      const title = items[index];
      if (!title) return;
      returnFocus.current = { id: title.id, index };
      onOpenFilm(title);
    },
    [items, onOpenFilm],
  );
  // Back on the grid is not handled here: like Back anywhere, it returns to the top bar.
  const gridHandlers = useMemo(
    () => ({ onActivate: openFilm, onExitTop: () => focusRefine("last"), onExitBottom: focusFeedEnd }),
    [openFilm, focusFeedEnd, focusRefine],
  );
  const { gridRef, activeIndex, setActiveIndex, handleKeyDown, focusItem, columns } = useGridNavigation(items.length, gridHandlers);
  const spotlight = items[activeIndex];

  /** A new search or refinement starts from the top of a fresh grid. */
  const filtersKey = filters ? JSON.stringify(filters) : "";
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setActiveIndex(0);
    window.scrollTo({ top: 0 });
  }, [searchInput, filtersKey, setActiveIndex]);

  /** Focus reaching the last row asks for the next page: a remote moves focus, not the scrollbar. */
  useEffect(() => {
    if (refined || inert) return;
    if (!gridRef.current?.contains(document.activeElement)) return;
    more.focusMoved(activeIndex, columns);
  }, [activeIndex, columns, items.length, refined, inert, more, gridRef]);

  /** The end of the grid nearing the viewport asks for it too, for mouse and touch. */
  useEndOfGrid(endRef, more, !refined && !inert, feed.items.length);

  /**
   * However a film page closes (Escape, the Back button, the browser's Back), focus returns to
   * the poster it was opened from. The page is a layer over the grid, which never moves or
   * scrolls underneath it, so only focus has to be put back.
   */
  useEffect(() => {
    const target = returnFocus.current;
    if (inert || !target) return;
    if (items.length === 0) return;
    returnFocus.current = null;
    const index = items.findIndex(({ id }) => id === target.id);
    focusItem(index >= 0 ? index : Math.min(target.index, items.length - 1));
  }, [inert, items, focusItem]);

  const attribution = response?.attribution ?? TMDB_ATTRIBUTION_FALLBACK;

  return (
    <main className="discover-shell catalog-shell" inert={inert}>
      <TopBar current="catalog" />

      <section className="catalog-head">
        {spotlight?.backdropUrl && (
          <img key={spotlight.id} className="catalog-backdrop" src={spotlight.backdropUrl} alt="" aria-hidden="true" />
        )}
        <div className="catalog-intro">
          <h1>The catalogue</h1>
          <p className="catalog-note">{source === "made" ? "What has been made in Reverie: public rooms you are part of, beside the films you came to watch." : "Every film Reverie can read. Search it, narrow it, and open anything."}</p>
          <SourceFilter source={source} onSource={setSource} barRef={sourceRef} onExitDown={enterSource} />
          {source === "catalogue" && <label className="catalog-search">
            <span className="sr-only">Search films by title</span>
            <input
              ref={searchRef}
              type="search"
              value={searchInput}
              maxLength={120}
              placeholder="Search by title…"
              autoComplete="off"
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focusRefine("first");
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  focusSource();
                }
                // Escape first clears what was typed; on an empty field it is Back, for the app.
                if (event.key === "Escape" && searchInput) {
                  event.preventDefault();
                  setSearchInput("");
                }
              }}
            />
          </label>}
        </div>
        {source === "catalogue" && spotlight && <Spotlight title={spotlight} />}
      </section>

      {source === "made" && <MadeGrid state={made} onOpen={onOpenMade} />}

      {source === "catalogue" && <><RefinementBar
        state={refinement.state}
        notice={refinement.notice}
        matchCount={state.phase === "ready" ? state.response.total : null}
        barRef={refineRef}
        onChoose={refinement.choose}
        onUnchoose={refinement.unchoose}
        onWithdraw={refinement.withdraw}
        onReset={refinement.reset}
        onExitUp={focusSearch}
        onExitDown={() => (items.length > 0 ? focusItem(activeIndex) : undefined)}
      />

      {shown && items.length > 0 && (
        <p className="catalog-ranked-by" role="status">
          {RANKED_BY[shown.source]}
        </p>
      )}

      <CatalogueRegion
        state={state}
        items={items}
        pickIds={pickIds}
        refined={refined}
        gridRef={gridRef}
        activeIndex={activeIndex}
        onKeyDown={handleKeyDown}
        onOpen={openFilm}
        onFocusIndex={setActiveIndex}
        onRetry={retry}
        query={searchInput}
      />

      {!refined && items.length > 0 && (
        <FeedEnd
          feed={feed}
          endRef={endRef}
          onRetry={() => {
            // The retry button is about to disappear; focus goes back to the grid first so a
            // remote is never left pointing at nothing.
            more.retry();
            focusItem(activeIndex);
          }}
          onReturnToGrid={() => focusItem(activeIndex)}
        />
      )}

      {response && items.length > 0 && <TmdbAttribution text={attribution} />}</>}
    </main>
  );
}

/**
 * Watches the end of the grid. The observer is re-attached whenever the grid grows, which makes
 * it report again: if the new end is still within reach (a tall screen, a short page), the next
 * page is asked for without waiting for a scroll that may never come.
 */
function useEndOfGrid(endRef: React.RefObject<HTMLDivElement | null>, more: FeedController, enabled: boolean, itemCount: number) {
  useEffect(() => {
    const end = endRef.current;
    if (!enabled || !end || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more.endInView();
      },
      { rootMargin: END_OF_GRID_MARGIN },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [endRef, more, enabled, itemCount]);
}

/**
 * The end of the grid: a loading line while a page is in flight, a retry after a failure, and
 * nothing at all once the last page is shown. It is always rendered, so its height is reserved
 * and the grid never shifts when the state changes.
 */
function FeedEnd({ feed, endRef, onRetry, onReturnToGrid }: { feed: Feed; endRef: React.RefObject<HTMLDivElement | null>; onRetry: () => void; onReturnToGrid: () => void }) {
  return (
    <div
      className="catalog-feed-end"
      ref={endRef}
      aria-live="polite"
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onReturnToGrid();
        }
      }}
    >
      {feed.loading && (
        <p className="catalog-feed-status">
          <span className="discover-spinner discover-spinner-inline" aria-hidden="true" />
          Loading more…
        </p>
      )}
      {feed.failure && (
        <p className="catalog-feed-status catalog-feed-failed" role="alert">
          {feed.failure.safeMessage}
          <button className="discover-retry" onClick={onRetry}>
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

/** The response on screen: the ready one, or the previous shortlist while a refined one reloads. */
function shownResponse(state: CatalogueState): CatalogueOk | null {
  if (state.phase === "ready") return state.response;
  if (state.phase === "loading") return state.previous ?? null;
  return null;
}

const NO_PICKS: ReadonlySet<string> = new Set();

type CatalogueRegionProps = {
  state: CatalogueState;
  items: readonly CatalogueTitle[];
  pickIds: ReadonlySet<string>;
  refined: boolean;
  gridRef: React.RefObject<HTMLDivElement | null>;
  activeIndex: number;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onOpen: (index: number) => void;
  onFocusIndex: (index: number) => void;
  onRetry: () => void;
  query: string;
};

function CatalogueRegion(props: CatalogueRegionProps) {
  const { state, items, pickIds, refined, gridRef, activeIndex, onKeyDown, onOpen, onFocusIndex, onRetry, query } = props;
  if (state.phase === "loading" && items.length === 0) {
    return (
      <section className="discover-state" aria-busy="true" aria-live="polite">
        <span className="discover-spinner" aria-hidden="true" />
        <p>Loading films…</p>
      </section>
    );
  }

  if (state.phase === "not_configured") {
    return (
      <section className="discover-state discover-state-notice" role="status">
        <p className="discover-state-title">Catalogue not configured</p>
        <p>{state.safeMessage}</p>
        {state.missing.length > 0 && (
          <p className="discover-state-detail">
            Waiting on:{" "}
            {state.missing.map((name, index) => (
              <span key={name}>
                {index > 0 && ", "}
                <code>{name}</code>
              </span>
            ))}
          </p>
        )}
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section className="discover-state discover-state-error" role="alert">
        <p className="discover-state-title">Films could not be loaded</p>
        <p>{state.safeMessage}</p>
        <p className="discover-state-detail">
          Reference: <code>{state.code}</code>
        </p>
        {state.retryable && (
          <button className="discover-retry" onClick={onRetry}>
            Try again
          </button>
        )}
      </section>
    );
  }

  if (items.length === 0) {
    return (
      <section className="discover-state" role="status">
        <p className="discover-state-title">Nothing matches</p>
        <p>{emptyMessage(query, refined)}</p>
      </section>
    );
  }

  return (
    <div className="catalog-grid" ref={gridRef} onKeyDown={onKeyDown} aria-busy={state.phase === "loading"}>
      <ul aria-label={refined ? "Films, ranked by genre match" : "Films"}>
        {items.map((title, index) => (
          <li key={title.id}>
            <button
              type="button"
              data-grid-index={index}
              tabIndex={index === activeIndex ? 0 : -1}
              className="catalog-card"
              onFocus={() => onFocusIndex(index)}
              onClick={() => onOpen(index)}
            >
              <span className="catalog-card-poster">
                <Artwork title={title} />
                {pickIds.has(title.id) && <span className="catalog-card-pick">Top pick</span>}
                <span className="catalog-card-cue" aria-hidden="true">
                  <kbd>OK</kbd> Details
                </span>
              </span>
              <span className="catalog-card-title">{title.title}</span>
              <span className="catalog-card-meta">
                {[title.year, title.rating, title.genres[0]].filter(Boolean).join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function emptyMessage(query: string, refined: boolean) {
  if (refined) return "Nothing fits all of that. Remove something above to widen it.";
  return query ? `Nothing matches “${query}”. Try another title.` : "There are no films to show yet.";
}

/**
 * Large-type summary of the focused poster, so the title and synopsis read from the sofa without
 * opening it. It repeats what the focused button already announces, so it is hidden from
 * assistive technology.
 */
function Spotlight({ title }: { title: CatalogueTitle }) {
  return (
    <div className="catalog-spotlight" aria-hidden="true">
      <p className="catalog-spotlight-eyebrow">Selected</p>
      <p className="catalog-spotlight-title">{title.title}</p>
      <p className="catalog-spotlight-meta">
        {[title.year, title.rating, title.runtimeMinutes && `${title.runtimeMinutes} min`, ...title.genres.slice(0, 3)]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {title.synopsis && <p className="catalog-spotlight-synopsis">{title.synopsis}</p>}
    </div>
  );
}
