import { intersect } from "./dom";
import { cleanup, click, focusOn, focused, press, render, settle } from "./render";
import assert from "node:assert/strict";
import { act } from "react";
import { afterEach, describe, it } from "node:test";
import { App } from "../src/App";
import { CatalogueReadProvider } from "../src/discover/CatalogueReadContext";
import { liveTopBar } from "../src/shell/topBarFocus";
import { fakeCatalogue } from "./catalogueFake";

afterEach(cleanup);

/**
 * `/catalog`: browsing the catalogue and nothing else. What these pin is that the screen reads
 * pages, grows by them, narrows by chip, opens a film as a layer over itself, and carries no
 * conversation and no voice.
 */

/** The catalogue's own debounce before a typed query is read. */
const DEBOUNCE_MS = 320;

async function openCatalog(at = "/catalog") {
  const catalogue = fakeCatalogue();
  await render(<CatalogueReadProvider read={catalogue.read}><App /></CatalogueReadProvider>, at);
  return catalogue;
}

const screen = () => {
  const main = document.querySelector<HTMLElement>(".catalog-shell");
  assert.ok(main, "the catalogue is on screen");
  return main;
};
const field = () => {
  const input = screen().querySelector<HTMLInputElement>('.catalog-search input[type="search"]');
  assert.ok(input, "the catalogue's search field is on screen");
  return input;
};
const posters = () => Array.from(screen().querySelectorAll<HTMLButtonElement>(".catalog-card"));
const titles = () => posters().map((card) => card.querySelector(".catalog-card-title")?.textContent);
const chip = (sentence: string) => {
  const found = Array.from(screen().querySelectorAll<HTMLButtonElement>(".catalog-chip")).find((button) => button.textContent?.startsWith(sentence));
  assert.ok(found, `the chip "${sentence}" is on screen`);
  return found;
};
const asked = (catalogue: ReturnType<typeof fakeCatalogue>) =>
  catalogue.requests.map(({ query, page, pageSize, filters }) => ({ query, page, pageSize, filters }));

/** Types into a field the way a keyboard does, then waits out the catalogue's debounce. */
async function type(text: string) {
  const input = field();
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 40));
  });
  await settle();
}

describe("the catalogue", () => {
  it("opens on the first page of films, with the TMDB attribution under them", async () => {
    const catalogue = await openCatalog();
    assert.deepEqual(asked(catalogue), [{ query: "", page: 1, pageSize: 24, filters: null }]);
    assert.equal(posters().length, 24);
    assert.equal(titles()[0], "Shortlisted 0");
    assert.match(document.querySelector(".discover-attribution")?.textContent ?? "", /TMDB/);
  });

  it("is browsing only: one field, no conversation and no voice", async () => {
    await openCatalog();
    const inputs = Array.from(screen().querySelectorAll("input"));
    assert.equal(inputs.length, 1, "the title search is the only field");
    assert.equal(inputs[0].type, "search");
    assert.equal(screen().querySelector('[class*="voice"], [class*="talk"], [class*="composer"]'), null);
    const send = Array.from(screen().querySelectorAll("button")).find((button) => /^(send|ask|speak)/i.test(button.textContent ?? ""));
    assert.equal(send, undefined, "nothing on the screen sends a message");
  });

  it("walks from the bar to the field, the chips and the grid, and Back returns to the bar", async () => {
    await openCatalog();
    assert.equal(focused().textContent, "Catalog", "a remote lands on the bar's current destination");

    await press("ArrowDown");
    assert.equal(focused().textContent, "The catalogue", "the source switch is the first thing under the bar");
    await press("ArrowDown");
    assert.equal(focused(), field());
    await press("ArrowUp");
    assert.equal(focused().textContent, "The catalogue", "and Up from the field returns to it");
    await press("ArrowDown");
    await press("ArrowDown");
    assert.equal(focused(), chip("Something scary"));
    await press("ArrowRight");
    assert.equal(focused(), chip("Make me laugh"));
    await press("ArrowDown");
    assert.equal(focused(), posters()[0]);
    await press("ArrowRight");
    assert.equal(focused(), posters()[1]);

    await press("Escape");
    assert.equal(focused().closest("[data-top-bar]"), liveTopBar());
  });

  it("reads the catalogue again for a typed title", async () => {
    const catalogue = await openCatalog();
    await focusOn(field());
    await type("Inception");
    assert.deepEqual(asked(catalogue).at(-1), { query: "Inception", page: 1, pageSize: 24, filters: null });
    assert.equal(titles()[0], "Inception 0");
  });

  it("grows by a page when the end of the grid comes into view, keeping what is already shown", async () => {
    const catalogue = await openCatalog();
    const before = titles();
    const end = screen().querySelector(".catalog-feed-end");
    assert.ok(end, "the end of the grid is on screen");

    await act(async () => intersect(end));
    await settle();

    assert.deepEqual(asked(catalogue).at(-1), { query: "", page: 2, pageSize: 24, filters: null });
    assert.equal(posters().length, 48);
    assert.deepEqual(titles().slice(0, 24), before, "the first page did not move");
  });

  it("narrows to one ranked shortlist when a chip is chosen, and says how it is ranked", async () => {
    const catalogue = await openCatalog();
    await click(chip("Something scary"));
    await settle();

    const last = asked(catalogue).at(-1);
    assert.equal(last?.pageSize, 48);
    assert.equal(last?.page, 1);
    assert.deepEqual(last?.filters?.includeGenres, ["horror"]);
    assert.equal(screen().querySelector(".catalog-ranked-by")?.textContent, "Ranked by genre match");
    assert.equal(screen().querySelector(".catalog-feed-end"), null, "a shortlist is not paged");
    const narrowing = Array.from(screen().querySelectorAll<HTMLButtonElement>(".catalog-chip-active")).map((button) => button.getAttribute("aria-label"));
    assert.deepEqual(narrowing, ["Remove Horror"], "what is narrowing the grid is named and removable");

    // Removing it again widens the grid back to the paged catalogue.
    await click(screen().querySelector(".catalog-chip-active"));
    await settle();
    assert.equal(screen().querySelector(".catalog-ranked-by"), null);
    assert.deepEqual(asked(catalogue).at(-1), { query: "", page: 1, pageSize: 24, filters: null });
  });

  it("opens a film over itself and gives the poster its focus back when it closes", async () => {
    await openCatalog();
    const main = screen();
    await focusOn(posters()[1]);
    const opener = focused();
    const entries = window.history.length;

    await press("Enter");
    assert.equal(window.location.pathname, "/discover/50002");
    assert.equal(document.querySelector(".catalog-shell"), main, "the same catalogue, not a new one");
    assert.ok(main.hasAttribute("inert"));
    assert.equal(document.querySelector(".film-page h1")?.textContent, "Shortlisted 1");
    assert.equal(liveTopBar()?.querySelector('[aria-current="page"]')?.textContent, "Catalog");

    await press("Escape");
    await settle();
    assert.equal(window.location.pathname, "/catalog");
    assert.equal(document.querySelector(".catalog-shell"), main);
    assert.equal(main.hasAttribute("inert"), false);
    assert.equal(focused(), opener, "focus is back on the poster that opened the film");
    assert.equal(window.history.length, entries + 1, "closing stepped back instead of adding an entry");
  });
});
