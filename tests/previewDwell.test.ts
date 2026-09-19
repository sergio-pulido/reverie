import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDwell, hovers, PREVIEW_DWELL_MS, type DwellClock } from "../src/search/dwell";
import { JAM_PREMISE_MAX, JAM_TITLE_MAX, jamSeedFrom } from "../src/search/jamSeed";

/** A clock the test moves by hand. */
function manualClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: DwellClock = {
    setTimeout(callback, ms) {
      const handle = next++;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  function advance(ms: number) {
    now += ms;
    for (const [handle, timer] of [...timers].sort(([, a], [, b]) => a.at - b.at)) {
      if (timer.at > now) continue;
      timers.delete(handle);
      timer.callback();
    }
  }
  return { clock, advance, pending: () => timers.size };
}

function setup() {
  const opened: string[] = [];
  const { clock, advance, pending } = manualClock();
  const dwell = createDwell<string>((key) => opened.push(key), { clock });
  const mouse = { pointerType: "mouse", moved: true };
  return { dwell, opened, advance, pending, mouse };
}

describe("opening a preview by resting the pointer", () => {
  it("opens once the mouse has rested on a card for the dwell delay, and not before", () => {
    const { dwell, opened, advance, mouse } = setup();
    dwell.rest("a", mouse);
    advance(PREVIEW_DWELL_MS - 1);
    assert.deepEqual(opened, []);
    advance(1);
    assert.deepEqual(opened, ["a"]);
  });

  it("opens nothing while the pointer sweeps across a row", () => {
    const { dwell, opened, advance, mouse } = setup();
    for (const card of ["a", "b", "c", "d", "e"]) {
      dwell.rest(card, mouse);
      advance(PREVIEW_DWELL_MS / 3);
      dwell.leave(card);
    }
    advance(PREVIEW_DWELL_MS * 3);
    assert.deepEqual(opened, []);
  });

  it("starts the wait again on each new card, and keeps it through small moves within one", () => {
    const { dwell, opened, advance, mouse } = setup();
    dwell.rest("a", mouse);
    advance(PREVIEW_DWELL_MS - 100);
    dwell.rest("b", mouse);
    advance(PREVIEW_DWELL_MS - 100);
    assert.deepEqual(opened, [], "b has not been rested on long enough");
    dwell.rest("b", mouse);
    advance(100);
    assert.deepEqual(opened, ["b"], "moving within b did not restart its wait");
  });

  it("never opens for touch, or for a pointer that did not move", () => {
    const { dwell, opened, advance, pending } = setup();
    dwell.rest("a", { pointerType: "touch", moved: true });
    dwell.rest("b", { pointerType: "mouse", moved: false });
    advance(PREVIEW_DWELL_MS * 2);
    assert.deepEqual(opened, []);
    assert.equal(pending(), 0);
    assert.equal(hovers("mouse"), true);
    assert.equal(hovers("pen"), true);
    assert.equal(hovers("touch"), false);
    assert.equal(hovers(""), false);
  });

  it("stops a pending open when the pointer leaves, or a key is pressed", () => {
    const { dwell, opened, advance, mouse } = setup();
    dwell.rest("a", mouse);
    dwell.leave("a");
    dwell.rest("b", mouse);
    dwell.cancel();
    advance(PREVIEW_DWELL_MS * 2);
    assert.deepEqual(opened, []);
  });

  it("does not reopen a card whose preview just closed until the pointer has left it", () => {
    const { dwell, opened, advance, mouse } = setup();
    dwell.opened("a");
    dwell.rest("b", mouse);
    advance(PREVIEW_DWELL_MS * 2);
    assert.deepEqual(opened, [], "nothing opens under an open preview");
    dwell.leave("a");
    dwell.closed();
    dwell.rest("a", mouse);
    advance(PREVIEW_DWELL_MS * 2);
    assert.deepEqual(opened, [], "the pointer never left the card after it closed");
    dwell.leave("a");
    dwell.rest("a", mouse);
    advance(PREVIEW_DWELL_MS);
    assert.deepEqual(opened, ["a"], "coming back to it after leaving opens it again");
  });

  it("lets another card open while one is spent", () => {
    const { dwell, opened, advance, mouse } = setup();
    dwell.opened("a");
    dwell.closed();
    dwell.rest("b", mouse);
    advance(PREVIEW_DWELL_MS);
    assert.deepEqual(opened, ["b"]);
  });
});

describe("a Jam seeded from a film", () => {
  it("names the film it is inspired by and opens on its first sentence", () => {
    const seed = jamSeedFrom({ title: "Inception", year: 2010, synopsis: "Cobb steals secrets from dreams. He is offered one last job." });
    assert.equal(seed.title, "Inspired by Inception");
    assert.equal(seed.premise, "An original story inspired by Inception (2010). It begins where that one does: Cobb steals secrets from dreams.");
  });

  it("says only what the record holds", () => {
    assert.deepEqual(jamSeedFrom({ title: "Untitled" }), { title: "Inspired by Untitled", premise: "An original story inspired by Untitled." });
  });

  it("fits the form's limits, cutting at a word", () => {
    const seed = jamSeedFrom({ title: "A".repeat(40) + " " + "B".repeat(40), year: 1999, synopsis: `${"word ".repeat(80)}end.` });
    assert.ok(seed.title.length <= JAM_TITLE_MAX, seed.title);
    assert.ok(seed.premise.length <= JAM_PREMISE_MAX, seed.premise);
    assert.ok(seed.premise.endsWith("…"));
    assert.ok(!/\bwor…$/.test(seed.premise), "never cut mid-word");
  });

  it("never offers the film itself, or a way to watch it", () => {
    const seed = jamSeedFrom({ title: "Heat", year: 1995, synopsis: "A thief and a detective." });
    assert.equal(/\b(watch|stream|play|full movie)\b/i.test(`${seed.title} ${seed.premise}`), false);
  });
});
