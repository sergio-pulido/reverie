import { cleanup, click, render, rerender } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { EscapeRoom } from "../src/screens/EscapeRoom";
import type { BeatView, EscapeSnapshot, SegmentView } from "../src/core/escape/session";
import type { EscapeRoomActions } from "../src/screens/useEscapeRoom";

afterEach(cleanup);

/**
 * The panel draws the server's snapshot and nothing else. What these check is
 * that it has nothing of its own to invent: no count it made up, no frame
 * where there is no clip, and no progress that is not scenario state.
 */

const READY: SegmentView = { status: "ready", src: "/api/jams/j/escape-room/segments/loop-1", seconds: 5.184, message: null };

function snapshot(overrides: Partial<EscapeSnapshot> = {}): EscapeSnapshot {
  return {
    jamId: "j",
    scenarioId: "night-audit",
    title: "The Night Audit",
    logline: "One ledger, one night.",
    characterName: "Marit Kessel",
    location: { id: "reading-room", name: "the reading room", description: "Eight empty tables." },
    loop: READY,
    progress: {
      locationId: "reading-room",
      locationName: "the reading room",
      found: [
        { id: "torch", name: "the torch", stateLabel: "lit", here: true },
        { id: "stack-door", name: "the stack door", stateLabel: "magnetically locked", here: true },
      ],
      shut: [{ id: "stack-door", name: "the stack door", stateLabel: "magnetically locked", here: true }],
      carrying: [{ id: "torch", name: "the torch", stateLabel: "lit", here: true }],
      stepsTaken: 2,
      goalReached: false,
      goalDescription: "Get the sealed ledger out through the loading bay.",
    },
    turn: {
      index: 3,
      proposals: [
        { id: "p1", authorName: "Ada", body: "throw the breakers", votes: 2 },
        { id: "p2", authorName: "Bo", body: "read the noticeboard", votes: 0 },
      ],
      yourVote: "p1",
      voters: 2,
    },
    beats: [],
    ended: null,
    spend: { budgetUsd: 20, committedUsd: 3.2, remainingUsd: 16.8 },
    mediaDurable: true,
    ...overrides,
  };
}

function beat(overrides: Partial<BeatView> = {}): BeatView {
  return {
    id: "b1",
    turn: 2,
    proposal: { body: "lift the counter hatch", authorName: "Ada" },
    outcome: "advanced",
    narration: "The hatch lifts without complaint.",
    narrationSource: "nebius",
    changes: ["Finds the torch."],
    media: { status: "ready", src: "/api/jams/j/escape-room/segments/beat-1", seconds: 15.104, message: null },
    at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

const NOTHING: EscapeRoomActions = {
  propose: async () => {},
  vote: async () => {},
  settle: async () => {},
};

function show(state: EscapeSnapshot, options: { isHost?: boolean; actions?: EscapeRoomActions } = {}) {
  return <EscapeRoom
    snapshot={state}
    isHost={options.isHost ?? false}
    displayName="Ada"
    canContribute
    busy={false}
    failure={null}
    actions={options.actions ?? NOTHING}
  />;
}

describe("the escape room panel", () => {
  it("plays the location's loop while the room deliberates", async () => {
    await render(show(snapshot()));
    const loop = document.querySelector<HTMLVideoElement>('[data-testid="escape-loop"]');
    assert.ok(loop, "the loop is on screen");
    assert.equal(loop.getAttribute("src"), READY.src);
    assert.ok(loop.hasAttribute("loop"), "and it loops");
    assert.equal(document.querySelector('[data-testid="escape-beat"]'), null);
    assert.match(document.body.textContent ?? "", /the reading room/);
  });

  it("cuts a finished beat in over the loop, and hands the screen back when it ends", async () => {
    await render(show(snapshot({ beats: [beat()] })));
    const clip = document.querySelector<HTMLVideoElement>('[data-testid="escape-beat"]');
    assert.ok(clip, "the beat cut in");
    assert.equal(clip.getAttribute("src"), "/api/jams/j/escape-room/segments/beat-1");
    assert.equal(document.querySelector('[data-testid="escape-loop"]'), null);
    assert.match(document.body.textContent ?? "", /The hatch lifts without complaint/);

    await act(async () => {
      clip.dispatchEvent(new window.Event("ended", { bubbles: false }));
    });
    assert.ok(document.querySelector('[data-testid="escape-loop"]'), "the loop has the screen again");

    // The same beat must not cut in a second time on the next poll.
    await rerender(show(snapshot({ beats: [beat()] })));
    assert.ok(document.querySelector('[data-testid="escape-loop"]'));
  });

  it("a beat still generating leaves the loop running", async () => {
    await render(show(snapshot({
      beats: [beat({ media: { status: "generating", src: null, seconds: null, message: null } })],
    })));
    assert.ok(document.querySelector('[data-testid="escape-loop"]'));
    assert.match(document.body.textContent ?? "", /filming/);
  });

  it("with no video at all it says so rather than showing a frame", async () => {
    await render(show(snapshot({
      loop: {
        status: "not_configured",
        src: null,
        seconds: null,
        message: "This server is not configured to generate video, so there is none.",
      },
    })));
    assert.equal(document.querySelector("video"), null);
    assert.match(
      document.querySelector(".player-placeholder")?.textContent ?? "",
      /not configured to generate video/,
    );
  });

  it("shows what was found and what is still shut, from scenario state", async () => {
    await render(show(snapshot()));
    const progress = document.querySelector(".escape-progress")!;
    assert.match(progress.textContent ?? "", /Get the sealed ledger out/);
    assert.match(progress.textContent ?? "", /2 things have happened/);
    assert.match(progress.textContent ?? "", /1 still in the way/);
    assert.match(progress.textContent ?? "", /the torch — lit · carried/);
    assert.match(progress.textContent ?? "", /the stack door — magnetically locked/);
  });

  it("lists the proposals with their real votes, and marks this viewer's", async () => {
    const voted: string[] = [];
    await render(show(snapshot(), { actions: { ...NOTHING, vote: async (id) => void voted.push(id) } }));
    const rows = [...document.querySelectorAll(".escape-proposals li")];
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent ?? "", /throw the breakers — Ada, 2 votes/);
    assert.match(rows[1].textContent ?? "", /read the noticeboard — Bo, 0 votes/);
    assert.equal(rows[0].querySelector("button")?.textContent, "Your vote");
    assert.equal(rows[1].querySelector("button")?.textContent, "Vote");
    await click(rows[1].querySelector("button"));
    assert.deepEqual(voted, ["p2"]);
  });

  it("only the host is offered the control that closes the vote", async () => {
    await render(show(snapshot()));
    assert.equal(closeVote(), null);
    await rerender(show(snapshot(), { isHost: true }));
    assert.ok(closeVote(), "the host can close it");
  });

  it("reports committed spend against the ceiling, and says when nothing is kept", async () => {
    await render(show(snapshot()));
    assert.match(document.body.textContent ?? "", /Committed \$3\.20 of this server's \$20\.00 ceiling/);
    assert.doesNotMatch(document.body.textContent ?? "", /lost if this server restarts/);
    await rerender(show(snapshot({ mediaDurable: false })));
    assert.match(document.body.textContent ?? "", /lost if this server restarts/);
  });

  it("an ended session says why and takes the turn away", async () => {
    await render(show(snapshot({
      ended: { reason: "goal", tell: "She goes under the door sideways with the ledger." },
      turn: { index: 9, proposals: [], yourVote: null, voters: 0 },
    }), { isHost: true }));
    assert.match(document.querySelector(".notice")?.textContent ?? "", /goes under the door sideways/);
    assert.equal(document.querySelector("#escape-proposal"), null, "nothing more to propose");
    assert.equal(closeVote(), null);
  });

  it("names the beat the scenario told, rather than implying a model wrote it", async () => {
    await render(show(snapshot({ beats: [beat({ narrationSource: "scenario" })] })));
    const log = document.querySelector('[aria-label="What happened"]')!;
    assert.match(log.textContent ?? "", /told by the scenario/);
    assert.match(log.textContent ?? "", /filmed, 15\.1s/);
    await rerender(show(snapshot({ beats: [beat()] })));
    assert.doesNotMatch(
      document.querySelector('[aria-label="What happened"]')?.textContent ?? "",
      /told by the scenario/,
    );
  });

  it("a refused proposal reads as the reason it was refused", async () => {
    await render(show(snapshot({
      beats: [beat({
        outcome: "failed",
        narration: "The magnetic lock is still holding the door shut.",
        narrationSource: "scenario",
        changes: [],
        media: { status: "absent", src: null, seconds: null, message: null },
      })],
    })));
    const log = document.querySelector('[aria-label="What happened"]')!;
    assert.match(log.textContent ?? "", /refused · not filmed/);
    assert.match(log.textContent ?? "", /The magnetic lock is still holding/);
  });
});

function closeVote(): Element | null {
  return [...document.querySelectorAll("button")].find((button) => button.textContent === "Close the vote") ?? null;
}
