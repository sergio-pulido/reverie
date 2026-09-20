import { Footer } from "../chrome";
import { TopBar } from "../shell/TopBar";

/**
 * What Reverie is, what it is built on, and who built it.
 *
 * Two lists, and the difference between them is the whole point. "What it is built on" is the
 * services this repository calls, each line named from the code that calls it. "The challenges
 * that shaped this" is sponsors who set a brief rather than handing over an API, and nothing in
 * it is a service Reverie talks to. Neither list may claim a capability that is not wired up.
 *
 * It is reached from the footer and the account menu, never from the bar: the bar carries the
 * places you work, and this is read once.
 */

type Provider = { name: string; role: string; detail: string };

/**
 * The providers this build talks to, each described from the code that calls it:
 * `src/lib/supabase.ts` and the migrations, `apps/server/providers/*`, `api/_lib/vonage-video.ts`,
 * `api/_lib/supabase-catalogue.ts`, `apps/backfill/accessibility/opensubtitles.ts`,
 * `apps/backfill/accessibility/adp.ts`, and — for the one that calls us — `api/evaluate.ts` with
 * `api/_lib/evaluate-funnel.ts`.
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
      "Video generation. A beat of the film is generated with h3-max/text-to-video, or with h3-max/reference-to-video when people in the room have agreed to appear in it. A Director session can use the realtime H3 Director model instead — a video stream you talk to while it runs — where a server is configured and enabled for it: it holds a long-lived connection, so it belongs to Reverie's own Node server and cannot run on a serverless deployment. A session says so rather than pretending when its server has neither. Every model is on a server-owned allowlist and every generation draws on one declared budget.",
  },
  {
    name: "TMDB",
    role: "The catalogue",
    detail:
      "The films you browse in Discover and Catalog, and the posters and backdrops on them. Reverie uses TMDB data and is not endorsed or certified by TMDB; the credit is at the foot of every screen that shows a record from it.",
  },
  {
    name: "OpenSubtitles",
    role: "What a film comes subtitled in",
    detail:
      "Subtitle availability, as metadata and nothing else. An offline backfill asks the REST API's /features endpoint once per film, keyed by that film's IMDb id, and keeps the per-language counts it answers with — that is the Subtitles line on a film's page. The client is built to reach /features and no other endpoint, so it can never spend a download or read a line of subtitle text, and a film the index does not hold is left unanswered rather than recorded as having none.",
  },
  {
    name: "Audio Description Project",
    role: "Which films are described",
    detail:
      "The American Council of the Blind's Film and Series Title Directory, and the Audio description line on a film's page. It publishes no API and no export, so the same offline backfill reads the public directory itself — one page every three seconds, under a named user agent — and joins it to the catalogue on the IMDb id each row links to, never on a title. A listed film is a sourced yes. An unlisted one is unknown, not a no: the directory is curated and US-centred, so nothing here ever writes that a film has no audio description.",
  },
  {
    name: "Galtea",
    role: "The one that calls us",
    detail:
      "Evaluation of the Discover funnel, and the only provider whose traffic runs the other way: a Galtea endpoint connection calls this deployment rather than the other way round. POST /api/evaluate runs interpret, catalogue, rank and critique for one message through the same modules the three Discover endpoints call, and answers with what the viewer would have seen. It authenticates with one static token held in the environment and compared over SHA-256 digests, so neither the value nor its length leaks through how long the check takes; a viewer's Supabase session is never accepted there, and the token is never logged or echoed back. With no token configured the endpoint is closed rather than open.",
  },
];

type Challenge = { name: string; asked: string; answer: string };

/**
 * Sponsors whose challenge shaped this build without an API behind it. Nothing here is a service
 * Reverie calls; a sponsor whose API we call is in `PROVIDERS` instead.
 *
 * A line here has to name something in this repository that answers the brief, which is what
 * keeps the list short. A sponsor is moved OUT of this list the moment an integration exists:
 * Galtea was here while `docs/GALTEA_AGENT_SPEC.md` was all there was, and is in `PROVIDERS` now
 * that `api/evaluate.ts` is deployed and a Galtea endpoint connection points at it.
 */
const CHALLENGES: readonly Challenge[] = [
  {
    name: "Titan OS",
    asked:
      "Build it for a television, and take the film catalogue from the Kaggle TMDB dataset: the challenge names that dataset as the source and supplies no catalogue API.",
    answer:
      "The shell is ten-foot throughout — large type, poster shelves, and a top bar of five destinations that still fits a 360px set. A remote drives every screen on one axis convention, Up and Down between rows and Left and Right inside one, and Back is recognised under each name a television browser gives it, down to the bare key codes some sets send instead of a name. The catalogue is that dataset, loaded into Postgres as `public.catalogue_titles` and read from there; the adapter that reads it records in its own comment that there is no Titan API to call.",
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
            watch, and never mixed in unmarked: it is its own source in Catalog and its own row on the home,
            and every card there says which of the three it was started as. That is what keeps the shelf honest.
          </p>
        </header>

        <section className="about-section" aria-labelledby="about-providers">
          <h2 id="about-providers">What it is built on</h2>
          <p className="about-note">
            Nine services this build is wired to, each behind typed code that validates what crosses the
            boundary. Six are called while the app runs. OpenSubtitles and the Audio Description Project are
            read only by an offline backfill, and what they answered is in the catalogue rows you read.
            Galtea is the one that calls us. What each one does here is what the code actually asks it for,
            or answers it with — no more.
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

        <section className="about-section about-challenges-section" aria-labelledby="about-challenges">
          <h2 id="about-challenges">The challenges that shaped this</h2>
          <p className="about-note">
            Not integrations. These sponsors set us a brief rather than handing over an API, and Reverie
            calls nothing of theirs — there is no code in this repository that talks to them. Each line
            names what the brief asked for and the thing in Reverie that answers it.
          </p>
          <ul className="about-challenges">
            {CHALLENGES.map((challenge) => (
              <li key={challenge.name}>
                <p className="about-challenge-tag">Challenge · nothing integrated</p>
                <h3>{challenge.name}</h3>
                <p className="about-challenge-label">What it asked for</p>
                <p className="about-challenge-text">{challenge.asked}</p>
                <p className="about-challenge-label">What answers it in Reverie</p>
                <p className="about-challenge-text">{challenge.answer}</p>
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
