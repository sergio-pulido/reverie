import {
  beatCards,
  beatStates,
  JAM_ID,
  openDirector,
  RICH_SPEND,
  SLUG,
  playButton,
  playLiveVideo,
  stopButton,
  turnCards,
  type FakeServer,
} from "./directorScreen";
import { cleanup, click, fill, fire, focusOn, focused, press, render, settle } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DirectorAuditEntry } from "../src/core/directorAudit";
import { liveTopBar } from "../src/shell/topBarFocus";

let server: FakeServer | null = null;

afterEach(async () => {
  await cleanup();
  server?.restore();
  server = null;
  window.localStorage.clear();
});

const text = (selector: string) => document.querySelector(selector)?.textContent ?? "";
const all = (selector: string) => Array.from(document.querySelectorAll(selector)).map((node) => node.textContent ?? "");
const notes = () => all(".director-composer-note").join(" ");
const field = () => document.querySelector<HTMLTextAreaElement>(".director-field textarea");
const sendButton = () => document.querySelector<HTMLButtonElement>(".director-send")!;
/** Each beat's phrase as the row shows it, including "No phrase" where the
    script never wrote one. */
const phrases = () =>
  beatCards().map((card) => card.querySelector(".director-beat-frame")?.textContent ?? "");

/**
 * React derives enter and leave from `mouseover`/`mouseout` at the root, so a
 * raw `mouseenter` — which does not bubble — never reaches its handler. These
 * are the events a real pointer sends when it arrives from outside the page.
 */
const pointerOver = (element: Element) =>
  fire(element, new window.MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
const pointerOut = (element: Element) =>
  fire(element, new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));

describe("where a Director session sits", () => {
  it("opens at /director/:slug under Yours, with no sixth destination added", async () => {
    server = await openDirector();
    assert.equal(window.location.pathname, `/director/${SLUG}`);
    assert.equal(text(".director-head h1"), "The Salt Door");
    const bar = liveTopBar();
    assert.ok(bar, "the shared top bar is on the screen");
    assert.equal(bar!.querySelectorAll("a[data-top-bar-item]").length, 5);
    assert.equal(bar!.querySelector('[aria-current="page"]')?.textContent, "Yours");
  });

  it("is reached from Yours, which offers the two ways to work on a jam", async () => {
    server = await openDirector();
    await render(<div />, "/x");
    await cleanup();
    window.localStorage.setItem(
      "reverie.preview-jams.v1",
      JSON.stringify([
        {
          id: JAM_ID,
          slug: SLUG,
          title: "The Salt Door",
          premise: "A door at the bottom of the sea.",
          visibility: "invite_only",
          status: "draft",
          created_at: "2026-09-20T10:00:00.000Z",
          updated_at: "2026-09-20T10:00:00.000Z",
        },
      ]),
    );
    const { App } = await import("../src/App");
    await render(<App />, "/jams");
    await settle();
    assert.deepEqual(
      all(".registry-ways button").map((label) => label.replace(/\s*→\s*$/, "")),
      ["With people", "Alone"],
    );
    await click(document.querySelectorAll(".registry-ways button")[1]);
    assert.equal(window.location.pathname, `/director/${SLUG}`);
  });

  it("lands a remote on its bar, and Back from there leads to Yours", async () => {
    server = await openDirector();
    assert.equal(focused().getAttribute("aria-current"), "page");
    assert.equal(focused().textContent, "Yours");
    assert.equal(await press("Escape"), true);
    assert.equal(window.location.pathname, "/jams");
  });

  it("Down from the bar enters the page rather than leaving a remote nowhere", async () => {
    server = await openDirector();
    assert.equal(await press("ArrowDown"), true);
    assert.notEqual(focused().closest("[data-top-bar]"), focused().ownerDocument.querySelector("[data-top-bar]"));
    assert.equal(focused().tagName, "BUTTON");
  });
});

describe("the stage, in its three states", () => {
  it("empty asks for the first shot rather than apologising", async () => {
    server = await openDirector();
    assert.equal(document.querySelector(".director-stage")?.getAttribute("data-phase"), "empty");
    assert.equal(text(".director-frame-empty h2"), "What is the first shot?");
    assert.equal(document.querySelector('[data-testid="director-recording"]'), null);
  });

  it("joins the room's existing stream without pressing Start", async () => {
    server = await openDirector({ attachExisting: true });
    await settle();

    assert.equal(document.querySelector(".director-stage")?.getAttribute("data-phase"), "generating");
    assert.match(text(".director-zone-note"), /joined a stream this jam already had open/);
    assert.equal(playButton().disabled, true);
  });

  it("offers nothing until the jam has said whether it is already playing", async () => {
    // The moment between opening the screen and the server answering. A jam
    // that is already running a take hands this screen its stream, so Play
    // here would be an offer to open — and pay for — a second one.
    server = await openDirector({ holdAttach: true });
    await settle();

    assert.equal(playButton().disabled, true);
    assert.match(playButton().textContent ?? "", /Joining/);
    assert.match(text(".director-stage-line"), /Looking for what this jam is playing/);
  });

  it("generating shows the live element, the seconds produced and the beat being made", async () => {
    server = await openDirector({
      offsetSeconds: 12,
      state: { status: "streaming", generatedSeconds: 18, chunksReceived: 3 },
    });
    await click(playButton());
    await settle();

    assert.equal(document.querySelector(".director-stage")?.getAttribute("data-phase"), "generating");
    const live = document.querySelector<HTMLVideoElement>('[data-testid="director-live"]');
    assert.ok(live, "the live element is on the screen");
    assert.equal(live!.hidden, false);
    const line = text(".director-stage-line");
    assert.match(line, /0:18 generated across 3 chunks/);
    // Nothing has decoded a frame yet, so nothing is on screen — and the beat
    // at the provider's frontier must not pretend to be.
    assert.match(line, /No beat is on screen yet/);
    assert.match(line, /Beat 3 is being generated/);
  });

  it("the beat on screen follows the playhead, not the provider's frontier", async () => {
    // The frontier stands still at 12s for the whole test. If the timeline
    // only moved when a chunk landed — which is once per ten seconds — nothing
    // below would ever change. This is the screen-level regression test for
    // "the timeline does not get updated as the film goes on".
    server = await openDirector({
      offsetSeconds: 12,
      state: { status: "streaming", generatedSeconds: 18, chunksReceived: 3 },
    });
    await click(playButton());
    await settle();
    assert.deepEqual(beatStates(), [
      "ready",
      "ready",
      "generating",
      "locked",
      "written",
      "written",
    ]);

    await playLiveVideo(2);
    assert.deepEqual(beatStates().slice(0, 3), ["playing", "ready", "generating"]);
    assert.match(text(".director-stage-line"), /Beat 1 of 6 is on screen/);
    assert.match(text(".director-timeline h2"), /Beat 1 of 6 · 0:02 \/ 0:30/);

    await playLiveVideo(7);
    assert.deepEqual(beatStates().slice(0, 3), ["ready", "playing", "generating"]);
    assert.match(text(".director-stage-line"), /Beat 2 of 6 is on screen/);

    // Caught up to the frontier: the beat being made keeps saying so, and the
    // screen stops claiming a separate beat is on screen.
    await playLiveVideo(12);
    assert.deepEqual(beatStates().slice(0, 3), ["ready", "ready", "generating"]);
    assert.match(text(".director-stage-line"), /No beat is on screen yet/);
  });

  it("a running take shows the clock and how far ahead the provider has got", async () => {
    // The transport used to appear only after Stop, so while the film ran
    // there was no playhead on the screen at all.
    server = await openDirector({
      offsetSeconds: 12,
      state: { status: "streaming", generatedSeconds: 18, chunksReceived: 3 },
    });
    await click(playButton());
    await settle();
    await playLiveVideo(7);

    assert.match(text(".director-transport-clock"), /0:07 \/ 0:30/);
    assert.match(text(".director-transport-clock"), /generated through 0:18/);
    assert.match(text(".director-transport-note"), /cannot be scrubbed/);
    // A running take is not the room's clock, so it offers no controls to drive.
    assert.equal(document.querySelectorAll(".director-transport-button").length, 0);
  });

  it("stops a take once the film has been PLAYED to its end, not generated to it", async () => {
    // The bug this replaced: the take ended when the provider had generated
    // the whole film, which on four measured takes was 17 seconds after Play
    // and 1ms after the last chunk — before hls.js had a playable segment, so
    // the room saw nothing. Generation finishing is not somebody watching.
    server = await openDirector({
      offsetSeconds: 24,
      state: { status: "streaming", generatedSeconds: 30, chunksReceived: 3 },
    });
    await click(playButton());
    await settle();

    // The whole 30s film is generated and the take is still running, because
    // nobody has watched any of it yet.
    assert.equal(document.querySelector(".director-stage")?.getAttribute("data-phase"), "generating");
    assert.equal(stopButton().disabled, false);

    // Watched most of the way: still running.
    await playLiveVideo(20);
    assert.equal(document.querySelector(".director-stage")?.getAttribute("data-phase"), "generating");

    // Watched to the end of the film: now it stops itself.
    await playLiveVideo(30);
    await settle();
    assert.equal(document.querySelector(".director-stage")?.getAttribute("data-phase"), "still");
    assert.match(text(".director-stage-line"), /played to the end of the film/);
    assert.equal(stopButton().disabled, true, "there is nothing left to stop");
    assert.equal(playButton().disabled, false, "and the next take is one press away");

    // The stop says why, so the trail can tell it from a pressed Stop.
    const ends = server.requests.filter((request) => request.includes("/end"));
    assert.equal(ends.length, 1);
  });

  it("still holds the finished session as a frame, with the room's clock under it", async () => {
    server = await openDirector({ offsetSeconds: 12 });
    await click(playButton());
    await settle();
    await click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Stop")!);
    await settle();

    assert.equal(document.querySelector(".director-stage")?.getAttribute("data-phase"), "still");
    const recording = document.querySelector<HTMLVideoElement>('[data-testid="director-recording"]');
    assert.ok(recording, "the recording is held as a frame");
    assert.equal(
      recording!.getAttribute("src"),
      `/api/jams/${JAM_ID}/director/recordings/session-1`,
    );
    // Supabase is not configured here, so the clock says so rather than drawing a position.
    assert.match(text(".director-transport-absent"), /configured Supabase project/);
  });
});

describe("the timeline", () => {
  it("draws every beat with its number, duration and start, and the film's runtime", async () => {
    server = await openDirector();
    assert.equal(beatCards().length, 6);
    assert.match(text(".director-timeline h2"), /6 beats · 0:30/);
    assert.deepEqual(all(".director-beat-number"), ["1", "2", "3", "4", "5", "6"]);
    assert.deepEqual(all(".director-beat-time"), ["0:00", "0:05", "0:10", "0:15", "0:20", "0:25"]);
    assert.deepEqual(all(".director-beat-duration"), Array(6).fill("5s"));
  });

  it("says plainly that no beat has a still, rather than drawing an empty one", async () => {
    server = await openDirector();
    assert.match(text(".director-timeline .director-zone-note"), /No beat has a still/);
    assert.equal(document.querySelector(".director-beat-frame img"), null);
    assert.deepEqual(all(".director-beat-unnamed"), Array(6).fill("No phrase"));
  });

  it("with no session every beat is written", async () => {
    server = await openDirector();
    assert.deepEqual(beatStates(), Array(6).fill("written"));
  });

  it("with the stream on beat three, earlier beats are ready, the next is locked", async () => {
    server = await openDirector({ offsetSeconds: 12 });
    await click(playButton());
    await settle();
    assert.deepEqual(beatStates(), [
      "ready",
      "ready",
      "generating",
      "locked",
      "written",
      "written",
    ]);
    assert.deepEqual(all(".director-beat-state"), [
      "Ready",
      "Ready",
      "Generating",
      "Locked",
      "Written",
      "Written",
    ]);
  });

  it("reads the same at three beats and at twenty-four: the row scrolls rather than shrinking", async () => {
    const { buildScript } = await import("./helpers");
    const { jamOf } = await import("./directorScreen");
    server = await openDirector({ jam: jamOf(buildScript(5, 4, 6)) });
    assert.equal(beatCards().length, 24);
    assert.match(text(".director-timeline h2"), /24 beats · 2:00/);
    const row = document.querySelector<HTMLElement>(".director-beats");
    assert.ok(row);
    assert.equal(row!.getAttribute("data-track"), "", "it is a sideways track, not a wrapping grid");
  });
});

describe("spend, against the server's ceiling", () => {
  it("is zero before a session, in US dollars, against FAL_ASSET_BUDGET_USD", async () => {
    server = await openDirector();
    assert.equal(text(".director-spend-figure"), "$0.00 of $20.00");
    assert.match(text(".director-spend-note"), /0:00 generated · \$20\.00 left/);
  });

  it("is the provider's real bill once a session is open, from generated seconds", async () => {
    server = await openDirector({
      spend: { ...RICH_SPEND, sessionUsd: 7.2, remainingUsd: 12.8 },
      state: { status: "streaming", generatedSeconds: 90, chunksReceived: 6 },
    });
    await click(playButton());
    await settle();
    assert.equal(text(".director-spend-figure"), "$7.20 of $20.00");
    assert.match(text(".director-spend-note"), /1:30 generated · \$12\.80 left/);
  });

  it("an unconfigured budget is zero and says nothing can be generated", async () => {
    server = await openDirector({
      spend: { ...RICH_SPEND, budgetUsd: 0, remainingUsd: 0 },
    });
    assert.equal(text(".director-spend-figure"), "$0.00 of $0.00");
    assert.match(text(".director-spend-note"), /No director budget is configured/);
  });
});

describe("when the ceiling is reached", () => {
  it("blocks the next beat on the timeline and says so in the composer", async () => {
    server = await openDirector({
      spend: { ...RICH_SPEND, sessionUsd: 19.8, remainingUsd: 0.2 },
    });
    // $0.20 buys two and a half seconds: not one five-second beat.
    assert.deepEqual(beatStates(), Array(6).fill("blocked"));
    assert.match(notes(), /Only \$0\.20 of the director budget is left, so beat 1 onward is blocked/);
  });

  it("a spent budget refuses to open a session at all, and the stage says why", async () => {
    server = await openDirector({
      spend: { ...RICH_SPEND, sessionUsd: 20, remainingUsd: 0 },
    });
    assert.match(text(".director-stage-line"), /budget for this server is spent/);
    assert.equal(playButton().disabled, true);
  });

  it("what the stream is doing is never overwritten by what the budget says", async () => {
    // Twenty cents will not buy another five-second beat, but the stream is
    // already running and keeps saying what it is doing.
    server = await openDirector({
      offsetSeconds: 12,
      spend: { ...RICH_SPEND, sessionUsd: 19.8, remainingUsd: 0.2 },
    });
    await click(playButton());
    await settle();
    assert.deepEqual(beatStates(), ["ready", "ready", "generating", "locked", "blocked", "blocked"]);
  });
});

describe("the direction column", () => {
  const trail: DirectorAuditEntry[] = [
    { at: "2026-09-20T10:00:02.000Z", kind: "direction_sent", promptVersion: 2, body: "Cut to the lighthouse at dusk.", scriptOffsetSeconds: 12 },
    { at: "2026-09-20T10:00:03.000Z", kind: "direction_applied", promptVersion: 2 },
    { at: "2026-09-20T10:00:05.000Z", kind: "direction_sent", promptVersion: 3, body: "Make beat five rain.", beatIndex: 4 },
  ];

  it("carries each turn's beat tag in that beat's own state", async () => {
    server = await openDirector({ offsetSeconds: 12, audit: trail });
    await click(playButton());
    await settle();

    const tags = Array.from(document.querySelectorAll<HTMLElement>(".director-turn .director-tag"));
    // Newest turn first.
    assert.deepEqual(tags.map((tag) => tag.textContent?.replace(/ · .*/, "")), ["Beat 5", "Beat 3"]);
    assert.equal(tags[0].dataset.state, "written", "beat five can still change");
    assert.equal(tags[1].dataset.state, "generating", "beat three is the one on screen");
    assert.deepEqual(all(".director-turn-outcome"), ["pending", "applied"]);
  });

  it("hovering a turn lights its beat, and hovering a beat lights its turns", async () => {
    server = await openDirector({ offsetSeconds: 12, audit: trail });
    await click(playButton());
    await settle();

    await pointerOver(turnCards()[0]);
    assert.equal(beatCards()[4].hasAttribute("data-linked"), true, "beat five is lit from its turn");

    await pointerOut(turnCards()[0]);
    assert.equal(beatCards()[4].hasAttribute("data-linked"), false);

    await pointerOver(beatCards()[4]);
    assert.equal(turnCards()[0].hasAttribute("data-linked"), true, "the turn is lit from its beat");
    assert.equal(turnCards()[1].hasAttribute("data-linked"), false, "and only that turn");

    // A remote never touches the page, so focus lights the pair too.
    await pointerOut(beatCards()[4]);
    await focusOn(beatCards()[4]);
    assert.equal(turnCards()[0].hasAttribute("data-linked"), true, "focus lights it as hovering does");
  });

  it("a turn the trail records no beat for says so, rather than claiming the first", async () => {
    server = await openDirector({
      audit: [{ at: "2026-09-20T10:00:02.000Z", kind: "direction_sent", promptVersion: 2, body: "Open on water." }],
    });
    await click(playButton());
    await settle();
    assert.equal(text(".director-tag-none"), "No beat");
  });

  it("with nothing asked for it says what the next thing said will do", async () => {
    server = await openDirector();
    assert.match(
      text(".director-directions .director-empty-line"),
      /changes the story the next take will play/,
    );
  });
});

describe("the two modes", () => {
  it("offers Direct and Review as the most prominent control after the stage, Direct first", async () => {
    server = await openDirector();
    const modes = Array.from(document.querySelectorAll<HTMLButtonElement>(".director-mode"));
    assert.deepEqual(modes.map((mode) => mode.querySelector(".director-mode-label")?.textContent), ["Direct", "Review"]);
    assert.equal(modes[0].getAttribute("aria-pressed"), "true");
    // It sits between the stage and the timeline, in document order.
    const stageNode = document.querySelector(".director-stage")!;
    const switchNode = document.querySelector(".director-modes")!;
    const timelineNode = document.querySelector(".director-timeline")!;
    assert.equal(stageNode.compareDocumentPosition(switchNode) & 4, 4);
    assert.equal(switchNode.compareDocumentPosition(timelineNode) & 4, 4);
  });

  it("Review opens per-beat tools and says plainly that there are no variants", async () => {
    server = await openDirector();
    assert.equal(document.querySelector(".director-review"), null);
    await click(document.querySelectorAll(".director-mode")[1]);
    assert.match(text(".director-review .director-empty-line"), /Choose a beat/);
    assert.match(
      all(".director-review .director-zone-note").join(" "),
      /No variants: nothing in this build generates a second take/,
    );
    assert.match(all(".director-review .director-zone-note").join(" "), /No reference library/);
  });

  it("choosing a beat aims the composer at it, and Review reads that beat back", async () => {
    server = await openDirector({ offsetSeconds: 12 });
    await click(playButton());
    await settle();
    await click(document.querySelectorAll(".director-mode")[1]);
    await click(beatCards()[4]);

    assert.match(text(".director-review h2"), /Beat 5 · 5s · Written/);
    assert.match(text(".director-aim"), /Aimed at beat 5/);
  });

  it("a beat already with the provider says direction aimed at it will be refused", async () => {
    server = await openDirector({ offsetSeconds: 12 });
    await click(playButton());
    await settle();
    await click(document.querySelectorAll(".director-mode")[1]);
    await click(beatCards()[3]);
    assert.match(text(".director-review h2"), /Beat 4 · 5s · Locked/);
    assert.match(all(".director-review .director-zone-note").join(" "), /will be refused/);
  });
});

describe("the composer", () => {
  it("leads with the microphone, then the field, with Direct on a row of its own", async () => {
    server = await openDirector();
    const row = document.querySelector(".director-composer-row")!;
    assert.ok(row.children[0].classList.contains("voice-control"), "the microphone comes first");
    assert.ok(row.children[1].classList.contains("director-field"));
    assert.ok(row.children[2].classList.contains("director-attach"), "and something to show it");
    assert.ok(row.children[3].classList.contains("director-send"));
    assert.ok(row.querySelector('input[type="file"]'));
  });

  it("a dropped file fans out four labels, and picking one says it can go no further", async () => {
    server = await openDirector();
    const input = document.querySelector<HTMLInputElement>('.director-attach input[type="file"]')!;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "reference.png", { type: "image/png" })],
      configurable: true,
    });
    await fire(input, new window.Event("change", { bubbles: true }));

    assert.match(text(".director-attached-file"), /reference\.png/);
    assert.deepEqual(all(".director-intent-label"), ["The look", "A character", "A place", "A shot"]);

    await click(document.querySelectorAll(".director-intent")[1]);
    assert.match(notes(), /no reference store/);
  });

  it("a stopped stream still takes a direction, and says what it changes", async () => {
    server = await openDirector();
    await settle();
    assert.match(notes(), /The stream is stopped, so this changes the story/);
    await fill(field(), "Give her a brother.");
    assert.equal(sendButton().disabled, false, "the story can be directed between takes");
  });

  it("with no outline on this server there is nothing to direct", async () => {
    server = await openDirector({ jam: null });
    await settle();
    assert.match(notes(), /holds no outline for the film/);
    await fill(field(), "Give her a brother.");
    assert.equal(sendButton().disabled, true);
  });
});

/**
 * The composer's real path: what is said changes the story, at the beat it is
 * about. Before this, every direction reached the provider as a steering
 * prompt and so only ever changed whatever was being generated — the opening
 * beat, in practice, which is what the room saw and reported.
 */
describe("directing the story", () => {
  it("aims what is said at a beat the server chooses, not at the opening one", async () => {
    server = await openDirector({ offsetSeconds: 12, aimAt: 4 });
    await click(playButton());
    await settle();
    const before = phrases();

    await fill(field(), "Give her a brother.");
    await click(sendButton());
    await settle();

    // The screen says what it wants, never where it goes.
    assert.deepEqual(server.directions, [{ body: "Give her a brother." }]);
    const after = phrases();
    assert.match(after[4], /Give her a brother\./, "it landed on the beat the server chose");
    assert.notEqual(after[5], before[5], "and every beat after it was re-derived");
    assert.deepEqual(after.slice(0, 4), before.slice(0, 4), "the beats before it are untouched");
  });

  it("a beat chosen on the timeline pins the aim instead", async () => {
    server = await openDirector({ offsetSeconds: 12 });
    await click(playButton());
    await settle();
    await click(beatCards()[5]);

    await fill(field(), "End it in the rain.");
    await click(sendButton());
    await settle();

    assert.deepEqual(server.directions, [{ body: "End it in the rain.", beatIndex: 5 }]);
    assert.match(phrases()[5], /End it in the rain\./);
  });

  it("marks the beats the rewrite moved, since only their words changed", async () => {
    server = await openDirector({ offsetSeconds: 12, aimAt: 4 });
    await click(playButton());
    await settle();
    await fill(field(), "Give her a brother.");
    await click(sendButton());
    await settle();

    assert.deepEqual(
      beatCards().map((card) => card.hasAttribute("data-changed")),
      [false, false, false, false, true, true],
    );
    assert.equal(
      beatCards()[4].querySelector(".director-beat-state")?.textContent,
      "Rewritten",
    );
  });

  it("the column says what was asked for, where it landed and what it now reads", async () => {
    server = await openDirector({ offsetSeconds: 12, aimAt: 4 });
    await click(playButton());
    await settle();
    await fill(field(), "Give her a brother.");
    await click(sendButton());
    await settle();

    const ask = document.querySelector<HTMLElement>(".director-turn")!;
    assert.equal(ask.querySelector(".director-turn-body")?.textContent, "Give her a brother.");
    assert.match(ask.querySelector(".director-turn-landed")?.textContent ?? "", /Beat 5 now reads/);
    assert.match(ask.querySelector(".director-tag")?.textContent ?? "", /Beat 5/);
    assert.match(ask.querySelector(".director-turn-outcome")?.textContent ?? "", /landed · revision 2/);
    assert.equal(ask.dataset.status, "landed");
  });

  it("a refused direction is reported in the server's words, and nothing is claimed", async () => {
    server = await openDirector({
      offsetSeconds: 12,
      refuseDirection: {
        status: 502,
        code: "invalid_target",
        message: "That direction could not be aimed at a beat.",
      },
    });
    await click(playButton());
    await settle();
    const before = phrases();

    await fill(field(), "Give her a brother.");
    await click(sendButton());
    await settle();

    assert.match(all(".notice").join(" "), /could not be aimed at a beat/);
    assert.deepEqual(phrases(), before, "the story is unchanged");
    assert.equal(field()?.value, "Give her a brother.", "and what was said is still in the field");
  });
});

describe("deliverables", () => {
  it("offers the four, each in its real state, with no control for what does not exist", async () => {
    server = await openDirector();
    await click(document.querySelector(".director-drawer-toggle"));

    const rows = Array.from(document.querySelectorAll<HTMLElement>(".director-deliverable"));
    assert.deepEqual(
      rows.map((row) => row.querySelector(".director-deliverable-name")?.textContent),
      [
        "The scriptReady",
        "The timed scriptReady",
        "The audio descriptionNot made",
        "The video fileNot made",
      ],
    );
    assert.equal(rows[0].querySelector("a")?.getAttribute("href"), `/api/jams/${JAM_ID}/script.md`);
    assert.ok(rows[1].querySelector("button"), "the timed script is written here");
    assert.equal(rows[2].querySelector("a, button"), null, "nothing to press for a file that is not made");
    assert.equal(rows[3].querySelector("a, button"), null);
    assert.match(rows[2].querySelector(".director-deliverable-missing")?.textContent ?? "", /no describer/i);
  });

  it("the video is generating while a session runs and ready once it stops", async () => {
    server = await openDirector();
    await click(playButton());
    await settle();
    await click(document.querySelector(".director-drawer-toggle"));
    const running = Array.from(document.querySelectorAll<HTMLElement>(".director-deliverable"))[3];
    assert.equal(running.dataset.state, "generating");
    assert.equal(running.querySelector("a, button"), null);

    await click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Stop")!);
    await settle();
    const done = Array.from(document.querySelectorAll<HTMLElement>(".director-deliverable"))[3];
    assert.equal(done.dataset.state, "ready");
    assert.equal(
      done.querySelector("a")?.getAttribute("href"),
      `/api/jams/${JAM_ID}/director/recordings/session-1`,
    );
  });
});

describe("what the screen does not know", () => {
  it("a room whose script this server does not hold says so, and offers nothing made from it", async () => {
    server = await openDirector({ jam: null });
    assert.equal(beatCards().length, 0);
    assert.match(text(".director-timeline .director-empty-line"), /holds no script/);
    assert.match(text(".director-stage-line"), /holds no script/);
    assert.equal(playButton().disabled, true);

    await click(document.querySelector(".director-drawer-toggle"));
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".director-deliverable"));
    assert.deepEqual(rows.map((row) => row.dataset.state), ["absent", "absent", "absent", "absent"]);
    assert.equal(document.querySelectorAll(".director-deliverable a, .director-deliverable button").length, 0);
  });

  it("a server with no director configured says that, not that the budget ran out", async () => {
    server = await openDirector({ configured: false });
    assert.match(text(".director-stage-line"), /not configured on this server/);
  });
});

describe("the remote's focus model", () => {
  it("walks the beats with Left and Right and stops at the ends", async () => {
    server = await openDirector();
    await focusOn(beatCards()[0]);
    assert.equal(await press("ArrowRight"), true);
    assert.equal(focused(), beatCards()[1]);
    assert.equal(await press("ArrowLeft"), true);
    assert.equal(focused(), beatCards()[0]);
    assert.equal(await press("ArrowLeft"), true, "the edge is taken, not passed through");
    assert.equal(focused(), beatCards()[0]);
  });

  it("Down from the timeline reaches the composer, and Up returns", async () => {
    server = await openDirector();
    await focusOn(beatCards()[0]);
    assert.equal(await press("ArrowDown"), true);
    assert.ok(focused().classList.contains("voice-control"), "the microphone is the way in");
    assert.equal(await press("ArrowUp"), true);
    assert.equal(focused(), beatCards()[0]);
  });
});
