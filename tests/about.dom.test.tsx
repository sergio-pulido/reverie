import { cleanup, click, focused, press, render } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { App } from "../src/App";
import { CatalogueReadProvider } from "../src/discover/CatalogueReadContext";
import { liveTopBar } from "../src/shell/topBarFocus";
import { fakeCatalogue } from "./catalogueFake";

afterEach(cleanup);

/** Every service this build is wired to. The page names all nine or it is incomplete. */
const PROVIDERS = [
  "Supabase",
  "Nebius",
  "SLNG",
  "Vonage",
  "fal, with MiniMax H3",
  "TMDB",
  "OpenSubtitles",
  "Audio Description Project",
  "Galtea",
];

/** Sponsors who set a brief rather than supplying an API, and what each one is answered by. */
const CHALLENGES = ["Titan OS"];

async function open(path: string) {
  const catalogue = fakeCatalogue();
  await render(<CatalogueReadProvider read={catalogue.read}><App /></CatalogueReadProvider>, path);
  return catalogue;
}

const heading = () => document.querySelector("h1")?.textContent ?? "";
const pageText = () => document.querySelector(".about-layout")?.textContent ?? "";
const sectionText = (selector: string) => document.querySelector(selector)?.textContent ?? "";

describe("/about", () => {
  it("says what Reverie is, names every provider and who built it, and reads nothing", async () => {
    const catalogue = await open("/about");
    assert.match(heading(), /watch/i, "it opens with what Reverie is");
    for (const provider of PROVIDERS) {
      assert.ok(pageText().includes(provider), `${provider} is named`);
    }
    for (const builder of ["Ramon Amela", "Sergio Pulido"]) {
      assert.ok(pageText().includes(builder), `${builder} is credited`);
    }
    assert.match(pageText(), /HackBarna 2026/, "where it was made");
    assert.deepEqual(catalogue.requests, [], "About reads no catalogue");
  });

  it("keeps the challenges apart from the providers, and says they are not integrations", async () => {
    await open("/about");
    const names = (selector: string) =>
      Array.from(document.querySelectorAll(`${selector} h3`)).map((node) => node.textContent);

    // Each list names its own, and nothing is named in both. Prose is not tested for a name: the
    // Titan brief names the TMDB dataset it supplies instead of an API, which is the point of it.
    assert.deepEqual(names(".about-providers"), PROVIDERS);
    assert.deepEqual(names(".about-challenges"), CHALLENGES);
    assert.equal(sectionText(".about-challenges").includes("Supabase"), false);

    // The section says what it is before any of its cards are read, and every card repeats it.
    const section = document.querySelector(".about-challenges-section")!;
    assert.match(section.querySelector("h2")!.textContent!, /challenges/i);
    assert.match(section.querySelector(".about-note")!.textContent!, /Not integrations/);
    const tags = Array.from(section.querySelectorAll(".about-challenge-tag"));
    assert.equal(tags.length, CHALLENGES.length);
    for (const tag of tags) assert.match(tag.textContent!, /nothing integrated/i);

    // Each challenge says what it asked for and what answers it, not one blur of prose.
    for (const card of Array.from(section.querySelectorAll<HTMLLIElement>("li"))) {
      const labels = Array.from(card.querySelectorAll(".about-challenge-label")).map((node) => node.textContent);
      assert.deepEqual(labels, ["What it asked for", "What answers it in Reverie"]);
    }
  });

  it("does not claim made work is labelled 'generated': nothing in the app labels it that", async () => {
    await open("/about");
    // Made work carries the kind it was started as (Movie Jam, Director, Escape Room) under its own
    // source in Catalog and its own row on the home. No screen tags it "generated".
    assert.doesNotMatch(pageText(), /labelled as generated/i);
    assert.match(pageText(), /never mixed in unmarked/);
  });

  it("puts Galtea among the services and not among the challenges, now that it is wired up", async () => {
    await open("/about");
    // It was in neither list while `docs/GALTEA_AGENT_SPEC.md` was all there was. `POST /api/evaluate`
    // is deployed and a Galtea endpoint connection calls it, so it is an integration like the rest.
    const providers = sectionText(".about-providers");
    assert.ok(providers.includes("Galtea"), "Galtea is one of the services");
    assert.equal(sectionText(".about-challenges").includes("Galtea"), false, "and not a challenge");
    // The direction is stated, because it is the one that calls us rather than the other way round.
    assert.match(providers, /the only provider whose traffic runs the other way/);
    // No sponsor may be named without something in this repository to point at.
    assert.match(providers, /\/api\/evaluate/);
  });

  it("is not a destination: it carries the bar with nothing on it marked", async () => {
    await open("/about");
    const bar = liveTopBar();
    assert.ok(bar, "the shared top bar is on the screen");
    assert.equal(bar!.querySelector('[aria-current="page"]'), null, "no destination claims it");
    const labels = Array.from(bar!.querySelectorAll<HTMLAnchorElement>("a[data-top-bar-item]")).map((link) => link.textContent?.trim());
    assert.equal(labels.includes("About"), false, "and it is not on the bar");
    assert.equal(labels.includes("About Reverie"), false);
  });

  it("lands a remote on its bar, and Back climbs to the home", async () => {
    await open("/about");
    assert.equal(focused().closest("[data-top-bar]"), liveTopBar());
    assert.equal(await press("Escape"), true);
    assert.equal(window.location.pathname, "/home");
  });

  it("is reached from the page's own footer", async () => {
    await open("/jams");
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>("footer a")).find((anchor) => anchor.textContent === "About Reverie");
    assert.ok(link, "the footer carries it");
    assert.equal(link!.getAttribute("href"), "/about");
    await click(link!);
    assert.equal(window.location.pathname, "/about");
    assert.ok(document.querySelector(".about-layout"), "and the screen is showing");
  });
});
