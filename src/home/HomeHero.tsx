import type { CatalogueTitle } from "../catalogue/contract";
import type { ShelfState } from "./shelfLoader";
import { cellProps } from "./useHomeNavigation";

/**
 * The film at the top of the home: the most popular title of the first shelf that has a backdrop
 * to show (or its most popular title, if none has), taken from that shelf's own read, so the hero
 * costs no request of its own. It is not repeated in the shelf beneath it.
 */
export function heroOf(state: ShelfState): CatalogueTitle | null {
  if (state.phase !== "ready") return null;
  return state.items.find((title) => title.backdropUrl) ?? state.items[0] ?? null;
}

type HomeHeroProps = {
  state: ShelfState;
  film: CatalogueTitle | null;
  shelfTitle: string;
  rowKey: string;
  memory: ReadonlyMap<string, number>;
  onOpen: (title: CatalogueTitle) => void;
};

/**
 * Full width, with the film's backdrop behind its title, facts and synopsis, and one action. The
 * box keeps its height while the first shelf loads, so nothing below it moves when it fills.
 */
export function HomeHero({ state, film, shelfTitle, rowKey, memory, onOpen }: HomeHeroProps) {
  if (!film) {
    return (
      <section className="home-hero home-hero-empty" aria-busy={state.phase === "idle" || state.phase === "loading"}>
        <div className="home-hero-copy">
          {state.phase === "not_configured" && (
            <>
              <p className="home-hero-title">No films to show yet</p>
              <p className="home-hero-synopsis">{state.safeMessage}</p>
            </>
          )}
          {state.phase === "error" && (
            <>
              <p className="home-hero-title">Films could not be loaded</p>
              <p className="home-hero-synopsis">{state.safeMessage}</p>
            </>
          )}
        </div>
      </section>
    );
  }

  const facts = [film.year, film.runtimeMinutes && `${film.runtimeMinutes} min`, ...film.genres.slice(0, 3)].filter(Boolean).join(" · ");
  return (
    <section className="home-hero" aria-labelledby="home-hero-title">
      {film.backdropUrl && <img key={film.id} className="home-hero-backdrop" src={film.backdropUrl} alt="" aria-hidden="true" />}
      <div className="home-hero-copy">
        <p className="home-hero-eyebrow">{shelfTitle}</p>
        <h2 className="home-hero-title" id="home-hero-title">{film.title}</h2>
        {facts && <p className="home-hero-facts">{facts}</p>}
        {film.synopsis && <p className="home-hero-synopsis">{film.synopsis}</p>}
        <div className="home-actions">
          <button type="button" className="tv-action tv-action-primary" {...cellProps(rowKey, 0, memory)} onClick={() => onOpen(film)}>
            About this film
          </button>
        </div>
      </div>
    </section>
  );
}
