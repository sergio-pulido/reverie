import { JAM_URL } from "./links";

/** A voice note drawn as bars: [height in px, shade]. Decorative. */
const WAVE: ReadonlyArray<readonly [number, "low" | "mid" | "high"]> = [
  [8, "low"], [16, "mid"], [22, "high"], [12, "mid"], [18, "high"],
  [7, "low"], [14, "mid"], [20, "high"], [9, "low"], [15, "mid"],
];

const WAVE_SHADE = { low: "var(--landing-muted-4)", mid: "var(--landing-muted-3)", high: "var(--landing-accent)" } as const;

/** Movie Jam, which is live. The room on the right is an illustration of one. */
export function JamSection() {
  return <section id="jam" data-screen-label="Movie Jam" className="landing-live-section">
    <div className="landing-wrap">
      <div className="landing-label landing-live">Live now · Movie Jam</div>
      <div className="landing-jam-grid">
        <div>
          <h2 className="landing-display landing-section-title">Start a room. Everyone takes a <em>turn</em>.</h2>
          <p className="landing-copy">Share an invite. Each person adds a turn: a line of text, a voice note, an image, a clip, or their live camera. The turns become a real screenplay, scene by scene, and the room watches it evolve. The room decides what the story becomes. Not one person.</p>
          <a href={JAM_URL} className="landing-cta landing-cta-outline landing-cta-section">Start a Movie Jam <span aria-hidden="true">↗</span></a>
        </div>
        <RoomIllustration />
      </div>
    </div>
  </section>;
}

function RoomIllustration() {
  return <div className="landing-panel landing-room" role="group" aria-label="Illustration of a Movie Jam room">
    <div className="landing-room-head">
      <span className="landing-label">Room · Saturday, late</span>
      <span className="landing-room-count">4 in the room</span>
    </div>
    <ul className="landing-turns">
      <li className="landing-turn">
        <div className="landing-avatar" aria-hidden="true">M</div>
        <div>
          <div className="landing-turn-head"><span className="landing-turn-name">Marta</span><span className="landing-turn-kind">Text</span></div>
          <p className="landing-turn-text">A lighthouse keeper who has never seen the sea at night.</p>
        </div>
      </li>
      <li className="landing-turn">
        <div className="landing-avatar" aria-hidden="true">J</div>
        <div>
          <div className="landing-turn-head"><span className="landing-turn-name">Joan</span><span className="landing-turn-kind">Voice · 0:14</span></div>
          <div className="landing-wave" aria-hidden="true">{WAVE.map(([height, shade], index) => <span key={index} style={{ height, background: WAVE_SHADE[shade] }} />)}</div>
        </div>
      </li>
      <li className="landing-turn">
        <div className="landing-avatar" aria-hidden="true">A</div>
        <div>
          <div className="landing-turn-head"><span className="landing-turn-name">Aina</span><span className="landing-turn-kind">Live camera</span></div>
          <div className="landing-camera" aria-hidden="true" />
        </div>
      </li>
    </ul>
    <div className="landing-scene">
      <div className="landing-turn-kind">Screenplay · Scene 3 · evolving</div>
      <p className="landing-scene-text">INT. LIGHTHOUSE — NIGHT. Nuria climbs with the lamp unlit. Below, a voice she doesn't recognise asks the sea to wait.</p>
    </div>
  </div>;
}
