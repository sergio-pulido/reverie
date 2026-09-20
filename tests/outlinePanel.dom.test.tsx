import { cleanup, click, fill, render } from "./render";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { OutlinePanel } from "../src/screens/OutlinePanel";
import type { OutlineEditRecord } from "../src/core/outlineEdit";

const JAM = "11111111-2222-3333-4444-555555555555";

/** What the server would answer, and what the panel asked it. */
let outline: unknown;
let edits: OutlineEditRecord[];
let outlineStatus = 200;
const posted: { url: string; body: Record<string, unknown> }[] = [];
const originalFetch = globalThis.fetch;

function snapshotOf() {
  return {
    revision: 4,
    script: { title: "The Salt Door", logline: "A keeper finds a door.", scenes: [] },
    pending: 0,
    window: { currentBeatIndex: 0, lockedBeatIndex: 1, minEditableBeatIndex: 2 },
    beats: [
      { portionIndex: 0, summary: "she hears the tide answer", durationSeconds: 5, startSeconds: 0, sceneIndex: 0, sceneHeading: "EXT. BREAKWATER", locked: true },
      { portionIndex: 1, summary: "she counts the flashes", durationSeconds: 5, startSeconds: 5, sceneIndex: 0, sceneHeading: "EXT. BREAKWATER", locked: true },
      { portionIndex: 2, summary: "the door gives", durationSeconds: 5, startSeconds: 10, sceneIndex: 1, sceneHeading: "INT. STAIRWELL", locked: false },
      { portionIndex: 3, durationSeconds: 5, startSeconds: 15, sceneIndex: 1, sceneHeading: "INT. STAIRWELL", locked: false },
    ],
  };
}

beforeEach(() => {
  outline = snapshotOf();
  edits = [];
  outlineStatus = 200;
  posted.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ edit: { id: "e1", status: "queued" } }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/outline")) {
      const body = outlineStatus === 200 ? outline : { error: { code: "not_found", safeMessage: "This jam has no script on this server." } };
      return new Response(JSON.stringify(body), { status: outlineStatus, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ edits }), { status: outlineStatus === 200 ? 200 : 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(async () => {
  await cleanup();
  globalThis.fetch = originalFetch;
});

/** Every beat the panel shows, as a viewer reads it. */
function beats() {
  return Array.from(document.querySelectorAll<HTMLElement>(".outline-beat")).map((beat) => ({
    meta: beat.querySelector(".jam-portion-time")?.textContent ?? "",
    summary: beat.querySelector(".outline-summary")?.textContent ?? "",
    actions: Array.from(beat.querySelectorAll("button")).map((button) => button.textContent),
  }));
}

describe("the outline panel", () => {
  it("shows what has played, what is being generated, and what can still change", async () => {
    await render(<OutlinePanel jamId={JAM} canEdit />);
    const shown = beats();
    assert.equal(shown.length, 4);
    assert.match(shown[0].meta, /BEAT 1 · 0:00 · 5s · PLAYED/);
    assert.match(shown[1].meta, /BEAT 2 · 0:05 · 5s · GENERATING/);
    assert.match(shown[2].meta, /BEAT 3 · 0:10 · 5s · EDITABLE/);
    // A beat already with the provider offers nothing to press: the refusal
    // is the room's window to react, not a surprise after the click.
    assert.deepEqual(shown[0].actions, []);
    assert.deepEqual(shown[1].actions, []);
    assert.deepEqual(shown[2].actions, ["Rewrite", "Not this"]);
  });

  it("says a beat is missing rather than inventing a phrase for it", async () => {
    await render(<OutlinePanel jamId={JAM} canEdit />);
    assert.equal(beats()[3].summary, "No beat yet for this portion.");
    assert.ok(document.querySelector(".outline-summary-missing"));
  });

  it("rewrites a beat as a set carrying the revision the reader was looking at", async () => {
    const container = await render(<OutlinePanel jamId={JAM} canEdit authorId="someone" />);
    const rewrite = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Rewrite");
    await click(rewrite ?? null);
    await fill(container.querySelector(".outline-form input"), "the stair floods");
    await click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.startsWith("Rewrite from here")) ?? null);

    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, `/api/jams/${JAM}/outline/edits`);
    const { requestId, ...command } = posted[0].body;
    assert.deepEqual(command, {
      intent: "set",
      beatIndex: 2,
      summary: "the stair floods",
      expectedRevision: 4,
      mechanism: "direct",
      authorId: "someone",
    });
    assert.match(String(requestId), /^[0-9a-f-]{36}$/);
  });

  it("rejects a beat as a reroll, with no replacement text", async () => {
    const container = await render(<OutlinePanel jamId={JAM} canEdit />);
    await click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Not this") ?? null);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.intent, "reroll");
    assert.equal(posted[0].body.beatIndex, 2);
    assert.equal("summary" in posted[0].body, false);
  });

  it("offers nothing to press to someone who may not contribute", async () => {
    await render(<OutlinePanel jamId={JAM} canEdit={false} />);
    assert.deepEqual(beats().flatMap((beat) => beat.actions), []);
  });

  it("says the script is not on this server instead of showing an empty outline", async () => {
    outlineStatus = 404;
    const container = await render(<OutlinePanel jamId={JAM} canEdit />);
    assert.match(container.textContent ?? "", /No script on this server/);
    assert.equal(beats().length, 0);
  });

  it("shows what the queue did with each edit, in the server's own words", async () => {
    edits = [
      { id: "b", jamId: JAM, requestId: "r2", intent: "reroll", beatIndex: 3, mechanism: "direct", status: "failed", queuedAt: "2026-09-20T12:00:01.000Z", error: { code: "portion_locked", safeMessage: "That beat is already being generated.", retryable: false } },
      { id: "a", jamId: JAM, requestId: "r1", intent: "set", beatIndex: 2, summary: "the stair floods", mechanism: "direct", status: "landed", queuedAt: "2026-09-20T12:00:00.000Z", revision: 4, direction: { sent: 1, refused: 0 } },
    ];
    const container = await render(<OutlinePanel jamId={JAM} canEdit />);
    const ledger = Array.from(container.querySelectorAll<HTMLElement>(".outline-edit")).map((entry) => entry.textContent ?? "");
    assert.equal(ledger.length, 2);
    assert.match(ledger[0], /BEAT 4 · NOT THIS · FAILED/);
    assert.match(ledger[0], /That beat is already being generated\./);
    assert.match(ledger[1], /BEAT 3 · REWRITE · LANDED · REVISION 4/);
    assert.match(ledger[1], /Sent to the live stream\./);
  });
});
