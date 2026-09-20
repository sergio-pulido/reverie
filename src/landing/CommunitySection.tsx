import { FilmFigure } from "./FilmFigure";
import type { LandingFilm } from "./films";
import { CATALOG_URL } from "./links";

/**
 * Two placeholder shorts that illustrate what the shelf holds. They are drawn as labelled
 * placeholders, never with a poster, and the section says in words that nobody made them.
 *
 * The shelf itself is real and lives in the app: the home draws it, and Catalog's source switch
 * filters to it. It cannot be read from here. `jams` is readable only by a room's host or its
 * members ("participants read their own jams"), and the build that renders this page signs in as
 * a fresh anonymous viewer (`scripts/landing-films.ts`) which hosts nothing and belongs to
 * nothing — so a landing that listed real rooms would list none, every time, however many exist.
 * Listing them would need a policy granting a wider read, which no migration creates.
 */
const ILLUSTRATIVE_SHORTS = [
  { title: "The Lamp Unlit", meta: "Short · Movie Jam" },
  { title: "Sunday, Gently", meta: "Short · Director" },
] as const;

/**
 * Made in Reverie, which is live. It used to be called Community and marked as not yet available;
 * the shelf shipped, so the section is named what the app names it and its way in is Catalog,
 * whose switch is literally the claim being made — one grid, the catalogue on one side and what
 * was made here on the other.
 */
export function CommunitySection({ real }: { real: readonly LandingFilm[] }) {
  return <section id="made" data-screen-label="Made in Reverie" className="landing-live-section landing-community">
    <div className="landing-wrap">
      <div className="landing-label landing-live">Live now · Made in Reverie</div>
      <div className="landing-community-grid">
        <h2 className="landing-display landing-section-title">What people <em>made</em>.</h2>
        <div>
          <p className="landing-copy">Films born in Director and Movie Jam sit on the same shelf as the ones Reverie reads, and never mixed in unmarked: Catalog browses two sources, the catalogue and Made in Reverie, and every card on that side says which of the three it was started as. A public room you are part of appears there as soon as there is one.</p>
          <a href={CATALOG_URL} className="landing-cta landing-cta-outline landing-cta-section">Browse Made in Reverie <span aria-hidden="true">↗</span></a>
        </div>
      </div>
      <div className="landing-film-grid" role="group" aria-label="Illustration: real catalogue films beside two placeholder shorts">
        {ILLUSTRATIVE_SHORTS.flatMap((short, index) => {
          const film = real[index];
          return [
            ...(film ? [<FilmFigure key={film.id} film={film} loading="lazy" />] : []),
            <PlaceholderShort key={short.title} title={short.title} meta={short.meta} />,
          ];
        })}
      </div>
      <p className="landing-community-note">The two dashed tiles are placeholders, not films anybody made: this page has no session, so it cannot read a room. What has actually been made here is in the app, on the home and under Catalog's second source.</p>
    </div>
  </section>;
}

function PlaceholderShort({ title, meta }: { title: string; meta: string }) {
  return <figure>
    <div className="landing-poster landing-placeholder">
      <span className="landing-placeholder-tag">Placeholder</span>
      <span className="landing-placeholder-name" aria-hidden="true">{title}</span>
    </div>
    <figcaption className="landing-film-title">{title}</figcaption>
    <div className="landing-film-meta">{meta}</div>
  </figure>;
}
