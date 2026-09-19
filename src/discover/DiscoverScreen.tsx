import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toCandidates } from "../catalogue/candidates";
import type { CatalogueOk, CatalogueTitle } from "../catalogue/contract";
import { rankShortlist } from "../catalogue/scorer";
import { isRefined, toShortlistFilters } from "../catalogue/shortlistFilters";
import type { PreferenceState } from "../preferences/schema";
import { RefinementBar } from "./RefinementBar";
import { useCatalogue, type CatalogueState } from "./useCatalogue";
import { useGridNavigation } from "./useGridNavigation";
import { useRefinement } from "./useRefinement";
import "./discover.css";

type DiscoverScreenProps = { onExit: () => void };

/** Shown whenever TMDB records are on screen, even if a response omits its own attribution. */
const TMDB_ATTRIBUTION_FALLBACK =
  "Film data and images from TMDB (themoviedb.org). This product uses TMDB data but is not endorsed or certified by TMDB.";

export function DiscoverScreen({ onExit }: DiscoverScreenProps) {
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CatalogueTitle | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const pagerRef = useRef<HTMLElement | null>(null);
  const refineRef = useRef<HTMLElement | null>(null);

  const refinement = useRefinement();
  const refined = isRefined(refinement.state);
  const filters = useMemo(() => (refined ? toShortlistFilters(refinement.state) : null), [refined, refinement.state]);
  const { state, retry } = useCatalogue(searchInput, page, filters);
  const response = shownResponse(state);
  const { items, pickIds } = useMemo(() => orderForViewer(response, refined ? refinement.state : null), [response, refined, refinement.state]);

  const focusSearch = useCallback(() => searchRef.current?.focus(), []);
  const focusRefine = useCallback((rail: "first" | "last") => {
    const rails = refineRef.current?.querySelectorAll<HTMLElement>("[data-rail]");
    const target = rails && rails.length > 0 ? rails[rail === "first" ? 0 : rails.length - 1] : null;
    target?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  const activate = useCallback(
    (index: number) => {
      const title = items[index];
      if (title) setSelected(title);
    },
    [items],
  );
  const focusPager = useCallback(() => {
    pagerRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);
  const gridHandlers = useMemo(
    () => ({ onActivate: activate, onExitTop: () => focusRefine("last"), onExitBottom: focusPager, onBack: focusSearch }),
    [activate, focusSearch, focusPager, focusRefine],
  );
  const { gridRef, activeIndex, setActiveIndex, handleKeyDown, focusItem } = useGridNavigation(
    items.length,
    gridHandlers,
  );
  const spotlight = items[activeIndex];

  useEffect(() => setPage(1), [searchInput]);

  /** A remote has no pointer: when posters arrive and nothing holds focus, start on the grid. */
  const hasItems = items.length > 0;
  useEffect(() => {
    if (!hasItems) return;
    const idle = !document.activeElement || document.activeElement === document.body;
    if (idle) focusItem(activeIndex);
  }, [hasItems, state]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeDetail = useCallback(() => {
    setSelected(null);
    focusItem(activeIndex);
  }, [activeIndex, focusItem]);

  /** "Not this one": the title leaves the grid now and never returns in this session. */
  const pendingFocus = useRef<number | null>(null);
  const { reject } = refinement;
  const rejectSelected = useCallback(() => {
    if (!selected) return;
    pendingFocus.current = activeIndex;
    reject(selected.id);
    setSelected(null);
  }, [selected, reject, activeIndex]);

  /**
   * Once the rejected card is gone, focus the title now at its position (the order may have
   * changed, since a first rejection turns on ranking), or the refinements if nothing is left.
   * The request is consumed either way, so it can never take focus later.
   */
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    if (items.length > 0) focusItem(Math.min(index, items.length - 1));
    else focusRefine("first");
  }, [items, focusItem, focusRefine]);

  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected, closeDetail]);

  return (
    <main className="discover-shell">
      <header className="discover-bar">
        <button className="discover-brand" onClick={onExit}>
          <span aria-hidden="true">✳</span> REVERIE
        </button>
        <p className="discover-eyebrow">DISCOVER · REAL CATALOGUE</p>
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
            Find a <em>real</em> film.
          </h1>
          <p className="discover-note">
            Discover shows real films from a curated TMDB catalogue, with their own artwork and
            metadata. It does not say where a film can be watched. Generated Movie Jam scenes never
            appear here.
          </p>
          <label className="discover-search">
            <span className="sr-only">Search the catalogue</span>
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
        onExitDown={() => (items.length > 0 ? focusItem(activeIndex) : focusPager())}
      />

      <CatalogueRegion
        state={state}
        items={items}
        pickIds={pickIds}
        refined={refined}
        gridRef={gridRef}
        activeIndex={activeIndex}
        onKeyDown={handleKeyDown}
        onSelect={setSelected}
        onFocusIndex={setActiveIndex}
        onRetry={retry}
        query={searchInput}
      />

      {!refined && state.phase === "ready" && (state.response.page > 1 || state.response.hasMore) && (
        <nav
          className="discover-pager"
          aria-label="Catalogue pages"
          ref={pagerRef}
          onKeyDown={(event) => handlePagerKey(event, () => focusItem(activeIndex))}
        >
          <button disabled={state.response.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            ← Previous
          </button>
          <span>Page {state.response.page}</span>
          <button disabled={!state.response.hasMore} onClick={() => setPage((value) => value + 1)}>
            Next →
          </button>
        </nav>
      )}

      {response && items.length > 0 && (
        <p className="discover-attribution">
          <span className="discover-attribution-mark" aria-hidden="true">TMDB</span>
          {response.attribution ?? TMDB_ATTRIBUTION_FALLBACK}
        </p>
      )}

      {selected && <TitleDetail title={selected} onClose={closeDetail} onReject={rejectSelected} />}
    </main>
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
  items: CatalogueTitle[];
  pickIds: ReadonlySet<string>;
  refined: boolean;
  gridRef: React.RefObject<HTMLDivElement | null>;
  activeIndex: number;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelect: (title: CatalogueTitle) => void;
  onFocusIndex: (index: number) => void;
  onRetry: () => void;
  query: string;
};

function CatalogueRegion(props: CatalogueRegionProps) {
  const { state, items, pickIds, refined, gridRef, activeIndex, onKeyDown, onSelect, onFocusIndex, onRetry, query } = props;
  if (state.phase === "loading" && items.length === 0) {
    return (
      <section className="discover-state" aria-busy="true" aria-live="polite">
        <span className="discover-spinner" aria-hidden="true" />
        <p>Loading catalogue titles…</p>
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
        <p className="discover-state-title">Discover could not load the catalogue</p>
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
        <p className="discover-state-title">No catalogue titles match</p>
        <p>{emptyMessage(query, refined)}</p>
      </section>
    );
  }

  return (
    <>
      <div className="discover-grid" ref={gridRef} onKeyDown={onKeyDown} aria-busy={state.phase === "loading"}>
        <ul aria-label={refined ? "Titles ranked for you" : "Catalogue titles"}>
          {items.map((title, index) => (
            <li key={title.id}>
              <button
                type="button"
                data-grid-index={index}
                tabIndex={index === activeIndex ? 0 : -1}
                className="discover-card"
                onFocus={() => onFocusIndex(index)}
                onClick={() => onSelect(title)}
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
                  {[title.year, title.rating, title.genres[0]].filter(Boolean).join(" · ") || "Catalogue title"}
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
  if (refined) return "Nothing in the catalogue fits all of that. Remove something above to widen it.";
  return query ? `Nothing in the catalogue matches “${query}”.` : "The catalogue returned no titles.";
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

/** Left/Right move between the pager buttons; Up or Escape hands focus back to the grid. */
function handlePagerKey(event: React.KeyboardEvent<HTMLElement>, returnToGrid: () => void) {
  if (event.key === "ArrowUp" || event.key === "Escape") {
    event.preventDefault();
    returnToGrid();
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = buttons[current + (event.key === "ArrowRight" ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function Artwork({ title }: { title: CatalogueTitle }) {
  if (!title.posterUrl) {
    return (
      <span className="discover-card-art discover-card-art-empty" aria-hidden="true">
        No artwork supplied
      </span>
    );
  }
  return <img className="discover-card-art" src={title.posterUrl} alt={`Poster for ${title.title}`} loading="lazy" />;
}

function TitleDetail({ title, onClose, onReject }: { title: CatalogueTitle; onClose: () => void; onReject: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => closeRef.current?.focus(), []);

  /** Keeps Tab inside the dialog so a remote or keyboard cannot wander into the hidden page. */
  function trapTab(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button, a[href]");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="discover-detail-backdrop" onClick={onClose}>
      <section
        className="discover-detail"
        role="dialog"
        aria-modal="true"
        aria-label={title.title}
        ref={dialogRef}
        onKeyDown={trapTab}
        onClick={(event) => event.stopPropagation()}
      >
        <button className="discover-detail-close" ref={closeRef} onClick={onClose} aria-label="Close title details">
          ×
        </button>
        <h2>{title.title}</h2>
        <p className="discover-detail-meta">
          {[title.year, title.rating, title.runtimeMinutes && `${title.runtimeMinutes} min`, ...title.genres]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {title.synopsis && <p className="discover-detail-synopsis">{title.synopsis}</p>}
        <button className="discover-detail-reject" onClick={onReject}>
          Not this one
        </button>
        <p className="discover-detail-attribution">{title.attribution ?? "Catalogue record shown as supplied."}</p>
      </section>
    </div>
  );
}
