import { Footer } from "../chrome";
import { TopBar } from "../shell/TopBar";

/**
 * What Reverie is, what it is built on, and who built it.
 *
 * Every provider line below says what this repository actually calls it for, named from the
 * adapters themselves; nothing here claims a capability that is not wired up. It is reached
 * from the footer and the account menu, never from the bar: the bar carries the places you
 * work, and this is read once.
 */

type Provider = { name: string; role: string; detail: string };

/**
 * The providers this build talks to, each described from the code that calls it:
 * `src/lib/supabase.ts` and the migrations, `apps/server/providers/*`, `api/_lib/vonage-video.ts`
 * and `api/_lib/supabase-catalogue.ts`.
 */
const PROVIDERS: readonly Provider[] = [
  {
    name: "Supabase",
    role: "The room, and who is in it",
    detail:
      "Postgres, anonymous sign-in and row-level security hold every jam, its members, its messages and proposals, and the consent register for appearing in a film. Realtime carries the durable changes to everyone in the room. The film catalogue is a table here too, and generated media lives in private buckets only the server can reach.",
  },
  {
    name: "Nebius",
    role: "The words",
    detail:
      "The language model behind the writing. It drafts a jam's screenplay to its time format, narrates what an escape room does with the action the room voted for, and answers in Discover — where it is only ever allowed to reorder a shortlist the database already filtered, so it cannot name a film that is not there.",
  },
  {
    name: "SLNG",
    role: "The listening",
    detail:
      "Speech to text. Holding the microphone in Discover or in a Director session sends the recording to SLNG and gets a transcript back, which lands in the field for you to send. The audio is forwarded in memory and never written or kept.",
  },
  {
    name: "Vonage",
    role: "The live room",
    detail:
      "The Video API behind the live stage: a session per jam and a short-lived connection token per participant, so camera, microphone and screen can be published into a room by the people in it.",
  },
  {
    name: "fal, with MiniMax H3",
    role: "The pictures",
    detail:
      "Video generation. A beat of the film is generated with h3-max/text-to-video, or with h3-max/reference-to-video when people in the room have agreed to appear in it. A Director session is the realtime H3 Director model instead: a video stream you talk to while it runs. Every model is on a server-owned allowlist.",
  },
  {
    name: "TMDB",
    role: "The catalogue",
    detail:
      "The films you browse in Discover and Catalog, and the posters and backdrops on them. Reverie uses TMDB data and is not endorsed or certified by TMDB; the credit is at the foot of every screen that shows a record from it.",
  },
];

/** Drawn from the repository's own history: the areas of it each person's commits built. */
const BUILDERS: readonly { name: string; work: string }[] = [
  {
    name: "Ramon Amela",
    work: "The Node server and its routes, the core rules and state machines, the escape room, and the provider adapters.",
  },
  {
    name: "Sergio Pulido",
    work: "Discover, Search and Catalog, the shared shell and top bar, Director, and the catalogue snapshot.",
  },
];

export function AboutScreen() {
  return (
    <main className="site-shell about-shell">
      <TopBar current={null} />
      <section className="about-layout">
        <header className="about-head">
          <p className="eyebrow">ABOUT</p>
          <h1>
            What you watch and what you <em>make</em> are the same thing.
          </h1>
          <p className="intro">
            Reverie is one place for both. You browse a real film catalogue and talk to it in plain language
            until it hands you a few titles worth your evening. And you make films of your own — alone as a
            Director, live with the people in the room as a Movie Jam, or by taking a room into an authored
            escape room and seeing what it does. What gets made lands on the same shelf as what you came to
            watch, labelled as generated, which is the only thing keeping the shelf honest.
          </p>
        </header>

        <section className="about-section" aria-labelledby="about-providers">
          <h2 id="about-providers">What it is built on</h2>
          <p className="about-note">
            Six providers, each behind a typed adapter. What each one does here is what the code actually
            asks it for — no more.
          </p>
          <ul className="about-providers">
            {PROVIDERS.map((provider) => (
              <li key={provider.name}>
                <h3>{provider.name}</h3>
                <p className="about-provider-role">{provider.role}</p>
                <p className="about-provider-detail">{provider.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="about-section" aria-labelledby="about-builders">
          <h2 id="about-builders">Who built it</h2>
          <ul className="about-builders">
            {BUILDERS.map((builder) => (
              <li key={builder.name}>
                <h3>{builder.name}</h3>
                <p>{builder.work}</p>
              </li>
            ))}
          </ul>
          <p className="about-note">
            Made at HackBarna 2026, in Barcelona. Everything in it was written for this repository.
          </p>
        </section>
      </section>
      <Footer />
    </main>
  );
}
