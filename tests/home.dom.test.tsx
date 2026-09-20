import { cleanup, click, focusOn, focused, loseFocus, press, render, rerender, settle } from "./render";
import { intersect, isObserved, scrollCalls } from "./dom";
import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CatalogueTitle } from "../src/catalogue/contract";
import { HomeScreen } from "../src/home/HomeScreen";
import type { ShelfResult } from "../src/home/shelfLoader";
import { EAGER_SHELVES, SHELF_PAGE_SIZE, SHELVES, SPOTLIGHT_AFTER } from "../src/home/shelves";
import { useRemoteConventions } from "../src/shell/useRemoteConventions";

afterEach(cleanup);

const film = (shelf: number, index: number, backdrop = true): CatalogueTitle => ({
  id: `cat:${shelf * 100 + index + 1}`,
  title: `Shelf ${shelf} film ${index}`,
  year: 1990 + index,
  genres: ["Drama"],
  availability: [],
  posterUrl: `https://image.tmdb.org/t/p/w500/p${shelf}-${index}.jpg`,
  ...(backdrop ? { backdropUrl: `https://image.tmdb.org/t/p/w780/b${shelf}-${index}.jpg` } : {}),
});
const shelfOf = (shelf: number, count = SHELF_PAGE_SIZE): ShelfResult => ({
  phase: "ready",
  items: Array.from({ length: count }, (_, index) => film(shelf, index)),
  attribution: "Film data and images from TMDB.",
});

/** A shelf source whose reads resolve only when the test says so, recording every read. */
function manualShelves() {
  const reads: number[] = [];
  const waiting = new Map<number, (result: ShelfResult) => void>();
  const source = {
    load: (index: number) => {
      reads.push(index);
      return new Promise<ShelfResult>((resolve) => waiting.set(index, resolve));
    },
  };
  return {
    reads,
    source,
    async answer(index: number, result: ShelfResult = shelfOf(index)) {
      const resolve = waiting.get(index);
      assert.ok(resolve, `shelf ${index} was read`);
      waiting.delete(index);
      await act(async () => resolve(result));
      await settle();
    },
  };
}

/** The home as the app mounts it: with the app's remote conventions installed around it. */
function Conventions({ children, onLeave = () => false }: { children: ReactNode; onLeave?: () => boolean }) {
  useRemoteConventions(onLeave);
  return <>{children}</>;
}

type Opened = { films: CatalogueTitle[]; jams: number; joins: number };

async function openHome(shelves = manualShelves(), opened: Opened = { films: [], jams: 0, joins: 0 }) {
  const container = await render(
    <Conventions>
      <HomeScreen
        shelves={shelves.source}
        onOpenFilm={(title) => opened.films.push(title)}
        onStartJam={() => (opened.jams += 1)}
        onJoin={() => (opened.joins += 1)}
        onOpenMade={() => undefined}
      />
    </Conventions>,
  );
  return { container, shelves, opened };
}

const sectionOf = (index: number) => document.getElementById(`shelf-${SHELVES[index].id}`)!.closest("section")!;
const cell = (row: string, index: number) => document.querySelector<HTMLElement>(`[data-row="${row}"][data-index="${index}"]`);
const rowOf = (element: Element) => `${element.getAttribute("data-row")}:${element.getAttribute("data-index")}`;
const shelfRow = (index: number) => `shelf:${SHELVES[index].id}`;

beforeEach(() => {
  scrollCalls.length = 0;
});

describe("the home's cost", () => {
  it("reads only the first two shelves when it opens", async () => {
    const { shelves } = await openHome();
    assert.equal(EAGER_SHELVES, 2);
    assert.deepEqual(shelves.reads, [0, 1]);
    for (let index = EAGER_SHELVES; index < SHELVES.length; index += 1) {
      assert.ok(isObserved(sectionOf(index)), `shelf ${index} is watched for approach`);
    }
    // The observer has reported every section once, as not yet in reach: nothing more is read.
    await settle();
    assert.deepEqual(shelves.reads, [0, 1]);
  });

  it("reads a shelf below the fold only when it approaches, and only once", async () => {
    const { shelves } = await openHome();
    await act(async () => intersect(sectionOf(4)));
    assert.deepEqual(shelves.reads, [0, 1, 4]);
    await act(async () => intersect(sectionOf(4)));
    assert.deepEqual(shelves.reads, [0, 1, 4], "a second report reads nothing");
    await shelves.answer(4);
    assert.equal(isObserved(sectionOf(4)), false, "a shelf that has been read is no longer watched");
    assert.ok(cell(shelfRow(4), 0), "its posters are on screen");
  });

  it("reads the shelf below as focus reaches the one above it, for a remote that outruns scrolling", async () => {
    const { shelves } = await openHome();
    await shelves.answer(0);
    await shelves.answer(1);
    await focusOn(cell(shelfRow(1), 0));
    assert.deepEqual(shelves.reads, [0, 1, 2]);
  });

  it("reads nothing more once the catalogue says it is not configured", async () => {
    const { shelves } = await openHome();
    await shelves.answer(0, { phase: "not_configured", safeMessage: "No catalogue." });
    assert.equal(document.querySelector(".home-shelf"), null, "no shelf is drawn");
    assert.match(document.querySelector(".home-hero")!.textContent!, /No films to show yet/);
    assert.equal(focused().textContent, "Start a Movie Jam", "the spotlight still works");
    await settle();
    assert.deepEqual(shelves.reads, [0, 1], "landing on the spotlight reads nothing");
    await press("ArrowRight");
    await press("ArrowLeft");
    assert.deepEqual(shelves.reads, [0, 1]);
  });

  it("reads nothing more when landing below an empty first shelf", async () => {
    const { shelves } = await openHome();
    await shelves.answer(0, { phase: "ready", items: [] });
    await shelves.answer(1);
    assert.equal(rowOf(focused()), `${shelfRow(1)}:0`, "with no hero, focus lands on the first shelf with films");
    await settle();
    assert.deepEqual(shelves.reads, [0, 1]);
  });
});

describe("the home's layout", () => {
  it("shows one film large, not repeated in the shelf beneath it", async () => {
    const { shelves } = await openHome();
    await shelves.answer(0);
    const hero = document.querySelector(".home-hero")!;
    assert.match(hero.textContent!, /Shelf 0 film 0/);
    assert.ok(hero.querySelector("img.home-hero-backdrop"));
    const firstShelf = Array.from(sectionOf(0).querySelectorAll(".home-card-title")).map((title) => title.textContent);
    assert.equal(firstShelf.includes("Shelf 0 film 0"), false);
    assert.equal(firstShelf.length, SHELF_PAGE_SIZE - 1);
  });

  it("puts the Movie Jam spotlight among the shelves, over a real still, with actions that work", async () => {
    const { shelves, opened } = await openHome();
    await shelves.answer(0);
    await shelves.answer(1);
    const spotlight = document.querySelector(".home-jam")!;
    const sections = Array.from(document.querySelectorAll(".home-rows > section"));
    assert.equal(sections.indexOf(spotlight), 1 + SPOTLIGHT_AFTER, "after the hero and the first shelves");
    const last = SHELF_PAGE_SIZE - 1;
    assert.equal(spotlight.querySelector("img")!.getAttribute("src"), film(1, last).backdropUrl, "a real backdrop, from the far end of the shelf above");
    assert.match(spotlight.textContent!, new RegExp(`Still from Shelf 1 film ${last}`));
    await click(spotlight.querySelector('[data-index="0"]'));
    await click(spotlight.querySelector('[data-index="1"]'));
    assert.deepEqual([opened.jams, opened.joins], [1, 1]);
  });

  it("reserves each poster's 2:3 box before its image loads", async () => {
    const { shelves } = await openHome();
    assert.equal(sectionOf(0).getAttribute("aria-busy"), "true");
    assert.ok(sectionOf(0).querySelectorAll(".home-card-placeholder .home-card-poster").length >= 7, "a loading shelf holds poster boxes past the edge");
    await shelves.answer(0);
    assert.equal(sectionOf(0).querySelectorAll(".home-card-placeholder").length, 0);
    const image = sectionOf(0).querySelector("img.home-card-art")!;
    assert.equal(image.getAttribute("width"), "500");
    assert.equal(image.getAttribute("height"), "750");
  });

  it("keeps the TMDB attribution on screen once TMDB films are shown", async () => {
    const { shelves } = await openHome();
    assert.equal(document.querySelector(".discover-attribution"), null);
    await shelves.answer(0);
    assert.match(document.querySelector(".discover-attribution")!.textContent!, /TMDB/);
  });
});

describe("the home with a remote", () => {
  async function loadedHome() {
    const home = await openHome();
    await home.shelves.answer(0);
    await home.shelves.answer(1);
    return home;
  }

  it("lands on the hero, and Up from the hero reaches the top bar", async () => {
    await loadedHome();
    assert.equal(rowOf(focused()), "hero:0");
    assert.equal(await press("ArrowUp"), true);
    assert.equal(focused().closest("[data-top-bar]") !== null, true);
    assert.equal(focused().getAttribute("aria-current"), "page");
    assert.equal(focused().textContent, "Home");
  });

  it("returns from the top bar to the first row with Down", async () => {
    await loadedHome();
    await press("ArrowUp");
    await press("ArrowDown");
    assert.equal(rowOf(focused()), "hero:0");
  });

  it("goes up from the first shelf to the hero, not to the bar", async () => {
    await loadedHome();
    await press("ArrowDown");
    assert.equal(rowOf(focused()), `${shelfRow(0)}:0`);
    await press("ArrowUp");
    assert.equal(rowOf(focused()), "hero:0");
  });

  it("moves along a shelf with Left and Right, and never off its ends", async () => {
    await loadedHome();
    await press("ArrowDown");
    assert.equal(await press("ArrowLeft"), true, "the key is taken so the page does not scroll");
    assert.equal(rowOf(focused()), `${shelfRow(0)}:0`);
    await press("ArrowRight");
    await press("ArrowRight");
    assert.equal(rowOf(focused()), `${shelfRow(0)}:2`);
    for (let press_ = 0; press_ < SHELF_PAGE_SIZE + 3; press_ += 1) await press("ArrowRight");
    assert.equal(rowOf(focused()), `${shelfRow(0)}:${SHELF_PAGE_SIZE - 2}`, "the last card of the shelf, less the hero");
  });

  it("changes shelf with Up and Down, landing where the viewer last was in each", async () => {
    await loadedHome();
    await press("ArrowDown");
    await press("ArrowRight");
    await press("ArrowRight");
    await press("ArrowRight");
    await press("ArrowDown");
    assert.equal(rowOf(focused()), `${shelfRow(1)}:0`, "a shelf not yet visited starts at its first card");
    await press("ArrowRight");
    await press("ArrowUp");
    assert.equal(rowOf(focused()), `${shelfRow(0)}:3`, "back where the viewer left the first shelf");
    await press("ArrowDown");
    assert.equal(rowOf(focused()), `${shelfRow(1)}:1`);
    await press("ArrowDown");
    assert.equal(rowOf(focused()), "jam:0", "the spotlight is a row of its own");
  });

  it("waits on a shelf still loading instead of skipping past it", async () => {
    const { shelves } = await openHome();
    await shelves.answer(0);
    await press("ArrowDown");
    const before = rowOf(focused());
    assert.equal(await press("ArrowDown"), true);
    assert.equal(rowOf(focused()), before, "focus stays while the next shelf loads");
    await shelves.answer(1);
    await press("ArrowDown");
    assert.equal(rowOf(focused()), `${shelfRow(1)}:0`);
  });

  it("opens the focused film with OK, once", async () => {
    const { opened } = await loadedHome();
    await press("ArrowDown");
    await press("ArrowRight");
    assert.equal(await press("Enter"), true);
    assert.deepEqual(opened.films.map(({ title }) => title), ["Shelf 0 film 2"]);
    assert.equal(await press("Enter", { repeat: true }), true, "a held OK is swallowed");
    assert.equal(opened.films.length, 1);
  });

  it("starts a Movie Jam from the spotlight with OK", async () => {
    const { opened } = await loadedHome();
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    assert.equal(focused().textContent, "Start a Movie Jam");
    await press("Enter");
    assert.equal(opened.jams, 1);
  });

  it("answers Back from deep in the shelves by scrolling to the top and focusing the bar", async () => {
    const { shelves } = await loadedHome();
    await act(async () => intersect(sectionOf(2)));
    await shelves.answer(2);
    for (let row = 0; row < 4; row += 1) await press("ArrowDown");
    assert.equal(rowOf(focused()), `${shelfRow(2)}:0`, "four rows down");
    scrollCalls.length = 0;
    assert.equal(await press("Escape"), true);
    assert.equal(focused().getAttribute("aria-current"), "page");
    assert.deepEqual(scrollCalls, [{ top: 0 }]);
  });

  it("knows a remote's Back by its key code alone", async () => {
    await loadedHome();
    await press("ArrowDown");
    assert.equal(await press("Unidentified", { keyCode: 461 }), true);
    assert.equal(focused().getAttribute("aria-current"), "page");
  });

  it("leaves Back on the home's bar to the platform", async () => {
    let left = 0;
    await render(
      <Conventions onLeave={() => (left += 1, false)}>
        <HomeScreen shelves={manualShelves().source} onOpenFilm={() => undefined} onStartJam={() => undefined} onJoin={() => undefined} onOpenMade={() => undefined} />
      </Conventions>,
    );
    await press("ArrowDown", { allowLost: true });
    assert.equal(focused().getAttribute("aria-current"), "page");
    assert.equal(await press("Escape"), false, "not taken: the platform decides");
    assert.equal(left, 1);
  });

  it("keeps a failed shelf's retry focused until the shelf has loaded, then moves into it", async () => {
    const { shelves } = await openHome();
    await shelves.answer(0);
    await shelves.answer(1, { phase: "error", safeMessage: "These films could not be loaded.", retryable: true });
    await press("ArrowDown");
    await press("ArrowDown");
    assert.equal(focused().textContent, "Try again");
    await click(focused());
    assert.equal(focused().textContent, "Loading…", "the button stays, so focus is not lost");
    await shelves.answer(1);
    assert.equal(rowOf(focused()), `${shelfRow(1)}:0`);
  });

  it("does not move focus the viewer has already moved", async () => {
    const shelves = manualShelves();
    await openHome(shelves);
    await press("ArrowDown", { allowLost: true });
    assert.equal(focused().getAttribute("aria-current"), "page", "before the hero exists, a key lands on the bar");
    await shelves.answer(0);
    assert.equal(focused().getAttribute("aria-current"), "page", "the hero arriving does not take focus from the viewer");
  });
});

describe("a film opened from the home", () => {
  it("covers the home without unmounting it, and focus returns to its card when it closes", async () => {
    const shelves = manualShelves();
    function Host({ open }: { open: boolean }) {
      return (
        <Conventions>
          {open && <p className="film-page">film</p>}
          <HomeScreen inert={open} shelves={shelves.source} onOpenFilm={() => undefined} onStartJam={() => undefined} onJoin={() => undefined} onOpenMade={() => undefined} />
        </Conventions>
      );
    }
    await render(<Host open={false} />);
    await shelves.answer(0);
    await shelves.answer(1);
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowRight");
    const opener = focused();
    assert.equal(rowOf(opener), `${shelfRow(1)}:1`);

    await rerender(<Host open />);
    assert.ok(document.querySelector(".home-shell")!.hasAttribute("inert"));
    await loseFocus();
    await rerender(<Host open={false} />);
    assert.equal(focused(), opener, "the same card, still mounted, has focus again");
    assert.deepEqual(shelves.reads, [0, 1, 2], "nothing was read again");
  });
});
