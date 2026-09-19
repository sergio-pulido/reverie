import { CommunitySection } from "./CommunitySection";
import { DiscoverSection } from "./DiscoverSection";
import { FilmFigure } from "./FilmFigure";
import type { LandingFilm, LandingFilms } from "./films";
import { JamSection } from "./JamSection";
import { APP_URL, JAM_URL } from "./links";

/** The same wording the catalogue carries on every record. Required by TMDB's terms. */
const TMDB_ATTRIBUTION =
  "Film data and images from TMDB (themoviedb.org). This product uses TMDB data but is not endorsed or certified by TMDB.";

const LOOP: ReadonlyArray<{ step: string; live: boolean; name: string; line: string }> = [
  { step: "01", live: false, name: "Director", line: "Make one yourself." },
  { step: "02", live: true, name: "Movie Jam", line: "Make one together, live." },
  { step: "03", live: false, name: "Community", line: "What people made becomes catalogue." },
  { step: "04", live: true, name: "Discover", line: "Catalogue is what you browse. Back to 01." },
];

/**
 * The public front door at `/`. Discover and Movie Jam are live and are the only places its
 * calls to action lead; Director and Community are marked as next and have no button. The
 * films are real catalogue titles, read when the app is built.
 *
 * Pure markup with no state or effects: the build renders it to static HTML, and it needs no
 * script to work. Its styles come from `landing.css`, which the caller loads.
 */
export function LandingPage({ films }: { films: LandingFilms }) {
  return <div className="landing">
    <LandingHeader />
    <main id="top">
      <Hero shelf={films.shelf} />
      <Director />
      <JamSection />
      <DiscoverSection picks={films.picks} />
      <CommunitySection real={films.community} />
      <Loop />
      <Close />
    </main>
    <LandingFooter />
  </div>;
}

function Brand() {
  return <><span className="landing-brand-mark" aria-hidden="true">✳</span><span>REVERIE</span></>;
}

function LandingHeader() {
  return <header className="landing-header">
    <div className="landing-bar">
      <a href="#top" className="landing-brand" aria-label="Reverie, back to the top"><Brand /></a>
      <nav className="landing-nav" aria-label="Reverie">
        <a href="#discover" className="landing-label landing-nav-link">Discover</a>
        <a href={APP_URL} className="landing-cta landing-cta-primary landing-cta-header">Open Reverie <span aria-hidden="true">↗</span></a>
      </nav>
    </div>
  </header>;
}

function Hero({ shelf }: { shelf: readonly LandingFilm[] }) {
  return <section data-screen-label="Hero" className="landing-hero">
    <div className="landing-wrap">
      <p className="landing-label">Cinema you can watch. Cinema you can make.</p>
      <h1 className="landing-display landing-hero-title">Tonight, <em>make</em> a film.</h1>
      <p className="landing-hero-lede">Alone, or live with the people in the room. Then watch it on the same shelf as 27,839 real ones. What you watch and what you make are the same thing.</p>
      <div className="landing-hero-actions">
        <a href={APP_URL} className="landing-cta landing-cta-primary landing-cta-hero">Open Reverie <span aria-hidden="true">↗</span></a>
        <a href={JAM_URL} className="landing-cta landing-cta-outline landing-cta-hero">Start a Movie Jam</a>
      </div>
      <p className="landing-hero-note">Free. Opens in your browser. Nothing to install.</p>
    </div>
    {shelf.length > 0 && <div className="landing-shelf-fade">
      <div className="landing-shelf" tabIndex={0} role="region" aria-label="Films in the catalogue">
        {shelf.map((film) => <FilmFigure key={film.id} film={film} loading="eager" className="landing-shelf-film" />)}
      </div>
    </div>}
  </section>;
}

function Director() {
  return <section data-screen-label="Director (next)" className="landing-director">
    <div className="landing-wrap">
      <div className="landing-next-card">
        <div>
          <div className="landing-next-tags">
            <span className="landing-label landing-next-badge">Next · not yet available</span>
            <span className="landing-label">Director</span>
          </div>
          <h2 className="landing-display landing-next-title">Make one <em>alone</em>.</h2>
        </div>
        <p className="landing-next-copy">Creative turns, by yourself. The same screenplay, the same scenes, no one to wait for. This is the way in when there is nobody around to gather. Director is being built now; Movie Jam, below, is how you make a film today.</p>
      </div>
    </div>
  </section>;
}

function Loop() {
  return <section data-screen-label="The loop" className="landing-loop">
    <div className="landing-wrap">
      <h2 className="landing-display landing-loop-title">The thing you <em>watch</em> and the thing you <em>make</em> are the same thing.</h2>
      <ol className="landing-loop-steps">
        {LOOP.map((item) => <li key={item.step} className="landing-loop-step">
          <span className={`landing-label${item.live ? " landing-label-live" : ""}`}>{item.step} · {item.live ? "Live" : "Next"}</span>
          <span className="landing-loop-name">{item.name}</span>
          <span className="landing-loop-line">{item.line}</span>
        </li>)}
      </ol>
    </div>
  </section>;
}

function Close() {
  return <section data-screen-label="Final CTA" className="landing-close">
    <div className="landing-wrap">
      <div>
        <p className="landing-label">Built over one weekend · Barcelona</p>
        <h2 className="landing-display landing-close-title">What are we <em>making</em> tonight?</h2>
      </div>
      <div>
        <a href={APP_URL} className="landing-cta landing-cta-primary landing-cta-close">Open Reverie <span aria-hidden="true">↗</span></a>
        <p className="landing-close-note">Discover and Movie Jam are open today. Director and Community are next, and are not available yet.</p>
      </div>
    </div>
  </section>;
}

function LandingFooter() {
  return <footer className="landing-footer">
    <div className="landing-footer-bar">
      <div className="landing-footer-brand"><Brand /></div>
      <div className="landing-attribution">
        <span className="landing-tmdb">TMDB</span>
        <p>{TMDB_ATTRIBUTION}</p>
      </div>
    </div>
  </footer>;
}
