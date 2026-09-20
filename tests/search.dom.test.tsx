import { cards, field, openSearch, rankingGate, say, turns, type } from "./searchScreen";
import { cleanup, click, focusOn, focused, press, settle } from "./render";
import { scrollCalls } from "./dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { INVITATION } from "../src/search/SearchScreen";
import { liveTopBar } from "../src/shell/topBarFocus";

afterEach(cleanup);

/** Which element this is, briefly: a failing comparison of two DOM nodes must not try to print them. */
function describe_(element: Element | null) {
  if (!element) return "nothing";
  return `${element.tagName.toLowerCase()}.${element.className} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").slice(0, 40)}"`;
}
function same(actual: Element | null, expected: Element | null, message = "the same element") {
  assert.ok(actual === expected, `${message}: expected ${describe_(expected)}, got ${describe_(actual)}`);
}

const inBar = () => liveTopBar() !== null && focused().closest("[data-top-bar]") === liveTopBar();
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const page = () => document.querySelector<HTMLElement>(".search-shell")!;
/** The controls a viewer can reach on the page, outside the top bar. */
const reachable = () =>
  Array.from(page().querySelectorAll<HTMLElement>("button, input, a[href], [tabindex]")).filter((element) => !element.closest("[data-top-bar]"));

describe("search at rest", () => {
  it("shows one line, the field and the microphone, and no film before the first request", async () => {
    const { catalogue, assistant } = await openSearch();
    assert.equal(document.querySelector("h1")?.textContent, INVITATION);
    assert.deepEqual(
      reachable().map((element) => element.getAttribute("aria-label") ?? element.getAttribute("type")),
      ["Speak instead of typing", "search"],
      "the microphone and the field, and nothing else",
    );
    same(focused(), field(), "the field is ready for a remote or a keyboard");
    assert.equal(document.querySelectorAll("img, .search-card, .search-turn").length, 0, "no poster, no card, no turn");
    assert.equal(document.querySelector(".discover-attribution"), null, "no films, so nothing to attribute");
    assert.equal(catalogue.requests.length, 0, "nothing was read");
    assert.equal(assistant.turns.length, 0);
  });

  it("still shows no film while a request is only being typed, whatever it asks for", async () => {
    const { catalogue } = await openSearch();
    for (const draft of ["Inception", "something funny from the nineties, under two hours"]) {
      await type(field(), draft);
      await settle(4);
      assert.equal(catalogue.requests.length, 0, draft);
      assert.equal(document.querySelectorAll("img, .search-card, .search-heard-chip").length, 0, draft);
    }
    assert.ok(document.querySelector(".search-send"), "a draft brings the send button");
  });

  it("draws the voice control as an icon, with no words and no countdown", async () => {
    await openSearch();
    const voice = document.querySelector<HTMLButtonElement>(".voice-control")!;
    assert.equal(voice.textContent, "");
    assert.ok(voice.querySelector("svg"));
    assert.equal(voice.getAttribute("aria-pressed"), "false");
  });
});

describe("a turn", () => {
  it("answers a film's name with the films found, under the reply, without asking the assistant", async () => {
    const { catalogue, assistant } = await openSearch();
    await say("Inception");
    assert.deepEqual(turns().map(({ lines }) => lines), [["Inception", "Here’s what I found for “Inception”."]]);
    const [turn] = turns();
    assert.equal(turn.posters.length, 12);
    assert.equal(turn.posters[0], "Inception 0");
    assert.equal(turn.caption, "Title matches · 500 films");
    assert.deepEqual(catalogue.requests.map(({ query, pageSize, filters }) => [query, pageSize, filters]), [["Inception", 12, null]]);
    assert.deepEqual(assistant.turns, []);
    assert.match(document.querySelector(".discover-attribution")!.textContent!, /TMDB/, "films on screen bring the attribution");
    assert.equal(field().value, "", "the field is cleared for the next message");
    same(focused(), field());
  });

  it("sends a name that finds nothing to the assistant instead of stopping there", async () => {
    const { assistant } = await openSearch("/discover", { unknown: ["Nothing Like It"] });
    await say("Nothing Like It");
    assert.deepEqual(assistant.turns, ["Nothing Like It"]);
    assert.deepEqual(turns()[0].lines, ["Nothing Like It", "Tell me a little more.", "Something funny, or something tense?"]);
    assert.equal(turns()[0].posters.length, 0, "the assistant heard nothing to narrow by, so no films are claimed");
  });

  it("answers a request in the viewer's words through the assistant, with the films it ranked", async () => {
    const { catalogue, assistant } = await openSearch();
    await say("something funny");
    assert.deepEqual(assistant.turns, ["something funny"]);
    const shortlist = catalogue.requests.at(-1)!;
    assert.deepEqual(shortlist.filters, { includeGenres: ["comedy"] }, "the engine's state, pushed into the read");
    assert.equal(assistant.rankings.length, 1, "the turn's films were ranked once");
    const [turn] = turns();
    assert.deepEqual(turn.lines, ["something funny", "Heard: something funny."]);
    assert.equal(turn.caption, "Ranked by the assistant · 500 films");
    assert.equal(turn.posters.length, 12);
    assert.equal(turn.posters[0], "Comedies 47", "the assistant's order, not the catalogue's");
    const first = cards(0)[0];
    assert.match(first.getAttribute("aria-label")!, /top pick\. Why it’s here: Why cat:2048 and not the others/, "the critic's note, not the ranking's reason");
  });

  it("adds a block for a refinement and leaves the earlier block's films as they were", async () => {
    await openSearch();
    await say("something funny");
    const before = turns()[0].posters;
    await say("from the nineties");
    const [first, second] = turns();
    assert.deepEqual(first.posters, before, "the first answer is a snapshot");
    assert.deepEqual(second.lines, ["from the nineties", "Heard: from the nineties."]);
    assert.equal(second.posters.length, 12);
    assert.equal(document.querySelectorAll(".search-turn").length, 2);
  });

  it("keeps a turn's films for the state its reply left, even if a filter comes off while they load", async () => {
    const gate = rankingGate();
    const { catalogue } = await openSearch("/discover", { gate });
    await say("something funny");
    assert.ok(document.querySelector(".search-results-waiting"), "the turn is waiting for its ranking");
    await click(document.querySelector('.search-strip [aria-label="Remove Comedy"]'));
    assert.equal(document.querySelector('.search-strip [aria-label="Remove Comedy"]'), null, "the filter is off");
    gate.release();
    await settle(6);
    const [turn] = turns();
    assert.equal(turn.caption, "Ranked by the assistant · 500 films");
    assert.equal(turn.posters[0], "Comedies 47", "ranked for the comedy the reply asked for, not for what came after");
    assert.ok(catalogue.requests.some(({ filters }) => filters?.includeGenres?.[0] === "comedy"));
  });

  it("gives each turn its own films when the next message goes before the first's are ready", async () => {
    const gate = rankingGate();
    await openSearch("/discover", { gate });
    await say("something funny");
    await say("from the nineties");
    assert.equal(document.querySelectorAll(".search-results-waiting").length, 2, "both turns wait for their own films");
    gate.release();
    await settle(8);
    const years = (turn: number) => Array.from(document.querySelectorAll(".search-turn")[turn].querySelectorAll(".search-card-year")).map((year) => Number(year.textContent));
    assert.equal(years(0).length, 12);
    assert.equal(years(1).length, 12);
    assert.ok(years(0).every((year) => year >= 2000), "the first turn's films are from before the era was asked for");
    assert.ok(years(1).every((year) => year >= 1990 && year <= 1999), "the second turn's films are from the nineties");
    assert.equal(turns()[0].caption, "Ranked by the assistant · 500 films");
  });

  it("lets filler fire nothing: no turn, no read, no assistant", async () => {
    const { catalogue, assistant } = await openSearch();
    for (const filler of ["um", "I want", "or"]) {
      await say(filler);
      assert.equal(document.querySelectorAll(".search-turn").length, 0, filler);
    }
    assert.equal(catalogue.requests.length, 0);
    assert.equal(assistant.turns.length, 0);
    assert.match(document.querySelector(".search-status")!.textContent!, /Say a little more/);
    assert.equal(field().value, "or", "what was typed stays, to be finished");
  });

  it("shows what is narrowing the results once a turn has happened, each item removable", async () => {
    await openSearch();
    await say("something funny");
    const strip = document.querySelector(".search-strip")!;
    assert.match(strip.textContent!, /Filters/);
    const comedy = strip.querySelector<HTMLButtonElement>('[aria-label="Remove Comedy"]');
    assert.ok(comedy);
    await click(comedy);
    assert.equal(strip.querySelector('[aria-label="Remove Comedy"]'), null);
    assert.equal(turns()[0].posters.length, 12, "removing a filter rewrites no answer");
  });
});

describe("moving through the conversation with a remote", () => {
  it("goes up and down between turns, along a row, and up out of the first one to the bar", async () => {
    await openSearch();
    await say("Inception");
    await say("Heat");
    same(focused(), field());

    await press("ArrowUp");
    same(focused(), document.querySelector(".search-chip-filters"), "Up from the field reaches the strip above it");
    await press("ArrowUp");
    same(focused(), cards(1)[0], "then the newest turn's films");
    await press("ArrowRight");
    await press("ArrowRight");
    same(focused(), cards(1)[2], "Right walks along the row");
    await press("ArrowUp");
    same(focused(), cards(0)[0], "Up reaches the turn before, at its first film");
    await press("ArrowDown");
    same(focused(), cards(1)[2], "the newer row remembers where the viewer was");
    await press("ArrowDown");
    await press("ArrowDown");
    same(focused(), field(), "Down through the strip lands in the field");
    await press("ArrowUp");
    await press("ArrowUp");
    await press("ArrowUp");
    same(focused(), cards(0)[0]);
    await press("ArrowLeft");
    same(focused(), cards(0)[0], "Left stops at the start of a row");
    assert.equal(await press("ArrowUp"), true);
    assert.ok(inBar(), "Up from the first row reaches the bar");
    await press("ArrowDown");
    same(focused(), field(), "Down from the bar lands in the field");
  });

  it("returns from a poster, or a filter in the strip, to the bar on Back", async () => {
    await openSearch();
    await say("something funny");
    await focusOn(cards(0)[3]);
    scrollCalls.length = 0;
    assert.equal(await press("Escape"), true);
    assert.ok(inBar());
    assert.deepEqual(scrollCalls.at(-1), { top: 0 });
    await focusOn(document.querySelector(".search-strip button"));
    await press("Escape");
    assert.ok(inBar());
  });
});

describe("a film's preview", () => {
  /** Walks up from the field to the first answer's second film and opens it with OK. */
  async function openPreviewFromRow() {
    await openSearch();
    await say("Inception");
    await press("ArrowUp");
    await press("ArrowUp");
    await press("ArrowRight");
    const card = focused();
    same(card, cards(0)[1]);
    await press("Enter");
    return card;
  }

  it("opens with OK on a card, over the conversation, on its first action", async () => {
    const card = await openPreviewFromRow();
    const preview = dialog();
    assert.ok(preview, "the preview is open");
    assert.equal(preview.getAttribute("aria-modal"), "true");
    assert.equal(preview.querySelector("h2")?.textContent, "Inception 1");
    assert.match(preview.textContent!, /2001/);
    assert.match(preview.textContent!, /The 2th story told here/);
    assert.equal(focused().textContent, "Open the film page");
    assert.ok(page().hasAttribute("inert"), "the conversation underneath takes no focus");
    assert.ok(focused() !== card, "the card no longer has focus");
  });

  it("never opens on focus alone, or on a held OK's repeats", async () => {
    await openSearch();
    await say("Inception");
    await press("ArrowUp");
    await press("ArrowUp");
    await press("ArrowRight");
    same(focused(), cards(0)[1]);
    assert.equal(dialog(), null, "sweeping a row opens nothing");
    await press("Enter", { repeat: true });
    assert.equal(dialog(), null, "a held OK's repeat opens nothing");
  });

  it("keeps focus inside it, and never offers to play the film", async () => {
    await openPreviewFromRow();
    await press("ArrowRight");
    assert.equal(focused().textContent, "Start a Jam from this");
    await press("ArrowRight");
    assert.equal(focused().textContent, "Start a Jam from this", "the last action is the end");
    await press("Tab");
    assert.equal(focused().textContent, "Open the film page", "Tab goes round inside the preview");
    await press("Tab", { shiftKey: true });
    assert.equal(focused().textContent, "Start a Jam from this");
    assert.equal(/\b(play|watch|stream)\b/i.test(dialog()!.textContent!), false);
  });

  it("closes on Back and returns focus to the card that opened it", async () => {
    const card = await openPreviewFromRow();
    assert.equal(await press("Escape"), true);
    assert.equal(dialog(), null);
    assert.equal(page().hasAttribute("inert"), false);
    same(focused(), card);
    assert.equal(window.location.pathname, "/discover", "Back closed the preview, and went nowhere else");
  });

  it("closes on a remote's Back key code too", async () => {
    const card = await openPreviewFromRow();
    await press("Unidentified", { keyCode: 461 });
    assert.equal(dialog(), null);
    same(focused(), card);
  });

  it("opens the film's page, and Back returns to the card", async () => {
    const card = await openPreviewFromRow();
    await press("Enter");
    assert.match(window.location.pathname, /^\/discover\/\d+$/);
    assert.equal(document.querySelector(".film-page h1")?.textContent, "Inception 1", "the page opens on the preview's copy");
    assert.equal(dialog(), null, "the preview gave way to the page");
    await press("Escape");
    await settle();
    assert.equal(window.location.pathname, "/discover");
    assert.equal(document.querySelector(".film-page"), null);
    same(focused(), card, "focus is back on the card");
    assert.equal(turns()[0].posters.length, 12, "the conversation was kept underneath");
  });

  it("starts a Jam from the film, with a title and premise drawn from it", async () => {
    await openPreviewFromRow();
    await press("ArrowRight");
    await press("Enter");
    assert.equal(window.location.pathname, "/jams/new");
    const title = document.querySelector<HTMLInputElement>(".room-form input")!;
    const premise = document.querySelector<HTMLTextAreaElement>(".room-form textarea")!;
    assert.equal(title.value, "Inspired by Inception 1");
    assert.equal(premise.value, "An original story inspired by Inception 1 (2001). It begins where that one does: The 2th story told here.");
  });
});

describe("the filter panel", () => {
  it("opens from the strip, narrows the same results the conversation does, and says nothing in it", async () => {
    await openSearch();
    await say("something funny");
    const linesBefore = turns().map(({ lines }) => lines);
    const opener = document.querySelector<HTMLButtonElement>(".search-chip-filters")!;
    await focusOn(opener);
    await press("Enter");
    const panel = dialog()!;
    assert.equal(panel.querySelector("h2")?.textContent, "Filters");
    const comedy = Array.from(panel.querySelectorAll<HTMLButtonElement>(".search-chip")).find((chip) => chip.textContent === "Comedy")!;
    assert.equal(comedy.getAttribute("aria-pressed"), "true", "what the conversation heard shows as chosen");
    const nineties = Array.from(panel.querySelectorAll<HTMLButtonElement>(".search-chip")).find((chip) => chip.textContent === "1990s")!;
    await click(nineties);
    assert.equal(nineties.getAttribute("aria-pressed"), "true");
    assert.ok(panel.querySelectorAll(".search-card").length > 0, "the panel shows what the filters match");

    await press("Escape");
    assert.equal(dialog(), null);
    same(focused(), opener, "focus is back on Filters");
    assert.deepEqual(turns().map(({ lines }) => lines), linesBefore, "the filters said nothing in the conversation");
    assert.ok(document.querySelector('.search-strip [aria-label="Remove From 1990"]'), "the strip shows the era, removable");
    assert.ok(document.querySelector('.search-strip [aria-label="Remove Up to 1999"]'));
  });

  it("is not offered before the first request", async () => {
    await openSearch();
    assert.equal(document.querySelector(".search-chip-filters"), null);
  });
});

describe("the old browsing path", () => {
  it("leads to search, keeping the entry's place in history", async () => {
    await openSearch("/discover");
    assert.equal(window.location.pathname, "/discover");
    assert.equal(document.querySelector("h1")?.textContent, INVITATION);
  });
});

describe("what the film is about", () => {
  const ASKED = "a film about a family with some pets";
  const PHRASE = "a family with some pets";

  it("searches the catalogue for the viewer's own words, beside the filters", async () => {
    const { catalogue } = await openSearch();
    await say(ASKED);
    const reads = catalogue.requests.filter(({ query }) => query === PHRASE);
    assert.ok(reads.length > 0, `the words reached the catalogue: ${JSON.stringify(catalogue.requests.map(({ query }) => query))}`);
    assert.ok(turns()[0].posters.length > 0, "and films came back");
  });

  it("shows the words in the strip and takes them off again", async () => {
    const { catalogue } = await openSearch();
    await say(ASKED);
    const chip = document.querySelector<HTMLButtonElement>(`.search-strip [aria-label="Remove About \u201c${PHRASE}\u201d"]`);
    assert.ok(chip, `the strip offers the subject: ${Array.from(document.querySelectorAll(".search-strip button")).map((button) => button.getAttribute("aria-label")).join(" | ")}`);
    catalogue.requests.length = 0;
    await click(chip);
    await settle(6);
    assert.equal(document.querySelector(`.search-strip [aria-label^="Remove About"]`), null, "the subject is off the strip");
    assert.ok(catalogue.requests.length === 0 || catalogue.requests.every(({ query }) => query === ""), "and no read asks for it any more");
  });

  it("falls back to the filters alone when the words match nothing, and says so", async () => {
    await openSearch("/discover", { unknown: [PHRASE] });
    await say(ASKED);
    const [turn] = turns();
    assert.ok(turn.posters.length > 0, "the screen is not left empty");
    assert.match(turn.caption ?? "", /The words \u201ca family with some pets\u201d found no films/);
    assert.match(
      document.querySelector(".search-strip-notice")?.textContent ?? "",
      /The words \u201ca family with some pets\u201d found no films/,
      "and the strip says the same beside the count",
    );
  });
});

describe("the critic's note", () => {
  const noteOn = (index: number) => cards(0)[index].querySelector(".search-card-note");

  it("writes about the top picks only, and sends the rest of the row as names it may not use", async () => {
    const { assistant } = await openSearch();
    await say("something funny");
    assert.equal(assistant.critiqued.length, 1, "one call for the whole set");
    const [call] = assistant.critiqued;
    const shown = turns()[0].posters;
    assert.equal(call.picks.length, 3, "the top three, never the whole row");
    assert.equal(call.withheld.length, shown.length - 3);
    assert.ok(!call.withheld.includes(shown[0]!), "a pick is never in the list it may not name");
    assert.ok(call.withheld.includes(shown[3]!), "a film it was not given is");
  });

  it("puts why this one and the one thing against it under the poster it is about", async () => {
    await openSearch();
    await say("something funny");
    const note = noteOn(0)!;
    assert.match(note.querySelector(".search-card-why")!.textContent!, /Why cat:2048 and not the others/);
    assert.match(note.querySelector(".search-card-against")!.textContent!, /But.*The one thing wrong with cat:2048/);
    assert.equal(noteOn(3), null, "a film that is not a pick carries no note");
  });

  it("opens the whole note, what watching it is like included, with the film", async () => {
    await openSearch();
    await say("something funny");
    await click(cards(0)[0]);
    const preview = dialog()!;
    assert.equal(preview.querySelector(".search-preview-note-label")?.textContent, "The critic’s note");
    assert.match(preview.querySelector(".search-preview-watching")!.textContent!, /What watching cat:2048 is actually like/);
    assert.match(preview.querySelector(".search-preview-against")!.textContent!, /The one thing wrong with cat:2048/);
  });

  it("shows the films the moment they are ranked, without waiting for the critic", async () => {
    const gate = rankingGate();
    gate.release();
    const { assistant } = await openSearch("/discover", { gate, critic: "silent" });
    await say("something funny");
    assert.equal(turns()[0].posters.length, 12, "the row is full");
    assert.equal(assistant.critiqued.length, 1, "the critic was asked");
    assert.equal(noteOn(0), null, "and said nothing, so the row carries no note");
    assert.ok(
      !turns()[0].lines.some((line) => /critic/i.test(line ?? "")),
      "a critique that never arrives is not an error worth a line in the conversation",
    );
  });

  it("leaves an earlier turn's note alone when a later turn is answered", async () => {
    await openSearch();
    await say("something funny");
    const before = noteOn(0)!.textContent;
    await say("from the nineties");
    assert.equal(noteOn(0)!.textContent, before, "the first answer's note is part of its snapshot");
    assert.ok(document.querySelectorAll(".search-turn")[1].querySelector(".search-card-note"), "and the new turn has its own");
  });
});
