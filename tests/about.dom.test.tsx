import { cleanup, click, focused, press, render } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { App } from "../src/App";
import { CatalogueReadProvider } from "../src/discover/CatalogueReadContext";
import { liveTopBar } from "../src/shell/topBarFocus";
import { fakeCatalogue } from "./catalogueFake";

afterEach(cleanup);

/** Every provider this build actually talks to. The page names all six or it is incomplete. */
const PROVIDERS = ["Supabase", "Nebius", "SLNG", "Vonage", "fal, with MiniMax H3", "TMDB"];

async function open(path: string) {
  const catalogue = fakeCatalogue();
  await render(<CatalogueReadProvider read={catalogue.read}><App /></CatalogueReadProvider>, path);
  return catalogue;
}

const heading = () => document.querySelector("h1")?.textContent ?? "";
const pageText = () => document.querySelector(".about-layout")?.textContent ?? "";

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
