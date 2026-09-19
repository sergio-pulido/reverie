import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const screen = readFileSync(new URL("../src/discover/DiscoverScreen.tsx", import.meta.url), "utf8");

/** The visible text of the Discover header: the bar and the intro above the search. */
function headerText() {
  const start = screen.indexOf('<header className="discover-bar">');
  const end = screen.indexOf('<input', start);
  assert.ok(start > 0 && end > start, "the header is where it is expected");
  return screen
    .slice(start, end)
    .replace(/<[^>]*>/g, " ")
    .replace(/\{[^}]*\}/g, " ");
}

test("the Discover header speaks to a viewer, not about the data behind it", () => {
  const text = headerText();
  for (const word of ["TMDB", "real", "curated", "catalogue", "generated", "does not", "never"]) {
    assert.equal(new RegExp(`\\b${word}\\b`, "i").test(text), false, `the header does not mention "${word}"`);
  }
  assert.match(text, /What are we watching/);
});

test("the header has at most one supporting line", () => {
  const intro = screen.slice(screen.indexOf('<div className="discover-intro">'), screen.indexOf('<label className="discover-search">'));
  assert.equal((intro.match(/<p\b/g) ?? []).length, 1);
});

test("Discover has no page control: the grid grows instead", () => {
  assert.equal(/discover-pager|← Previous|Next →|Page \{/.test(screen), false);
});

test("the TMDB attribution is still shown whenever films are", () => {
  assert.match(screen, /className="discover-attribution"/);
});
