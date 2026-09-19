import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogueTitle } from "../catalogue/contract";
import { useCatalogue, type CatalogueState } from "./useCatalogue";
import { useGridNavigation } from "./useGridNavigation";
import "./discover.css";

type DiscoverScreenProps = { onExit: () => void };

export function DiscoverScreen({ onExit }: DiscoverScreenProps) {
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CatalogueTitle | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const { state, retry } = useCatalogue(searchInput, page);
  const items = state.phase === "ready" ? state.response.items : [];

  const focusSearch = useCallback(() => searchRef.current?.focus(), []);
  const activate = useCallback(
    (index: number) => {
      const title = items[index];
      if (title) setSelected(title);
    },
    [items],
  );
  const { gridRef, activeIndex, setActiveIndex, handleKeyDown, focusItem } = useGridNavigation(
    items.length,
    focusSearch,
    activate,
  );

  useEffect(() => setPage(1), [searchInput]);

  const closeDetail = useCallback(() => {
    setSelected(null);
    focusItem(activeIndex);
  }, [activeIndex, focusItem]);

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
              if (event.key === "ArrowDown" && items.length > 0) {
                event.preventDefault();
                focusItem(activeIndex);
              }
              if (event.key === "Escape") setSearchInput("");
            }}
          />
        </label>
      </section>

      <CatalogueRegion
        state={state}
        gridRef={gridRef}
        activeIndex={activeIndex}
        onKeyDown={handleKeyDown}
        onSelect={setSelected}
        onFocusIndex={setActiveIndex}
        onRetry={retry}
        query={searchInput}
      />

      {state.phase === "ready" && (state.response.page > 1 || state.response.hasMore) && (
        <nav className="discover-pager" aria-label="Catalogue pages">
          <button disabled={state.response.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            ← Previous
          </button>
          <span>Page {state.response.page}</span>
          <button disabled={!state.response.hasMore} onClick={() => setPage((value) => value + 1)}>
            Next →
          </button>
        </nav>
      )}

      {selected && <TitleDetail title={selected} onClose={closeDetail} />}
    </main>
  );
}

type CatalogueRegionProps = {
  state: CatalogueState;
  gridRef: React.RefObject<HTMLDivElement | null>;
  activeIndex: number;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelect: (title: CatalogueTitle) => void;
  onFocusIndex: (index: number) => void;
  onRetry: () => void;
  query: string;
};

function CatalogueRegion({ state, gridRef, activeIndex, onKeyDown, onSelect, onFocusIndex, onRetry, query }: CatalogueRegionProps) {
  if (state.phase === "loading") {
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

  if (state.response.items.length === 0) {
    return (
      <section className="discover-state" role="status">
        <p className="discover-state-title">No catalogue titles match</p>
        <p>{query ? `Nothing in the catalogue matches “${query}”.` : "The catalogue returned no titles."}</p>
      </section>
    );
  }

  return (
    <>
      <div className="discover-grid" ref={gridRef} onKeyDown={onKeyDown}>
        <ul aria-label="Catalogue titles">
          {state.response.items.map((title, index) => (
            <li key={title.id}>
              <button
                type="button"
                data-grid-index={index}
                tabIndex={index === activeIndex ? 0 : -1}
                className="discover-card"
                onFocus={() => onFocusIndex(index)}
                onClick={() => onSelect(title)}
              >
                <Artwork title={title} />
                <span className="discover-card-title">{title.title}</span>
                <span className="discover-card-meta">
                  {[title.year, title.rating, title.genres[0]].filter(Boolean).join(" · ") || "Catalogue title"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {state.response.attribution && <p className="discover-attribution">{state.response.attribution}</p>}
    </>
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
  return <img className="discover-card-art" src={title.posterUrl} alt={`Poster for ${title.title}`} loading="lazy" />;
}

function TitleDetail({ title, onClose }: { title: CatalogueTitle; onClose: () => void }) {
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
        <p className="discover-detail-attribution">{title.attribution ?? "Catalogue record shown as supplied."}</p>
      </section>
    </div>
  );
}
