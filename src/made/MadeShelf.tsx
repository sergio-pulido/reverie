import { STARTED_KIND_LABEL } from "../lib/startedKinds";
import { cellProps } from "../home/useHomeNavigation";
import { NOTHING_MADE_YET, producedLine, type MadeFilm, type MadeState } from "./madeInReverie";

type MadeShelfProps = {
  state: MadeState;
  rowKey: string;
  memory: ReadonlyMap<string, number>;
  onOpen: (film: MadeFilm) => void;
};

/**
 * Made in Reverie, on the home, one shelf among the catalogue's.
 *
 * This is the product's own claim — that what you watch and what you make sit on the same
 * shelf — so it is drawn as a shelf and not as a separate place. There are no posters: nothing
 * a browser can read holds artwork for a room, so each card is the room's own words, and the
 * shelf says plainly when there is nothing yet instead of standing empty.
 */
export function MadeShelf({ state, rowKey, memory, onOpen }: MadeShelfProps) {
  const films = state.phase === "ready" ? state.films : [];
  return (
    // Its own class, not `.home-shelf`: a catalogue shelf reserves a poster row's height, and
    // this one holds words whose height is its own.
    <section className="home-made" aria-labelledby="home-made-title" aria-busy={state.phase === "loading"}>
      <h2 className="home-shelf-title" id="home-made-title">Made in Reverie</h2>
      <div className="home-made-body">
        {state.phase === "loading" && <p className="home-made-note">Looking for what has been made here…</p>}
        {state.phase === "error" && <p className="home-made-note" role="alert">{state.safeMessage}</p>}
        {state.phase === "ready" && films.length === 0 && <p className="home-made-note">{NOTHING_MADE_YET}</p>}
        {films.length > 0 && (
          <ul className="home-made-track" aria-labelledby="home-made-title">
            {films.map((film, index) => (
              <li key={film.jamId}>
                <button type="button" className="home-made-card" {...cellProps(rowKey, index, memory)} onClick={() => onOpen(film)}>
                  <span className="home-made-kind">{STARTED_KIND_LABEL[film.kind]}</span>
                  <span className="home-made-title">{film.title}</span>
                  <span className="home-made-premise">{film.premise}</span>
                  <span className="home-made-status">{producedLine(film)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
