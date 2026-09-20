import { Footer } from "../chrome";
import type { ScenarioCard } from "../lib/escapeRoom";
import { TopBar } from "../shell/TopBar";

/**
 * The one door.
 *
 * Making a film alone, making one with a room, and playing an escape room are three different
 * experiences. Two of them used to be reached through a screen called Movie Jam, which said the
 * wrong thing about both: a Director session is not a jam with nobody in it, and an escape room
 * is not a way of writing a screenplay. They are offered here as three, each described by what
 * it is, and each leads into the flow it already had.
 */

export type CreateWay = "director" | "jam" | "escape";

type WayCard = { way: CreateWay; name: string; who: string; blurb: string };

const WAYS: readonly WayCard[] = [
  {
    way: "director",
    name: "Director",
    who: "Alone",
    blurb:
      "One person, one film. You talk and it answers: each finished instruction goes to the stream, and the timeline shows every beat of the film in order, saying which are still yours to change. Nobody to wait for, nobody to convince.",
  },
  {
    way: "jam",
    name: "Movie Jam",
    who: "With people",
    blurb:
      "A room shares one screenplay. Everyone in it directs a turn — in words, out loud, with a picture, or on camera — and what the room settles on becomes the next scene. The invite is the way in, and the host admits.",
  },
  {
    way: "escape",
    name: "Escape Room",
    who: "A room solves a place",
    blurb:
      "An authored world with a way out. The room shares control of one character inside it, proposes what they should do and votes; the room answers, and the film is whatever they make them do. Nothing is written in advance but the place.",
  },
];

type CreateScreenProps = {
  /** The escape rooms this server lists. Empty while they are being read, or when there are none. */
  scenarios: readonly ScenarioCard[];
  /** Set when the escape rooms could not be listed at all: this build has no server for them. */
  scenariosNotice: string | null;
  onChoose: (way: CreateWay) => void;
};

/**
 * The escape room's routes are the local Node server's, so a deployment without that server
 * lists no rooms. The card then says so and cannot be chosen; the other two are unaffected,
 * because neither needs those routes.
 */
function escapeUnavailable(scenarios: readonly ScenarioCard[], notice: string | null): string | null {
  if (notice) return `Escape rooms are not available here. ${notice} They run on Reverie's own Node server, which this deployment does not have.`;
  return scenarios.length === 0 ? "Looking for the rooms this server ships…" : null;
}

export function CreateScreen({ scenarios, scenariosNotice, onChoose }: CreateScreenProps) {
  const unavailable = escapeUnavailable(scenarios, scenariosNotice);
  const stillLooking = unavailable !== null && scenariosNotice === null;

  return (
    <main className="site-shell create-shell">
      <TopBar current="create" />
      <section className="create-layout">
        <header className="create-head">
          <p className="eyebrow">MAKE SOMETHING</p>
          <h1>
            Three ways to make a <em>film</em>.
          </h1>
          <p className="intro">
            They are not the same thing, so pick the one you are actually doing. Each opens the
            flow it belongs to.
          </p>
        </header>

        <ul className="create-ways">
          {WAYS.map((card) => {
            const blocked = card.way === "escape" && unavailable !== null;
            return (
              <li key={card.way}>
                <article className={`create-way${blocked ? " create-way-blocked" : ""}`}>
                  <p className="eyebrow">{card.who}</p>
                  <h2>{card.name}</h2>
                  <p className="create-way-blurb">{card.blurb}</p>
                  {blocked ? (
                    <p className="create-way-notice" role="status">
                      {unavailable}
                    </p>
                  ) : (
                    <button
                      className="button button-primary"
                      onClick={() => onChoose(card.way)}
                      aria-label={`${card.name}: ${card.who.toLowerCase()}`}
                    >
                      Start<span>↗</span>
                    </button>
                  )}
                </article>
              </li>
            );
          })}
        </ul>

        {unavailable !== null && !stillLooking && (
          <p className="create-note">
            Director and Movie Jam are unaffected: neither needs those routes.
          </p>
        )}
      </section>
      <Footer />
    </main>
  );
}
