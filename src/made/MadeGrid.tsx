import { STARTED_KIND_LABEL } from "../lib/startedKinds";
import { NOTHING_MADE_YET, producedLine, type MadeFilm, type MadeState } from "./madeInReverie";

/**
 * Made in Reverie, as Catalog's other source.
 *
 * The same grid, a different shelf: films made here are not a different place, they are the
 * other half of the same catalogue. No posters, because nothing a browser can read holds
 * artwork for a room, and no claim that a room has a film to play — what it says about what a
 * room produced is the room's own state.
 */
export function MadeGrid({ state, onOpen }: { state: MadeState; onOpen: (film: MadeFilm) => void }) {
  return (
    <section className="catalog-made" aria-label="Made in Reverie" aria-busy={state.phase === "loading"}>
      {state.phase === "loading" && <p className="catalog-made-note">Looking for what has been made here…</p>}
      {state.phase === "error" && <p className="catalog-made-note" role="alert">{state.safeMessage}</p>}
      {state.phase === "ready" && state.films.length === 0 && <p className="catalog-made-note" role="status">{NOTHING_MADE_YET}</p>}
      {state.phase === "ready" && state.films.length > 0 && (
        <ul className="catalog-made-grid">
          {state.films.map((film) => (
            <li key={film.jamId}>
              <button type="button" className="catalog-made-card" onClick={() => onOpen(film)}>
                <span className="catalog-made-kind">{STARTED_KIND_LABEL[film.kind]}</span>
                <span className="catalog-made-title">{film.title}</span>
                <span className="catalog-made-premise">{film.premise}</span>
                <span className="catalog-made-status">{producedLine(film)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
