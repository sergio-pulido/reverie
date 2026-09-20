import { cleanup, click, render, settle } from "./render";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { App } from "../src/App";
import type { JamRoom } from "../src/core/room";
import { CatalogueReadProvider } from "../src/discover/CatalogueReadContext";
import { madeFilmsFrom, producedLine, NOTHING_MADE_YET } from "../src/made/madeInReverie";
import { rememberStartedKind } from "../src/lib/startedKinds";
import { fakeCatalogue } from "./catalogueFake";

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

/**
 * Community stopped being a destination: what has been made in Reverie is a shelf on the home
 * and Catalog's other source, beside the films you came to watch. Both read the same real data
 * — the public rooms this viewer can read — and both say plainly when there is nothing yet.
 */

const PREVIEW_KEY = "reverie.preview-jams.v1";

function jam(id: string, title: string, visibility: JamRoom["visibility"], status: JamRoom["status"] = "draft"): JamRoom {
  return {
    id,
    slug: `${title.toLowerCase().replace(/\W+/g, "-")}-${id.slice(0, 8)}`,
    title,
    premise: "A signal changes what the room thinks is possible.",
    visibility,
    status,
    created_at: "2026-09-20T10:00:00.000Z",
    updated_at: "2026-09-20T10:00:00.000Z",
  };
}

const PUBLIC = jam("11111111-1111-4111-8111-111111111111", "Night shift", "public", "completed");
const PRIVATE = jam("22222222-2222-4222-8222-222222222222", "The salt door", "invite_only");

function register(...jams: JamRoom[]) {
  window.localStorage.setItem(PREVIEW_KEY, JSON.stringify(jams));
}

async function open(path: string) {
  const catalogue = fakeCatalogue();
  await render(<CatalogueReadProvider read={catalogue.read}><App /></CatalogueReadProvider>, path);
  await settle();
  return catalogue;
}

describe("what has been made in Reverie", () => {
  it("is the public rooms, and only those", () => {
    const films = madeFilmsFrom([PUBLIC, PRIVATE]);
    assert.deepEqual(films.map(({ title }) => title), ["Night shift"], "an invite-only room is not public work");
  });

  it("says what a room produced from the room's own state, claiming no film it cannot show", () => {
    assert.equal(producedLine(madeFilmsFrom([PUBLIC])[0]), "Finished.");
    assert.equal(producedLine(madeFilmsFrom([jam(PUBLIC.id, "x", "public", "live")])[0]), "Being made now.");
    assert.equal(producedLine(madeFilmsFrom([jam(PUBLIC.id, "x", "public", "draft")])[0]), "Started, not finished.");
  });

  it("carries which of the three it was, like everything else that lists them", () => {
    rememberStartedKind(PUBLIC.id, "escape");
    assert.equal(madeFilmsFrom([PUBLIC])[0].kind, "escape");
    window.localStorage.clear();
    assert.equal(madeFilmsFrom([PUBLIC])[0].kind, "jam", "a room with nothing recorded is a room");
  });
});

describe("the Made in Reverie shelf on the home", () => {
  it("stands among the catalogue's shelves, with what has been made here", async () => {
    register(PUBLIC, PRIVATE);
    await open("/home");
    const shelf = document.querySelector(".home-made");
    assert.ok(shelf, "the shelf is on the home");
    assert.equal(shelf!.querySelector("h2")?.textContent, "Made in Reverie");
    const cards = [...shelf!.querySelectorAll(".home-made-card")];
    assert.deepEqual(cards.map((card) => card.querySelector(".home-made-title")?.textContent), ["Night shift"]);
    assert.equal(cards[0].querySelector(".home-made-status")?.textContent, "Finished.");
  });

  it("says plainly when nothing has been made yet, instead of standing empty", async () => {
    await open("/home");
    assert.equal(document.querySelector(".home-made-card"), null);
    assert.equal(document.querySelector(".home-made-note")?.textContent, NOTHING_MADE_YET);
  });

  it("opens the room a card names", async () => {
    register(PUBLIC);
    await open("/home");
    await click(document.querySelector(".home-made-card"));
    assert.equal(window.location.pathname, `/jams/${PUBLIC.slug}`);
  });
});

describe("Made in Reverie as Catalog's other source", () => {
  const sources = () => [...document.querySelectorAll<HTMLButtonElement>(".catalog-source-choice")];

  it("switches the grid between the catalogue's titles and the ones made here", async () => {
    register(PUBLIC);
    await open("/catalog");
    assert.deepEqual(sources().map((button) => button.textContent), ["The catalogue", "Made in Reverie"]);
    assert.ok(document.querySelector(".catalog-card"), "the catalogue is what it opens on");
    assert.equal(document.querySelector(".catalog-made"), null);

    await click(sources()[1]);
    await settle();
    assert.equal(document.querySelector(".catalog-card"), null, "the catalogue's posters step aside");
    assert.equal(document.querySelector(".catalog-search"), null, "and so does the search that narrows it");
    assert.deepEqual(
      [...document.querySelectorAll(".catalog-made-title")].map((node) => node.textContent),
      ["Night shift"],
    );

    await click(sources()[0]);
    await settle();
    assert.ok(document.querySelector(".catalog-card"), "and back again");
  });

  it("says plainly when there is nothing made yet", async () => {
    await open("/catalog");
    await click(sources()[1]);
    await settle();
    assert.equal(document.querySelector(".catalog-made-card"), null);
    assert.equal(document.querySelector(".catalog-made-note")?.textContent, NOTHING_MADE_YET);
  });

  it("opens the room a card names", async () => {
    register(PUBLIC);
    await open("/catalog");
    await click(sources()[1]);
    await settle();
    await click(document.querySelector(".catalog-made-card"));
    assert.equal(window.location.pathname, `/jams/${PUBLIC.slug}`);
  });
});
