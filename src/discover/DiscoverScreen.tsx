import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toCandidates } from "../catalogue/candidates";
import { providerIdOf, type CatalogueOk, type CatalogueTitle } from "../catalogue/contract";
import { rankShortlist } from "../catalogue/scorer";
import { isRefined, toShortlistFilters } from "../catalogue/shortlistFilters";
import type { FilmRoute } from "../lib/routes";
import type { PreferenceState } from "../preferences/schema";
import { FilmPage } from "./FilmPage";
import type { Feed, FeedController } from "./pageFeed";
import { RefinementBar } from "./RefinementBar";
import { useCatalogue, type CatalogueState } from "./useCatalogue";
import { useGridNavigation } from "./useGridNavigation";
import { useRefinement } from "./useRefinement";
import "./discover.css";

type DiscoverScreenProps = {
  /** The film the URL names, or null for the grid. */
  film: FilmRoute;
  onOpenFilm: (providerId: string) => void;
  onCloseFilm: () => void;
  onExit: () => void;
};

/** Shown whenever TMDB records are on screen, even if a response omits its own attribution. */
const TMDB_ATTRIBUTION_FALLBACK =
  "Film data and images from TMDB (themoviedb.org). This product uses TMDB data but is not endorsed or certified by TMDB.";

/** How far below the viewport the end of the grid starts loading the next page. */
const END_OF_GRID_MARGIN = "0px 0px 900px 0px";

/** Where focus goes when the grid comes back: the film that was open, or its old place. */
type ReturnFocus = { id: string; index: number };

export function DiscoverScreen({ film, onOpenFilm, onCloseFilm, onExit }: DiscoverScreenProps) {
  const [searchInput, setSearchInput] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const refineRef = useRef<HTMLElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<ReturnFocus | null>(null);
  const filmOpen = film !== null;

  // Reached by a film's URL, the grid is not read until the viewer goes to it: the page pays
  // for its one row and nothing else.
  const [gridWanted, setGridWanted] = useState(!filmOpen);
  useEffect(() => {
    if (!filmOpen) setGridWanted(true);
  }, [filmOpen]);

  const refinement = useRefinement();
  const refined = isRefined(refinement.state);
  const filters = useMemo(() => (refined ? toShortlistFilters(refinement.state) : null), [refined, refinement.state]);
  const { state, retry, feed, more } = useCatalogue(searchInput, filters, gridWanted);
  const response = shownResponse(state);
  const { items, pickIds } = useMemo(
    () => (refined ? orderForViewer(response, refinement.state) : { items: feed.items, pickIds: new Set<string>() }),
    [refined, response, refinement.state, feed.items],
  );

  const focusSearch = useCallback(() => searchRef.current?.focus(), []);
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
      onOpenFilm(providerIdOf(title.id));
    },
    [items, onOpenFilm],
  );
  const gridHandlers = useMemo(
    () => ({ onActivate: openFilm, onExitTop: () => focusRefine("last"), onExitBottom: focusFeedEnd, onBack: focusSearch }),
    [openFilm, focusSearch, focusFeedEnd, focusRefine],
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

  /** A remote has no pointer: when posters arrive and nothing holds focus, start on the grid. */
  const hasItems = items.length > 0;
  useEffect(() => {
    if (!hasItems || filmOpen) return;
    const idle = !document.activeElement || document.activeElement === document.body;
    if (idle) focusItem(activeIndex);
  }, [hasItems, state]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Focus reaching the last row asks for the next page: a remote moves focus, not the scrollbar. */
  useEffect(() => {
    if (refined || filmOpen) return;
    if (!gridRef.current?.contains(document.activeElement)) return;
    more.focusMoved(activeIndex, columns);
  }, [activeIndex, columns, items.length, refined, filmOpen, more, gridRef]);

  /** The end of the grid nearing the viewport asks for it too, for mouse and touch. */
  useEndOfGrid(endRef, more, !refined && !filmOpen, feed.items.length);

  /**
   * However a film page closes (Escape, the Back button, the browser's Back), the grid returns
   * to that film. The page is a layer over the grid, which never moves or scrolls underneath it,
   * so only focus has to be put back.
   */
  const openFilmId = film && "id" in film ? film.id : null;
  const lastFilmId = useRef(openFilmId);
  useEffect(() => {
    const closed = lastFilmId.current;
    lastFilmId.current = openFilmId;
    if (closed && !filmOpen && !returnFocus.current) returnFocus.current = { id: `cat:${closed}`, index: activeIndex };
  }, [openFilmId, filmOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Back on the grid, focus returns to the film that was open. If that film is gone (turned
   * down), its old place is focused instead, or the refinements when nothing is left. Reached by
   * URL, there is nothing to return to until posters arrive.
   */
  useEffect(() => {
    const target = returnFocus.current;
    if (filmOpen || !target) return;
    if (items.length === 0) {
      if (state.phase === "ready") {
        returnFocus.current = null;
        focusRefine("first");
      }
      return;
    }
    returnFocus.current = null;
    const index = items.findIndex(({ id }) => id === target.id);
    focusItem(index >= 0 ? index : Math.min(target.index, items.length - 1));
  }, [filmOpen, items, state.phase, focusItem, focusRefine]);

  /** "Not this one": the title leaves the grid now and never returns in this session. */
  const { reject } = refinement;
  const rejectFilm = useCallback(
    (id: string) => {
      if (!returnFocus.current) returnFocus.current = { id, index: activeIndex };
      reject(id);
      onCloseFilm();
    },
    [reject, onCloseFilm, activeIndex],
  );

  const attribution = response?.attribution ?? TMDB_ATTRIBUTION_FALLBACK;
  const seed = openFilmId ? items.find(({ id }) => providerIdOf(id) === openFilmId) : undefined;

  return (
    <>
      {film && (
        <FilmPage
          providerId={openFilmId}
          seed={seed}
          attributionFallback={attribution}
          onBack={onCloseFilm}
          onReject={rejectFilm}
        />
      )}
      <main className="discover-shell" inert={filmOpen}>
        <header className="discover-bar">
          <button className="discover-brand" onClick={onExit}>
            <span aria-hidden="true">✳</span> REVERIE
          </button>
          <p className="discover-eyebrow">DISCOVER</p>
          <button className="discover-jam-link" onClick={onExit}>
            Movie Jam <span aria-hidden="true">↗</span>
          </button>
        </header>

        <section className="discover-head">
          {spotlight?.backdropUrl && (
            <img key={spotlight.id} className="discover-backdrop" src={spotlight.backdropUrl} alt="" aria-hidden="true" />
          )}
          <div className="discover-intro">
            <h1>
              What are we watching <em>tonight?</em>
            </h1>
            <p className="discover-note">Say what you’re in the mood for, then narrow it down together.</p>
            <label className="discover-search">
              <span className="sr-only">Search films</span>
              <input
                ref={searchRef}
                type="search"
                value={searchInput}
                maxLength={120}
                placeholder="Search by title, mood or genre…"
                autoComplete="off"
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusRefine("first");
                  }
                  if (event.key === "Escape") {
                    if (searchInput) setSearchInput("");
                    else onExit();
                  }
                }}
              />
            </label>
          </div>
          {spotlight && <Spotlight title={spotlight} />}
        </section>

        <RefinementBar
          state={refinement.state}
          notice={refinement.notice}
          matchCount={state.phase === "ready" ? state.response.total : null}
          barRef={refineRef}
          onChoose={refinement.choose}
          onUnchoose={refinement.unchoose}
          onWithdraw={refinement.withdraw}
          onRestore={refinement.restore}
          onReset={refinement.reset}
          onExitUp={focusSearch}
          onExitDown={() => (items.length > 0 ? focusItem(activeIndex) : undefined)}
        />

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

        {response && items.length > 0 && (
          <p className="discover-attribution">
            <span className="discover-attribution-mark" aria-hidden="true">TMDB</span>
            {attribution}
          </p>
        )}
      </main>
    </>
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
      className="discover-feed-end"
      ref={endRef}
      aria-live="polite"
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "Escape") {
          event.preventDefault();
          onReturnToGrid();
        }
      }}
    >
      {feed.loading && (
        <p className="discover-feed-status">
          <span className="discover-spinner discover-spinner-inline" aria-hidden="true" />
          Loading more…
        </p>
      )}
      {feed.failure && (
        <p className="discover-feed-status discover-feed-failed" role="alert">
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

/**
 * Unrefined, the grid keeps the catalogue's own order. Refined, the shortlist is ranked for the
 * viewer: ineligible titles drop out at once, even before the database answers, and the top
 * picks lead.
 */
function orderForViewer(response: CatalogueOk | null, state: PreferenceState | null) {
  if (!response) return { items: [], pickIds: new Set<string>() };
  if (!state) return { items: response.items, pickIds: new Set<string>() };
  const { picks, ordered } = rankShortlist(toCandidates(response.items), state);
  return { items: ordered.map(({ title }) => title), pickIds: new Set(picks.map(({ id }) => id)) };
}

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
    <>
      <div className="discover-grid" ref={gridRef} onKeyDown={onKeyDown} aria-busy={state.phase === "loading"}>
        <ul aria-label={refined ? "Films ranked for you" : "Films"}>
          {items.map((title, index) => (
            <li key={title.id}>
              <button
                type="button"
                data-grid-index={index}
                tabIndex={index === activeIndex ? 0 : -1}
                className="discover-card"
                onFocus={() => onFocusIndex(index)}
                onClick={() => onOpen(index)}
              >
                <span className="discover-card-poster">
                  <Artwork title={title} />
                  {pickIds.has(title.id) && <span className="discover-card-pick">Top pick</span>}
                  <span className="discover-card-cue" aria-hidden="true">
                    <kbd>OK</kbd> Details
                  </span>
                </span>
                <span className="discover-card-title">{title.title}</span>
                <span className="discover-card-meta">
                  {[title.year, title.rating, title.genres[0]].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function emptyMessage(query: string, refined: boolean) {
  if (refined) return "Nothing fits all of that. Remove something above to widen it.";
  return query ? `Nothing matches “${query}”. Try another title, mood or genre.` : "There are no films to show yet.";
}

/**
 * Large-type summary of the focused poster, so the title and synopsis read from the sofa without
 * opening it. It repeats what the focused button already announces, so it is hidden from
 * assistive technology.
 */
function Spotlight({ title }: { title: CatalogueTitle }) {
  return (
    <div className="discover-spotlight" aria-hidden="true">
      <p className="discover-spotlight-eyebrow">Selected</p>
      <p className="discover-spotlight-title">{title.title}</p>
      <p className="discover-spotlight-meta">
        {[title.year, title.rating, title.runtimeMinutes && `${title.runtimeMinutes} min`, ...title.genres.slice(0, 3)]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {title.synopsis && <p className="discover-spotlight-synopsis">{title.synopsis}</p>}
    </div>
  );
}

function Artwork({ title }: { title: CatalogueTitle }) {
  if (!title.posterUrl) {
    return (
      <span className="discover-card-art discover-card-art-empty" aria-hidden="true">
        No artwork supplied
      </span>
    );
  }
  return (
    <img
      className="discover-card-art"
      src={title.posterUrl}
      alt={`Poster for ${title.title}`}
      width={500}
      height={750}
      loading="lazy"
      decoding="async"
    />
  );
}
