import { useEffect, useRef } from "react";
import { providerIdOf, type CatalogueTitle } from "../catalogue/contract";
import { filmHeadline, type FilmRecord } from "../discover/filmFacts";
import { useFilm } from "../discover/useFilm";
import { dialogKey, focusables } from "./dialog";

type FilmPreviewProps = {
  title: CatalogueTitle;
  attribution: string;
  /** Drawn as a sheet filling a phone's screen, with a control to close it by thumb. */
  sheet: boolean;
  onClose: () => void;
  onOpenFilm: (title: CatalogueTitle) => void;
  onStartJam: (title: CatalogueTitle) => void;
};

const MOVES = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/**
 * A film's preview, over the conversation: enough to triage a row without losing the thread, and
 * no more. The row's copy shows at once; the film's one full row fills in the score when it
 * arrives, and if it never does the preview simply goes without. Accessibility details (subtitles,
 * audio description) would show here, but no record in the catalogue carries them.
 *
 * Two things can be done from it: open the film's own page, or start a Jam inspired by it. The
 * catalogue is for finding films, not a licence to show them, so nothing here plays or implies
 * that it can. It opens on its first action and keeps focus inside; Back or Escape closes it.
 *
 * On a phone it fills the screen from the bottom, because a dialog centred in a 360-pixel window
 * is taller than the window and loses both its ends. Filling the screen leaves no backdrop to
 * press, so there it also carries a close control; a remote has Back and never sees one.
 */
export function FilmPreview({ title, attribution, sheet, onClose, onOpenFilm, onStartJam }: FilmPreviewProps) {
  const { state } = useFilm(providerIdOf(title.id));
  const film: FilmRecord = state.phase === "ready" ? { ...title, ...state.film } : title;
  const headline = filmHeadline(film);
  const firstAction = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    firstAction.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="search-overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className={`search-preview${sheet ? " search-preview-sheet" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-preview-title"
        onKeyDown={(event) => {
          if (dialogKey(event, onClose)) return;
          if (event.defaultPrevented) return;
          const controls = focusables(event.currentTarget);
          const at = controls.indexOf(document.activeElement as HTMLElement);
          if (event.key === "Enter" && at >= 0) {
            // OK chooses once, here, rather than relying on the browser's own activation.
            event.preventDefault();
            controls[at].click();
            return;
          }
          if (MOVES.has(event.key)) {
            event.preventDefault();
            const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
            controls[Math.min(Math.max(at + (forward ? 1 : -1), 0), controls.length - 1)]?.focus();
          }
        }}
      >
        {film.backdropUrl && <img className="search-preview-backdrop" src={film.backdropUrl} alt="" aria-hidden="true" />}
        {sheet && (
          <button type="button" className="search-preview-close" aria-label="Close the preview" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        )}
        <div className="search-preview-body">
          {film.posterUrl ? (
            <img className="search-preview-poster" src={film.posterUrl} alt={`Poster for ${film.title}`} width={500} height={750} />
          ) : (
            <span className="search-preview-poster search-preview-poster-empty" aria-hidden="true" />
          )}
          <div className="search-preview-summary">
            <h2 id="search-preview-title">{film.title}</h2>
            {headline.length > 0 && <p className="search-preview-headline">{headline.join(" · ")}</p>}
            {film.genres.length > 0 && (
              <ul className="search-preview-genres" aria-label="Genres">
                {film.genres.map((genre) => (
                  <li key={genre}>{genre}</li>
                ))}
              </ul>
            )}
            {film.synopsis && <p className="search-preview-synopsis">{film.synopsis}</p>}
            <div className="search-preview-actions" role="group" aria-label="What to do with this film">
              <button ref={firstAction} type="button" className="tv-action tv-action-primary" onClick={() => onOpenFilm(film)}>
                Open the film page
              </button>
              <button type="button" className="tv-action" onClick={() => onStartJam(film)}>
                Start a Jam from this
              </button>
            </div>
          </div>
        </div>
        <p className="search-preview-attribution">
          <span className="discover-attribution-mark" aria-hidden="true">TMDB</span>
          {state.phase === "ready" ? state.attribution ?? attribution : attribution}
        </p>
      </section>
    </div>
  );
}
