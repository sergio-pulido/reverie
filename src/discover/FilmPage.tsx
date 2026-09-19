import { useEffect, useRef } from "react";
import type { CatalogueTitle } from "../catalogue/contract";
import { filmFacts, filmHeadline, imdbUrl, type FilmRecord } from "./filmFacts";
import { useFilm } from "./useFilm";

type FilmPageProps = {
  /** The provider id from the URL, or null when the URL names no valid film. */
  providerId: string | null;
  /** The grid's copy of this film, shown at once while the full record loads. */
  seed?: CatalogueTitle;
  attributionFallback: string;
  onBack: () => void;
  onReject: (id: string) => void;
};

/** Keys that leave the page: a keyboard's Escape and a remote's Back. */
const BACK_KEYS = new Set(["Escape", "GoBack", "Backspace"]);
const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

/**
 * A film's own page, at `/discover/:id`. It renders only what the record holds, and grows with
 * it: the grid's copy appears at once, and the full record fills in when its single row arrives.
 *
 * It is drawn as a full-screen layer over the grid rather than in its place, so the grid keeps
 * its scroll position, its loaded pages and its focus target while the page is open.
 */
export function FilmPage({ providerId, seed, attributionFallback, onBack, onReject }: FilmPageProps) {
  const { state, retry } = useFilm(providerId);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    pageRef.current?.scrollTo({ top: 0 });
    backRef.current?.focus({ preventScroll: true });
  }, [providerId]);

  /** The grid stays put underneath; the page scrolls on its own. */
  useEffect(() => {
    document.documentElement.classList.add("film-page-open");
    return () => document.documentElement.classList.remove("film-page-open");
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (BACK_KEYS.has(event.key)) {
        event.preventDefault();
        onBack();
        return;
      }
      moveFocus(event, pageRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const film: FilmRecord | undefined = state.phase === "ready" ? { ...seed, ...state.film } : seed;
  const attribution = state.phase === "ready" ? state.attribution ?? attributionFallback : attributionFallback;

  return (
    <main className="discover-shell film-page" ref={pageRef} aria-busy={state.phase === "loading"}>
      {film?.backdropUrl && <img key={film.backdropUrl} className="film-backdrop" src={film.backdropUrl} alt="" aria-hidden="true" />}
      <header className="discover-bar">
        <button className="film-back" ref={backRef} onClick={onBack}>
          <span aria-hidden="true">←</span> All films
        </button>
      </header>

      {film ? <FilmBody film={film} complete={state.phase === "ready"} onReject={onReject} /> : <FilmStatus state={state} onBack={onBack} onRetry={retry} />}
      {film && state.phase === "error" && (
        <p className="film-inline-error" role="alert">
          {state.safeMessage}{" "}
          {state.retryable && (
            <button className="discover-retry" onClick={retry}>
              Try again
            </button>
          )}
        </p>
      )}

      {film && (
        <p className="discover-attribution">
          <span className="discover-attribution-mark" aria-hidden="true">TMDB</span>
          {attribution}
        </p>
      )}
    </main>
  );
}

function FilmBody({ film, complete, onReject }: { film: FilmRecord; complete: boolean; onReject: (id: string) => void }) {
  const headline = filmHeadline(film);
  const facts = filmFacts(film);
  const imdb = imdbUrl(film.imdbId);
  return (
    <>
      <section className="film-hero">
        {film.posterUrl ? (
          <img className="film-poster" src={film.posterUrl} alt={`Poster for ${film.title}`} width={500} height={750} />
        ) : (
          <span className="film-poster film-poster-empty" aria-hidden="true" />
        )}
        <div className="film-summary">
          <h1>{film.title}</h1>
          {film.tagline && <p className="film-tagline">{film.tagline}</p>}
          {headline.length > 0 && <p className="film-headline">{headline.join(" · ")}</p>}
          {film.genres.length > 0 && (
            <ul className="film-genres" aria-label="Genres">
              {film.genres.map((genre) => (
                <li key={genre}>{genre}</li>
              ))}
            </ul>
          )}
          {film.synopsis && <p className="film-synopsis">{film.synopsis}</p>}
          {/* Actions for this film live here, and only actions that do something. */}
          <div className="film-actions" role="group" aria-label="What to do with this film">
            <button className="film-action" onClick={() => onReject(film.id)}>
              Not this one
            </button>
          </div>
        </div>
      </section>

      {(facts.length > 0 || (film.keywords?.length ?? 0) > 0 || imdb) && (
        <section className="film-details" aria-label="About this film">
          {facts.length > 0 && (
            <dl className="film-facts">
              {facts.map(({ label, value }) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {film.keywords && film.keywords.length > 0 && (
            <div className="film-keywords">
              <h2>Keywords</h2>
              <ul>
                {film.keywords.map((keyword) => (
                  <li key={keyword}>{keyword}</li>
                ))}
              </ul>
            </div>
          )}
          {imdb && (
            <p className="film-external">
              <a href={imdb} target="_blank" rel="noopener noreferrer">
                IMDb <span aria-hidden="true">↗</span>
              </a>
            </p>
          )}
        </section>
      )}
      {!complete && <p className="sr-only" role="status">Loading the rest of this film’s details…</p>}
    </>
  );
}

function FilmStatus({ state, onBack, onRetry }: { state: ReturnType<typeof useFilm>["state"]; onBack: () => void; onRetry: () => void }) {
  if (state.phase === "loading") {
    return (
      <section className="discover-state" aria-live="polite">
        <span className="discover-spinner" aria-hidden="true" />
        <p>Loading…</p>
      </section>
    );
  }
  if (state.phase === "not_found") {
    return (
      <section className="discover-state" role="status">
        <p className="discover-state-title">This film isn’t here</p>
        <p>The link may be mistyped.</p>
        <button className="discover-retry" onClick={onBack}>
          Browse films
        </button>
      </section>
    );
  }
  if (state.phase === "ready") return null;
  const retryable = state.phase === "error" && state.retryable;
  return (
    <section className="discover-state discover-state-error" role="alert">
      <p className="discover-state-title">This film could not be loaded</p>
      <p>{state.safeMessage}</p>
      {state.phase === "error" && (
        <p className="discover-state-detail">
          Reference: <code>{state.code}</code>
        </p>
      )}
      {retryable && (
        <button className="discover-retry" onClick={onRetry}>
          Try again
        </button>
      )}
    </section>
  );
}

/** Arrows walk the page's controls in reading order, so a remote reaches every one. */
function moveFocus(event: KeyboardEvent, page: HTMLElement | null) {
  const forward = NEXT_KEYS.has(event.key);
  if (!page || (!forward && !PREVIOUS_KEYS.has(event.key))) return;
  const controls = Array.from(page.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]"));
  const current = controls.indexOf(document.activeElement as HTMLElement);
  const next = controls[current < 0 ? 0 : current + (forward ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}
