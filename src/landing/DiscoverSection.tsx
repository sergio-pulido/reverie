import { FilmFigure } from "./FilmFigure";
import type { LandingFilm } from "./films";
import { DISCOVER_URL } from "./links";

/** The illustration marks its first two films as top picks. */
const TOP_PICKS = 2;

const CONVERSATION: ReadonlyArray<{ from: "viewer" | "reverie"; text: string }> = [
  { from: "viewer", text: "something quiet for a sunday night" },
  { from: "reverie", text: "Quiet as in slow and gentle, or quiet as in eerie?" },
  { from: "viewer", text: "gentle" },
];

/** Discover, which is live. The conversation is an illustration; the films in it are real. */
export function DiscoverSection({ picks }: { picks: readonly LandingFilm[] }) {
  return <section id="discover" data-screen-label="Discover" className="landing-live-section">
    <div className="landing-wrap">
      <div className="landing-label landing-live">Live now · Discover</div>
      <h2 className="landing-display landing-section-title landing-discover-title">Say what you feel like. Get a <em>handful</em>, not a wall.</h2>
      <div className="landing-discover-grid">
        <p className="landing-copy">27,839 films. You talk to it in plain language. When you are vague, it asks one question, then narrows the shelf to a few. Built for a television: large type, poster shelves, a remote in your hand.</p>
        <div>
          <div className="landing-label landing-trust-label">Discovery you can trust</div>
          <p className="landing-copy landing-trust-copy">The catalogue is filtered in the database first. The model is only allowed to reorder the shortlist it is handed. It cannot name a film that is not there, so it never invents one.</p>
        </div>
      </div>

      <div className="landing-panel landing-talk" role="group" aria-label="Illustration of a conversation with Discover">
        <ul className="landing-bubbles">
          {CONVERSATION.map((line) => <li key={line.text} className={`landing-bubble landing-bubble-${line.from}`}>{line.text}</li>)}
        </ul>
        <div className="landing-chips">
          <span className="landing-label">4 titles match</span>
          <span className="landing-chip">Drama ×</span>
          <span className="landing-chip">Gentle ×</span>
          <span className="landing-chip landing-chip-quiet">Start over</span>
        </div>
        {picks.length > 0 && <div className="landing-film-grid">
          {picks.map((film, index) => <FilmFigure
            key={film.id}
            film={film}
            loading="lazy"
            badge={index < TOP_PICKS ? <span className="landing-top-pick">Top pick</span> : undefined}
          />)}
        </div>}
      </div>
      <div className="landing-discover-cta">
        <a href={DISCOVER_URL} className="landing-cta landing-cta-outline landing-cta-section">Ask it what to watch <span aria-hidden="true">↗</span></a>
      </div>
    </div>
  </section>;
}
