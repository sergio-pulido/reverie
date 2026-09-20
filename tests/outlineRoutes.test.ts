import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { InMemoryJamStore, type PlaybackGuard } from "../apps/server/jams";
import {
  createOutlineRouter,
  type CascadeRunner,
  type OutlineStream,
  type TargetingRunner,
} from "../apps/server/outline";
import { OutlineWriterError } from "../apps/server/outlineWriter";
import { applyCascade } from "../src/core/outlineCascade";
import { buildOutline } from "../src/core/outline";
import { DEFAULT_SCRIPT_FORMAT, jamScriptSchema, type JamScript } from "../src/core/script";
import type { Jam } from "../src/core/jam";
import type { OutlineEditRecord } from "../src/core/outlineEdit";

/** Four 5-second beats: exactly the default format, every beat written. */
function scriptOf(): JamScript {
  return jamScriptSchema.parse({
    title: "The Salt Door",
    logline: "A keeper finds a door at the bottom of the sea.",
    scenes: [
      {
        heading: "EXT. BREAKWATER",
        portions: [
          { durationSeconds: 5, summary: "she hears the tide answer", action: "She listens." },
          { durationSeconds: 5, summary: "she counts the flashes", action: "She counts." },
        ],
      },
      {
        heading: "INT. STAIRWELL",
        portions: [
          { durationSeconds: 5, summary: "the door gives", action: "It opens." },
          { durationSeconds: 5, summary: "the water remembers", action: "It rises." },
        ],
      },
    ],
  });
}

const store = new InMemoryJamStore();
let server: Server;
let baseUrl: string;

/** Tests move the lock boundary by mutating this; every read goes through it. */
let minEditablePortionIndex = 0;
const guard: PlaybackGuard = () => ({ minEditablePortionIndex, stateVersion: 7 });

/** What the fake cascade does on its nth call. Reset before each test. */
type Behaviour = (script: JamScript, edit: { intent: string; beatIndex: number; summary?: string }, call: number) => Promise<JamScript>;
let behaviour: Behaviour;
let cascadeCalls = 0;
const seenBeats: string[][] = [];

/** Rewrites the tail the way a model would, so the result is a valid script. */
const rewriteTail: Behaviour = async (script, edit) => {
  const total = buildOutline(script).length;
  const replacements = Array.from({ length: total - edit.beatIndex }, (_, offset) => ({
    summary:
      offset === 0
        ? edit.intent === "set"
          ? (edit.summary as string)
          : `something else at ${edit.beatIndex}`
        : `after ${edit.beatIndex}, beat ${edit.beatIndex + offset}`,
    action: `Rewritten portion ${edit.beatIndex + offset}.`,
  }));
  return applyCascade(script, edit.beatIndex, replacements);
};

/**
 * The beat chooser, standing in for the model. It picks the LAST beat that can
 * still change, so a test can tell a real choice from "the first one" — which
 * is exactly the failure this route exists to fix.
 */
let aim: TargetingRunner;
const aimed: { direction: string; candidates: number[] }[] = [];

const chooseLast: TargetingRunner = async (_script, direction, candidates) => ({
  beatIndex: candidates[candidates.length - 1].portionIndex,
  summary: `${direction} (rewritten)`,
  reason: "the beat this is most about",
});

const target: TargetingRunner = (script, direction, candidates) => {
  aimed.push({ direction, candidates: candidates.map((beat) => beat.portionIndex) });
  return aim(script, direction, candidates);
};

const cascade: CascadeRunner = async (script, edit) => {
  cascadeCalls += 1;
  seenBeats.push(buildOutline(script).map((beat) => beat.summary ?? ""));
  return behaviour(script, edit, cascadeCalls);
};

/** Streams the queue may send a landed beat to. */
interface FakeStream extends OutlineStream {
  readonly directed: { body: string; beatIndex?: number; authorId?: string }[];
}
let streams: FakeStream[] = [];

function fakeStream(jamId: string, accepted = true, imminentBeat = 2): FakeStream {
  const directed: { body: string; beatIndex?: number; authorId?: string }[] = [];
  return {
    jamId,
    // Where this stream stands: the beat it would generate next.
    beats: {
      currentBeatIndex: imminentBeat - 2,
      lockedBeatIndex: imminentBeat - 1,
      minEditableBeatIndex: imminentBeat,
    },
    directed,
    direct(request) {
      directed.push(request);
      return accepted ? { accepted: true } : { accepted: false, refusal: "beat_locked" };
    },
  };
}

before(async () => {
  const app = express();
  app.use(
    createOutlineRouter(store, guard, {
      cascade: (script, edit) => cascade(script, edit),
      target: (script, direction, candidates) => target(script, direction, candidates),
      window: () => ({
        currentBeatIndex: minEditablePortionIndex === 0 ? null : minEditablePortionIndex - 2,
        lockedBeatIndex: minEditablePortionIndex === 0 ? null : minEditablePortionIndex - 1,
        minEditableBeatIndex: minEditablePortionIndex,
      }),
      streamsFor: (jamId) => streams.filter((stream) => stream.jamId === jamId),
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

beforeEach(() => {
  minEditablePortionIndex = 0;
  behaviour = rewriteTail;
  aim = chooseLast;
  aimed.length = 0;
  cascadeCalls = 0;
  seenBeats.length = 0;
  streams = [];
});

/** A fresh jam, so one test's queue is never another's. */
async function newJam(): Promise<Jam> {
  const jam: Jam = {
    id: randomUUID(),
    createdAt: "2026-09-20T12:00:00.000Z",
    source: { kind: "from-scratch", prompt: "A keeper finds a door at the bottom of the sea." },
    format: DEFAULT_SCRIPT_FORMAT,
    script: scriptOf(),
    lifecycle: "live",
  };
  await store.createJam(jam);
  return jam;
}

function post(jamId: string, body: unknown) {
  return fetch(`${baseUrl}/api/jams/${jamId}/outline/edits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setEdit(beatIndex: number, summary: string, extra: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), intent: "set", beatIndex, summary, ...extra };
}

function direct(jamId: string, body: unknown) {
  return fetch(`${baseUrl}/api/jams/${jamId}/outline/directions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Waits for the jam's worker to finish one edit. */
async function settleEdit(jamId: string, editId: string): Promise<OutlineEditRecord> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/jams/${jamId}/outline/edits/${editId}`);
    const { edit } = (await response.json()) as { edit: OutlineEditRecord };
    if (edit.status === "landed" || edit.status === "failed") return edit;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the edit never settled");
}

/** A promise a test resolves by hand, to hold a cascade open. */
function gate(): { held: Promise<void>; release: () => void } {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

test("the outline is the current revision's beats, with the stream's window on them", async () => {
  const jam = await newJam();
  minEditablePortionIndex = 2;
  const response = await fetch(`${baseUrl}/api/jams/${jam.id}/outline`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.revision, 1);
  assert.equal(body.pending, 0);
  assert.deepEqual(
    body.beats.map((beat: { portionIndex: number; summary: string; startSeconds: number; locked: boolean }) => [
      beat.portionIndex,
      beat.summary,
      beat.startSeconds,
      beat.locked,
    ]),
    [
      [0, "she hears the tide answer", 0, true],
      [1, "she counts the flashes", 5, true],
      [2, "the door gives", 10, false],
      [3, "the water remembers", 15, false],
    ],
  );
  assert.equal(body.window.minEditableBeatIndex, 2);
  // The script comes with it, so a screenplay under the panel follows the
  // revision the beats describe rather than the one the jam was created with.
  assert.equal(body.script.scenes.length, 2);
});

test("a jam with no script on this server says so rather than showing an empty outline", async () => {
  const response = await fetch(`${baseUrl}/api/jams/${randomUUID()}/outline`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "not_found");
});

test("an edit rewrites the tail, lands as one revision, and leaves settled beats alone", async () => {
  const jam = await newJam();
  const response = await post(jam.id, setEdit(1, "she loses the key", { authorId: "host" }));
  assert.equal(response.status, 202);
  const { edit } = await response.json();
  // An edit that meets an idle queue is already being worked on by the time
  // the reply is written; one that meets a busy queue waits its turn.
  assert.ok(["queued", "processing"].includes(edit.status), edit.status);

  const landed = await settleEdit(jam.id, edit.id);
  assert.equal(landed.status, "landed");
  assert.equal(landed.baseRevision, 1);
  assert.equal(landed.revision, 2);
  assert.equal(landed.error, undefined);

  const outline = await (await fetch(`${baseUrl}/api/jams/${jam.id}/outline`)).json();
  assert.deepEqual(
    outline.beats.map((beat: { summary: string }) => beat.summary),
    ["she hears the tide answer", "she loses the key", "after 1, beat 2", "after 1, beat 3"],
  );
  // The cascade changes what happens, never how long it takes.
  assert.deepEqual(
    outline.beats.map((beat: { durationSeconds: number }) => beat.durationSeconds),
    [5, 5, 5, 5],
  );
});

test("a reroll asks for something else without inventing a replacement", async () => {
  const jam = await newJam();
  const response = await post(jam.id, {
    requestId: randomUUID(),
    intent: "reroll",
    beatIndex: 2,
    reason: "too convenient",
  });
  assert.equal(response.status, 202);
  const landed = await settleEdit(jam.id, (await response.json()).edit.id);
  assert.equal(landed.status, "landed");
  assert.equal(landed.summary, undefined);
  assert.equal(landed.reason, "too convenient");
  const outline = await (await fetch(`${baseUrl}/api/jams/${jam.id}/outline`)).json();
  assert.equal(outline.beats[2].summary, "something else at 2");
});

test("the landed beat is sent to every open stream of the jam, and to no other jam's", async () => {
  const jam = await newJam();
  const other = await newJam();
  const mine = [fakeStream(jam.id), fakeStream(jam.id)];
  const theirs = fakeStream(other.id);
  streams = [...mine, theirs];

  const response = await post(jam.id, setEdit(2, "the stair floods", { authorId: "someone" }));
  const landed = await settleEdit(jam.id, (await response.json()).edit.id);
  assert.deepEqual(landed.direction, { sent: 2, refused: 0, skipped: 0 });
  for (const stream of mine) {
    assert.deepEqual(stream.directed, [
      { body: "the stair floods", beatIndex: 2, authorId: "someone" },
    ]);
  }
  assert.deepEqual(theirs.directed, []);
});

test("a stream that refuses the direction is recorded, and the edit still stands", async () => {
  const jam = await newJam();
  streams = [fakeStream(jam.id, false)];
  const response = await post(jam.id, setEdit(2, "the stair floods"));
  const landed = await settleEdit(jam.id, (await response.json()).edit.id);
  // Delivery is best-effort on top of a commit that already happened.
  assert.equal(landed.status, "landed");
  assert.deepEqual(landed.direction, { sent: 0, refused: 1, skipped: 0 });
});

test("with no stream open nothing is sent, and nothing is wrong", async () => {
  const jam = await newJam();
  const response = await post(jam.id, setEdit(0, "she hears nothing at all"));
  const landed = await settleEdit(jam.id, (await response.json()).edit.id);
  assert.equal(landed.status, "landed");
  assert.deepEqual(landed.direction, { sent: 0, refused: 0, skipped: 0 });
});

test("edits are applied one at a time, each on the result of the one before", async () => {
  const jam = await newJam();
  const first = await (await post(jam.id, setEdit(1, "first edit"))).json();
  const second = await (await post(jam.id, setEdit(1, "second edit"))).json();

  const landedFirst = await settleEdit(jam.id, first.edit.id);
  const landedSecond = await settleEdit(jam.id, second.edit.id);
  assert.equal(landedFirst.revision, 2);
  assert.equal(landedSecond.revision, 3);
  assert.equal(landedFirst.baseRevision, 1);
  assert.equal(landedSecond.baseRevision, 2);
  // The second cascade saw the first one's story, not the original: two
  // parallel cascades would each have re-derived the tail from a different
  // starting point and the second would have erased the first.
  assert.equal(seenBeats[0][1], "she counts the flashes");
  assert.equal(seenBeats[1][1], "first edit");
});

test("a replayed request id returns the first outcome instead of editing twice", async () => {
  const jam = await newJam();
  const command = setEdit(1, "only once");
  const first = await post(jam.id, command);
  assert.equal(first.status, 202);
  const { edit } = await first.json();
  await settleEdit(jam.id, edit.id);

  const replay = await post(jam.id, command);
  assert.equal(replay.status, 200);
  const replayed = (await replay.json()).edit;
  assert.equal(replayed.id, edit.id);
  assert.equal(replayed.status, "landed");
  // One cascade was paid for, not two.
  assert.equal(cascadeCalls, 1);
});

test("an edit to a beat the stream already has is refused at the door", async () => {
  const jam = await newJam();
  minEditablePortionIndex = 3;
  const response = await post(jam.id, setEdit(2, "too late for this"));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "portion_locked");
  assert.equal(body.error.retryable, false);
  assert.equal(body.error.lockedIndex, 2);
  assert.equal(body.error.stateVersion, 7);
  assert.equal(cascadeCalls, 0);
});

test("an edit made from a stale view is refused, with the revision to read again", async () => {
  const jam = await newJam();
  const first = await (await post(jam.id, setEdit(1, "moves the story on"))).json();
  await settleEdit(jam.id, first.edit.id);

  const stale = await post(jam.id, setEdit(2, "built on what is gone", { expectedRevision: 1 }));
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.error.code, "stale_state_version");
  assert.equal(body.error.retryable, true);
  assert.equal(body.revision, 2);

  const current = await post(jam.id, setEdit(2, "built on what is there", { expectedRevision: 2 }));
  assert.equal(current.status, 202);
  await settleEdit(jam.id, (await current.json()).edit.id);
});

test("a beat the script does not have is not an edit at all", async () => {
  const jam = await newJam();
  const response = await post(jam.id, setEdit(9, "nowhere"));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_command");
});

test("a command that does not validate is refused before anything is queued", async () => {
  const jam = await newJam();
  const response = await post(jam.id, { intent: "set", beatIndex: 0, summary: "no request id" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_command");
});

test("an edit for a jam with no script here is refused, not queued", async () => {
  const response = await post(randomUUID(), setEdit(0, "nobody's jam"));
  assert.equal(response.status, 404);
});

test("the boundary moving under a running cascade refuses the commit, and the next edit too", async () => {
  const jam = await newJam();
  const held = gate();
  behaviour = async (script, edit, call) => {
    if (call === 1) await held.held;
    return rewriteTail(script, edit, call);
  };
  const first = await (await post(jam.id, setEdit(2, "the stair floods"))).json();
  const second = await (await post(jam.id, setEdit(2, "waiting behind it"))).json();

  // Playback advances while the first cascade is with the provider.
  minEditablePortionIndex = 3;
  held.release();

  const landedFirst = await settleEdit(jam.id, first.edit.id);
  // Paid for and discarded, rather than half-written or applied to a beat the
  // provider already has.
  assert.equal(landedFirst.status, "failed");
  assert.equal(landedFirst.error?.code, "portion_locked");

  const landedSecond = await settleEdit(jam.id, second.edit.id);
  // The one that waited is refused too, visibly, rather than failing silently.
  assert.equal(landedSecond.status, "failed");
  assert.equal(landedSecond.error?.code, "portion_locked");

  const outline = await (await fetch(`${baseUrl}/api/jams/${jam.id}/outline`)).json();
  assert.equal(outline.revision, 1);
  assert.equal(outline.beats[2].summary, "the door gives");
});

test("a direct edit landing under a cascade makes it recompute once, and it still lands", async () => {
  const jam = await newJam();
  behaviour = async (script, edit, call) => {
    if (call === 1) {
      // A portion PATCH lands while the cascade is with the provider.
      await store.updatePortion(jam.id, 3, { action: "Someone else edits." }, 0);
    }
    return rewriteTail(script, edit, call);
  };
  const response = await post(jam.id, setEdit(1, "recomputed and landed"));
  const landed = await settleEdit(jam.id, (await response.json()).edit.id);
  assert.equal(landed.status, "landed");
  assert.equal(cascadeCalls, 2);
  // It committed on top of the other edit, not over it.
  assert.equal(landed.baseRevision, 2);
  assert.equal(landed.revision, 3);
});

test("a script that keeps moving under a cascade gives up rather than overwriting it", async () => {
  const jam = await newJam();
  behaviour = async (script, edit, call) => {
    await store.updatePortion(jam.id, 3, { action: `Someone else, again ${call}.` }, 0);
    return rewriteTail(script, edit, call);
  };
  const response = await post(jam.id, setEdit(1, "never lands"));
  const failed = await settleEdit(jam.id, (await response.json()).edit.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "stale_state_version");
  assert.equal(failed.error?.retryable, true);
  assert.equal(cascadeCalls, 2);
});

test("a rewrite the model could not produce fails the edit and writes nothing", async () => {
  const jam = await newJam();
  behaviour = async () => {
    throw new OutlineWriterError("The rewrite covered 1 beat(s).", "invalid_cascade", true);
  };
  const response = await post(jam.id, setEdit(1, "refused by the model"));
  const failed = await settleEdit(jam.id, (await response.json()).edit.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "invalid_cascade");
  assert.equal(failed.error?.retryable, true);
  const outline = await (await fetch(`${baseUrl}/api/jams/${jam.id}/outline`)).json();
  assert.equal(outline.revision, 1);
});

test("an unexpected failure still settles the edit, so the jam's queue keeps moving", async () => {
  const jam = await newJam();
  behaviour = async (script, edit, call) => {
    if (call === 1) throw new TypeError("something nobody planned for");
    return rewriteTail(script, edit, call);
  };
  const first = await (await post(jam.id, setEdit(1, "breaks the worker"))).json();
  const second = await (await post(jam.id, setEdit(1, "must still run"))).json();

  const failed = await settleEdit(jam.id, first.edit.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "generation_failed");
  const landed = await settleEdit(jam.id, second.edit.id);
  assert.equal(landed.status, "landed");
});

test("a jam whose queue is full refuses the next edit instead of growing forever", async () => {
  const jam = await newJam();
  const held = gate();
  behaviour = async (script, edit, call) => {
    await held.held;
    return rewriteTail(script, edit, call);
  };
  // One is taken up by the worker; ten more wait.
  for (let index = 0; index < 11; index += 1) {
    const response = await post(jam.id, setEdit(0, `queued ${index}`));
    assert.equal(response.status, 202);
  }
  const refused = await post(jam.id, setEdit(0, "one too many"));
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.error.code, "queue_full");
  assert.equal(body.error.retryable, true);

  const outline = await (await fetch(`${baseUrl}/api/jams/${jam.id}/outline`)).json();
  assert.equal(outline.pending, 11);
  held.release();
});

test("the ledger reads newest first and remembers why an edit failed", async () => {
  const jam = await newJam();
  const landed = await (await post(jam.id, setEdit(1, "landed one"))).json();
  await settleEdit(jam.id, landed.edit.id);
  behaviour = async () => {
    throw new OutlineWriterError("no.", "invalid_cascade", true);
  };
  const failed = await (await post(jam.id, setEdit(1, "failed one"))).json();
  await settleEdit(jam.id, failed.edit.id);

  const response = await fetch(`${baseUrl}/api/jams/${jam.id}/outline/edits`);
  assert.equal(response.status, 200);
  const { edits } = (await response.json()) as { edits: OutlineEditRecord[] };
  assert.equal(edits[0].id, failed.edit.id);
  assert.equal(edits[0].status, "failed");
  assert.equal(edits[0].error?.safeMessage, "no.");
  assert.equal(edits[1].id, landed.edit.id);
  assert.equal(edits[1].status, "landed");
});

test("an edit nobody made cannot be read", async () => {
  const jam = await newJam();
  const response = await fetch(`${baseUrl}/api/jams/${jam.id}/outline/edits/${randomUUID()}`);
  assert.equal(response.status, 404);
});

test("with no provider configured no cascade is fabricated", async () => {
  const jam = await newJam();
  const app = express();
  app.use(createOutlineRouter(store, guard, { cascade: null }));
  const disabled = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = disabled.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/jams/${jam.id}/outline/edits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(setEdit(1, "no provider here")),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, "generation_disabled");
    assert.equal(body.error.retryable, false);
    // The outline itself is still readable without a provider.
    const outline = await fetch(`http://127.0.0.1:${address.port}/api/jams/${jam.id}/outline`);
    assert.equal(outline.status, 200);
  } finally {
    disabled.close();
  }
});

test("a room between takes still takes story edits", async () => {
  // Stopping the stream ends the take, not the room: anybody in the room can
  // stop it and anybody can play it again, so the story a stopped room is
  // holding is the one the next take will shoot.
  const jam = await newJam();
  await store.advanceLifecycle(jam.id, "start");
  await store.advanceLifecycle(jam.id, "stop");
  const response = await post(jam.id, setEdit(2, "between the takes"));
  assert.equal(response.status, 202);
  const landed = await settleEdit(jam.id, (await response.json()).edit.id);
  assert.equal(landed.status, "landed");
  const outline = await (await fetch(`${baseUrl}/api/jams/${jam.id}/outline`)).json();
  assert.equal(outline.beats[2].summary, "between the takes");
});

test("a take stopping under a queued edit does not cancel the edit behind it", async () => {
  // The queue is serialized on the room, not on the take. An edit that waited
  // its turn while the stream stopped is still an edit to this room's story,
  // and the beat lock — not the lifecycle — is what refuses one that is too
  // late to matter.
  const jam = await newJam();
  const held = gate();
  behaviour = async (script, edit, call) => {
    if (call === 1) await held.held;
    return rewriteTail(script, edit, call);
  };
  const first = await (await post(jam.id, setEdit(2, "still live"))).json();
  const second = await (await post(jam.id, setEdit(3, "waiting behind it"))).json();

  await store.advanceLifecycle(jam.id, "start");
  await store.advanceLifecycle(jam.id, "stop");
  held.release();

  assert.equal((await settleEdit(jam.id, first.edit.id)).status, "landed");
  assert.equal((await settleEdit(jam.id, second.edit.id)).status, "landed");
});

test("a beat further ahead than the stream's next one is committed but not directed", async () => {
  const jam = await newJam();
  // The stream is about to render beat 2; the edit is for beat 3.
  const stream = fakeStream(jam.id, true, 2);
  streams = [stream];
  const response = await post(jam.id, setEdit(3, "the water remembers a name"));
  const landed = await settleEdit(jam.id, (await response.json()).edit.id);

  assert.equal(landed.status, "landed");
  // A direction carries `replan` and steers what the stream generates NEXT, so
  // sending a beat it will not reach for a while would render it out of order.
  assert.deepEqual(landed.direction, { sent: 0, refused: 0, skipped: 1 });
  assert.deepEqual(stream.directed, []);
  const outline = await (await fetch(`${baseUrl}/api/jams/${jam.id}/outline`)).json();
  assert.equal(outline.beats[3].summary, "the water remembers a name");
});

test("two streams on different beats: only the one about to render it is told", async () => {
  const jam = await newJam();
  const imminent = fakeStream(jam.id, true, 2);
  const behind = fakeStream(jam.id, true, 3);
  streams = [imminent, behind];
  const response = await post(jam.id, setEdit(2, "the stair floods"));
  const landed = await settleEdit(jam.id, (await response.json()).edit.id);

  assert.deepEqual(landed.direction, { sent: 1, refused: 0, skipped: 1 });
  assert.deepEqual(imminent.directed, [{ body: "the stair floods", beatIndex: 2, authorId: undefined }]);
  assert.deepEqual(behind.directed, []);
});

test("a replay after the take stops still reports what the edit did", async () => {
  const jam = await newJam();
  const command = setEdit(2, "the stair floods");
  const first = await post(jam.id, command);
  assert.equal(first.status, 202);
  const landed = await settleEdit(jam.id, (await first.json()).edit.id);
  assert.equal(landed.status, "landed");

  await store.advanceLifecycle(jam.id, "start");
  await store.advanceLifecycle(jam.id, "stop");

  // A retried fetch or a reconnect after the take stopped must be told what
  // its edit did, not be handed a second copy of it: a replay performs
  // nothing, and answering it is what makes the envelope idempotent.
  const replay = await post(jam.id, command);
  assert.equal(replay.status, 200);
  const record = (await replay.json()).edit;
  assert.equal(record.id, landed.id);
  assert.equal(record.status, "landed");
  assert.equal(record.revision, landed.revision);

  // And it is answered as a replay rather than queued again: a genuinely new
  // edit on the same stopped room gets its own record.
  const fresh = await post(jam.id, setEdit(2, "after the take"));
  assert.equal(fresh.status, 202);
  assert.notEqual((await fresh.json()).edit.id, record.id);
});

// A free-text direction — the Director composer's path. The difference from an
// edit is only where the beat number comes from; everything after the choice is
// the same queue, cascade and commit, which is what these check.

test("a direction is aimed at a beat, and the beats after it are re-derived", async () => {
  const jam = await newJam();
  const response = await direct(jam.id, { requestId: randomUUID(), body: "give her a brother" });
  assert.equal(response.status, 202);
  const { edit, target: chosen } = (await response.json()) as {
    edit: OutlineEditRecord;
    target: { beatIndex: number; summary: string; reason?: string };
  };
  // Every beat was on offer, and the choice is the server's, not beat zero's.
  assert.deepEqual(aimed, [{ direction: "give her a brother", candidates: [0, 1, 2, 3] }]);
  assert.equal(chosen.beatIndex, 3);
  assert.equal(edit.beatIndex, 3);
  assert.equal(edit.intent, "set");
  // The record keeps the room's own words next to the model's sentence.
  assert.equal(edit.mechanism, "direction");
  assert.equal(edit.said, "give her a brother");
  assert.equal(edit.chosenBecause, "the beat this is most about");

  const landed = await settleEdit(jam.id, edit.id);
  assert.equal(landed.status, "landed");
  assert.equal(landed.revision, 2);
  const outline = await (await fetch(`${baseUrl}/api/jams/${jam.id}/outline`)).json();
  assert.equal(outline.revision, 2);
  assert.equal(outline.beats[3].summary, "give her a brother (rewritten)");
  assert.equal(outline.beats[0].summary, "she hears the tide answer", "the settled beats stand");
});

test("only the beats that can still change are offered to the chooser", async () => {
  const jam = await newJam();
  minEditablePortionIndex = 2;
  const response = await direct(jam.id, { requestId: randomUUID(), body: "end it in the rain" });
  assert.equal(response.status, 202);
  assert.deepEqual(aimed[0].candidates, [2, 3]);
});

test("a direction that names a beat is aimed at that one, not at the beat it is about", async () => {
  const jam = await newJam();
  const response = await direct(jam.id, {
    requestId: randomUUID(),
    body: "end it in the rain",
    beatIndex: 2,
  });
  assert.equal(response.status, 202);
  // One candidate: the model is only being asked what that beat now reads.
  assert.deepEqual(aimed[0].candidates, [2]);
  const { edit } = (await response.json()) as { edit: OutlineEditRecord };
  assert.equal(edit.beatIndex, 2);
});

test("a direction aimed at a closed beat is refused, and nothing is queued", async () => {
  const jam = await newJam();
  minEditablePortionIndex = 2;
  const response = await direct(jam.id, {
    requestId: randomUUID(),
    body: "change the opening",
    beatIndex: 1,
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "portion_locked");
  assert.equal(body.error.lockedIndex, 1);
  assert.equal(aimed.length, 0, "nothing was chosen for a beat that cannot change");
  const { edits } = (await (await fetch(`${baseUrl}/api/jams/${jam.id}/outline/edits`)).json()) as {
    edits: OutlineEditRecord[];
  };
  assert.deepEqual(edits, []);
});

test("a beat that does not exist is refused before anything is chosen", async () => {
  const jam = await newJam();
  const response = await direct(jam.id, { requestId: randomUUID(), body: "later", beatIndex: 9 });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_command");
  assert.equal(aimed.length, 0);
});

test("with the whole film with the provider there is nothing to aim at", async () => {
  const jam = await newJam();
  minEditablePortionIndex = 4;
  const response = await direct(jam.id, { requestId: randomUUID(), body: "one more thing" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "portion_locked");
  assert.equal(aimed.length, 0);
});

test("a replayed direction returns the first outcome and is never aimed twice", async () => {
  const jam = await newJam();
  const requestId = randomUUID();
  const first = await direct(jam.id, { requestId, body: "give her a brother" });
  const { edit } = (await first.json()) as { edit: OutlineEditRecord };
  await settleEdit(jam.id, edit.id);

  const replay = await direct(jam.id, { requestId, body: "give her a brother" });
  assert.equal(replay.status, 200);
  const again = (await replay.json()) as {
    edit: OutlineEditRecord;
    target: { beatIndex: number; summary: string };
  };
  assert.equal(again.edit.id, edit.id);
  assert.equal(again.target.beatIndex, 3);
  assert.equal(aimed.length, 1, "the replay chose nothing");
});

test("a chooser that cannot answer refuses the direction rather than guessing a beat", async () => {
  const jam = await newJam();
  aim = async () => {
    throw new OutlineWriterError("That direction could not be aimed at a beat.", "invalid_target", true);
  };
  const response = await direct(jam.id, { requestId: randomUUID(), body: "give her a brother" });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_target");
  assert.equal(body.error.safeMessage, "That direction could not be aimed at a beat.");
  const { edits } = (await (await fetch(`${baseUrl}/api/jams/${jam.id}/outline/edits`)).json()) as {
    edits: OutlineEditRecord[];
  };
  assert.deepEqual(edits, [], "nothing was queued");
  assert.equal(cascadeCalls, 0, "and nothing was rewritten");
});

test("a direction the outline has moved under is refused with the revision it moved to", async () => {
  const jam = await newJam();
  const response = await direct(jam.id, {
    requestId: randomUUID(),
    body: "give her a brother",
    expectedRevision: 7,
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "stale_state_version");
  assert.equal(body.revision, 1);
});

test("with no provider configured a direction is refused, never aimed at the opening beat", async () => {
  const jam = await newJam();
  const app = express();
  app.use(createOutlineRouter(store, guard, { cascade: null, target: null }));
  const disabled = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = disabled.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/jams/${jam.id}/outline/directions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: randomUUID(), body: "give her a brother" }),
      },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "generation_disabled");
  } finally {
    disabled.close();
  }
});

test("a landed direction reaches the stream that is about to render its beat", async () => {
  const jam = await newJam();
  // The stream's next beat is 3, which is the one this chooser picks.
  const stream = fakeStream(jam.id, true, 3);
  streams = [stream];
  const response = await direct(jam.id, { requestId: randomUUID(), body: "give her a brother" });
  const { edit } = (await response.json()) as { edit: OutlineEditRecord };
  const landed = await settleEdit(jam.id, edit.id);
  assert.deepEqual(landed.direction, { sent: 1, refused: 0, skipped: 0 });
  assert.deepEqual(stream.directed, [
    { body: "give her a brother (rewritten)", beatIndex: 3, authorId: undefined },
  ]);
});
