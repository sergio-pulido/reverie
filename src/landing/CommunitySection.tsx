import { FilmFigure } from "./FilmFigure";
import type { LandingFilm } from "./films";

/**
 * Two invented shorts that show what Community would hold. Community does not exist yet, so
 * nobody made these: each is drawn as a labelled placeholder, never with a poster, and always
 * carries the "Generated" tag.
 */
const ILLUSTRATIVE_SHORTS = [
  { title: "The Lamp Unlit", meta: "Short · Movie Jam" },
  { title: "Sunday, Gently", meta: "Short · Director" },
] as const;

/** Community, which is next and not available. It has no button. */
export function CommunitySection({ real }: { real: readonly LandingFilm[] }) {
  return <section data-screen-label="Community (next)" className="landing-community">
    <div className="landing-wrap">
      <div className="landing-next-card">
        <div className="landing-next-tags">
          <span className="landing-label landing-next-badge">Next · not yet available</span>
          <span className="landing-label">Community</span>
        </div>
        <div className="landing-community-grid">
          <h2 className="landing-display landing-next-title">What people <em>made</em>.</h2>
          <p className="landing-next-copy">Independent films and shorts, born in Director and Movie Jam, on the same shelf as everything else. Always labelled as generated; that label is what keeps the catalogue honest. The ones that hold up join the catalogue Discover browses.</p>
        </div>
        <div className="landing-film-grid" role="group" aria-label="Illustration: real catalogue films beside generated shorts">
          {ILLUSTRATIVE_SHORTS.flatMap((short, index) => {
            const film = real[index];
            return [
              ...(film ? [<FilmFigure key={film.id} film={film} loading="lazy" />] : []),
              <GeneratedShort key={short.title} title={short.title} meta={short.meta} />,
            ];
          })}
        </div>
      </div>
    </div>
  </section>;
}

function GeneratedShort({ title, meta }: { title: string; meta: string }) {
  return <figure>
    <div className="landing-poster landing-generated">
      <span className="landing-generated-tag">Generated</span>
      <span className="landing-generated-name" aria-hidden="true">{title}</span>
    </div>
    <figcaption className="landing-film-title">{title}</figcaption>
    <div className="landing-film-meta">{meta}</div>
  </figure>;
}
