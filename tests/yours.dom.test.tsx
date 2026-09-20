import { cleanup, click, render } from "./render";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { JamRoom } from "../src/core/room";
import { JamRegistry } from "../src/screens/JamRegistry";
import { rememberStartedKind } from "../src/lib/startedKinds";

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

/**
 * Yours holds all three: a Movie Jam room, a Director session and an escape room are the same
 * row in `jams` and three different experiences, so each card says which it is. The kind is
 * read from what this browser recorded when it was started; a room with nothing recorded is a
 * Movie Jam, which is what a jam row is.
 */

const PREVIEW_KEY = "reverie.preview-jams.v1";

function jam(id: string, title: string): JamRoom {
  return {
    id,
    slug: `${title.toLowerCase().replace(/\W+/g, "-")}-${id.slice(0, 8)}`,
    title,
    premise: "A signal changes what the room thinks is possible.",
    visibility: "invite_only",
    status: "draft",
    created_at: "2026-09-20T10:00:00.000Z",
    updated_at: "2026-09-20T10:00:00.000Z",
  };
}

const ROOM = jam("11111111-1111-4111-8111-111111111111", "Night shift");
const FILM = jam("22222222-2222-4222-8222-222222222222", "The salt door");
const PLACE = jam("33333333-3333-4333-8333-333333333333", "The night audit");

/** Without Supabase, `listJams` reads this browser's own preview registry. */
function registerAll() {
  window.localStorage.setItem(PREVIEW_KEY, JSON.stringify([ROOM, FILM, PLACE]));
  rememberStartedKind(FILM.id, "director");
  rememberStartedKind(PLACE.id, "escape");
}

const cards = () => [...document.querySelectorAll<HTMLElement>(".registry-card")];
const kinds = () => cards().map((card) => card.querySelector(".registry-kind")?.textContent ?? "");
const ways = (card: HTMLElement) => [...card.querySelectorAll<HTMLButtonElement>(".registry-ways button")].map((button) => button.textContent);

describe("Yours", () => {
  it("is called Yours and holds everything started, not just jams", async () => {
    registerAll();
    await render(<JamRegistry onNew={() => {}} onOpen={() => {}} onDirect={() => {}} />);
    assert.equal(document.querySelector(".registry-head .eyebrow")?.textContent, "YOURS");
    assert.match(document.querySelector("h1")?.textContent ?? "", /Everything you have started/);
    assert.equal(cards().length, 3);
  });

  it("says which of the three each one is", async () => {
    registerAll();
    await render(<JamRegistry onNew={() => {}} onOpen={() => {}} onDirect={() => {}} />);
    assert.deepEqual(kinds().map((line) => line.split(" · ")[0]), ["MOVIE JAM", "DIRECTOR SESSION", "ESCAPE ROOM"]);
    assert.deepEqual(
      cards().map((card) => card.querySelector(".registry-meaning")?.textContent),
      ["A room directing one film together.", "One person, one film, alone.", "A room solving an authored place."],
    );
  });

  it("opens each where it belongs: a jam either way, the other two in their one place", async () => {
    registerAll();
    const opened: string[] = [];
    const directed: string[] = [];
    await render(<JamRegistry onNew={() => {}} onOpen={(room) => opened.push(room.title)} onDirect={(room) => directed.push(room.title)} />);
    assert.deepEqual(ways(cards()[0]), ["With people →", "Alone →"]);
    assert.deepEqual(ways(cards()[1]), ["Open →"]);
    assert.deepEqual(ways(cards()[2]), ["Open →"]);

    await click(cards()[1].querySelector("button")!);
    assert.deepEqual(directed, ["The salt door"], "a Director session opens alone");
    await click(cards()[2].querySelector("button")!);
    assert.deepEqual(opened, ["The night audit"], "an escape room opens in its room");
  });

  it("shows a room it recorded nothing about as the room it is", async () => {
    window.localStorage.setItem(PREVIEW_KEY, JSON.stringify([ROOM]));
    await render(<JamRegistry onNew={() => {}} onOpen={() => {}} onDirect={() => {}} />);
    assert.match(kinds()[0], /^MOVIE JAM/);
  });

  it("says plainly when nothing has been started, and offers the door", async () => {
    const started: number[] = [];
    await render(<JamRegistry onNew={() => started.push(1)} onOpen={() => {}} onDirect={() => {}} />);
    assert.equal(cards().length, 0);
    assert.match(document.querySelector(".registry-empty")?.textContent ?? "", /have not started anything yet/);
    await click(document.querySelector<HTMLButtonElement>(".registry-head .button")!);
    assert.deepEqual(started, [1], "the one place that starts something is the door");
  });
});
