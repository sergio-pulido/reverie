import type { CatalogueTitle } from "../catalogue/contract";
import { Artwork } from "../discover/Artwork";
import type { ShelfState } from "./shelfLoader";
import type { ShelfSpec } from "./shelves";
import { cellProps } from "./useHomeNavigation";

/** The titles a shelf shows: what it loaded, less the film already shown large as the hero. */
export function shelfItems(state: ShelfState, hero: CatalogueTitle | null): readonly CatalogueTitle[] {
  if (state.phase !== "ready") return [];
  return hero ? state.items.filter(({ id }) => id !== hero.id) : state.items;
}

/** Placeholder posters while a shelf loads: enough to reach past the edge, as a loaded one does. */
const PLACEHOLDERS = Array.from({ length: 8 }, (_, index) => index);

type ShelfProps = {
  spec: ShelfSpec;
  state: ShelfState;
  items: readonly CatalogueTitle[];
  rowKey: string;
  memory: ReadonlyMap<string, number>;
  sectionRef: (section: HTMLElement | null) => void;
  onOpen: (title: CatalogueTitle) => void;
  onRetry: () => void;
};

/**
 * One horizontal row of posters. It is sized so the last card on screen is cut by the edge,
 * which shows that the row goes on. Its height is the same loading, loaded or failed, and every
 * poster box is 2:3 before its image arrives, so nothing on the page moves as shelves fill in.
 */
export function Shelf({ spec, state, items, rowKey, memory, sectionRef, onOpen, onRetry }: ShelfProps) {
  if (state.phase === "not_configured" || (state.phase === "ready" && items.length === 0)) return null;
  const headingId = `shelf-${spec.id}`;
  // A retry keeps its button (and the viewer's focus) in place until the shelf has loaded.
  const retrying = state.phase === "loading" && state.retrying === true;
  const loading = !retrying && (state.phase === "idle" || state.phase === "loading");

  return (
    <section className="home-shelf" aria-labelledby={headingId} aria-busy={loading} ref={sectionRef}>
      <h2 className="home-shelf-title" id={headingId}>
        {spec.title}
      </h2>
      <div className="home-shelf-body">
        {state.phase === "ready" && (
          <ul className="home-shelf-track" aria-labelledby={headingId}>
            {items.map((title, index) => (
              <li key={title.id}>
                <button type="button" className="home-card" {...cellProps(rowKey, index, memory)} onClick={() => onOpen(title)}>
                  <span className="home-card-poster">
                    <Artwork title={title} className="home-card-art" />
                  </span>
                  <span className="home-card-title">{title.title}</span>
                  <span className="home-card-meta">{[title.year, title.genres[0]].filter(Boolean).join(" · ")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {loading && (
          <ul className="home-shelf-track" aria-hidden="true">
            {PLACEHOLDERS.map((index) => (
              <li key={index}>
                <span className="home-card home-card-placeholder">
                  <span className="home-card-poster" />
                </span>
              </li>
            ))}
          </ul>
        )}
        {(state.phase === "error" || retrying) && (
          <div className="home-shelf-failed" role={retrying ? "status" : "alert"}>
            <p>{state.phase === "error" ? state.safeMessage : "Loading these films again…"}</p>
            {(retrying || (state.phase === "error" && state.retryable)) && (
              <button type="button" className="tv-action" {...cellProps(rowKey, 0, memory)} aria-disabled={retrying} onClick={retrying ? undefined : onRetry}>
                {retrying ? "Loading…" : "Try again"}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
