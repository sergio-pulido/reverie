import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  InMemoryJamStore,
  JamStoreError,
  withJamLock,
} from "../apps/server/jams";
import {
  getPortionAt,
  PortionLockedError,
  StaleRevisionError,
} from "../src/core/scriptHistory";
import { DEFAULT_SCRIPT_FORMAT } from "../src/core/script";
import type { Jam } from "../src/core/jam";
import type { JamScript } from "../src/core/script";
import { buildScript } from "./helpers";

const EVERYTHING_EDITABLE = 0;

function buildJam(): Jam {
  return {
    id: randomUUID(),
    createdAt: "2026-09-19T12:00:00.000Z",
    source: {
      kind: "from-scratch",
      prompt: "A lighthouse keeper finds a door at the bottom of the sea.",
    },
    format: DEFAULT_SCRIPT_FORMAT,
    script: buildScript(15),
  };
}

test("creating a jam creates revision 1 from the structured script", async () => {
  const store = new InMemoryJamStore();
  const jam = buildJam();
  await store.createJam(jam);
  const current = await store.getCurrentScriptRevision(jam.id);
  assert.equal(current?.revision, 1);
  assert.deepEqual(current?.script, jam.script);
  assert.deepEqual(await store.getScriptAtRevision(jam.id, 1), jam.script);
});

test("rejects creating the same jam id twice", async () => {
  const store = new InMemoryJamStore();
  const jam = buildJam();
  await store.createJam(jam);
  await assert.rejects(
    store.createJam(jam),
    (error: unknown) =>
      error instanceof JamStoreError && error.code === "jam_exists",
  );
});

test("portion edits append revisions and undo restores earlier content", async () => {
  const store = new InMemoryJamStore();
  const jam = buildJam();
  await store.createJam(jam);

  const edited = await store.updatePortion(
    jam.id,
    3,
    { action: "The lamp gutters." },
    EVERYTHING_EDITABLE,
    { authorId: "host" },
  );
  assert.equal(edited.revision, 2);
  assert.equal(edited.authorId, "host");

  const reverted = await store.revertScriptToRevision(
    jam.id,
    1,
    EVERYTHING_EDITABLE,
  );
  assert.equal(reverted.revision, 3);
  assert.equal(reverted.restoredFromRevision, 1);
  assert.deepEqual(reverted.script, jam.script);
  assert.equal((await store.listScriptRevisions(jam.id)).length, 3);
});

test("rejects edits and reverts below the lock boundary", async () => {
  const store = new InMemoryJamStore();
  const jam = buildJam();
  await store.createJam(jam);

  await assert.rejects(
    store.updatePortion(jam.id, 1, { action: "Too late." }, 2),
    (error: unknown) =>
      error instanceof PortionLockedError && error.lockedIndex === 1,
  );

  await store.updatePortion(jam.id, 1, { action: "Edited early." }, 0);
  await assert.rejects(
    store.revertScriptToRevision(jam.id, 1, 2),
    PortionLockedError,
  );
});

test("raises jam_not_found for unknown jams", async () => {
  const store = new InMemoryJamStore();
  assert.equal(await store.getCurrentScriptRevision(randomUUID()), null);
  await assert.rejects(
    store.updatePortion(randomUUID(), 0, { action: "Nope." }, 0),
    (error: unknown) =>
      error instanceof JamStoreError && error.code === "jam_not_found",
  );
});

test("withJamLock serializes work per jam", async () => {
  const order: string[] = [];
  const slow = withJamLock("jam-a", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("slow");
  });
  const fast = withJamLock("jam-a", async () => {
    order.push("fast");
  });
  const other = withJamLock("jam-b", async () => {
    order.push("other");
  });
  await Promise.all([slow, fast, other]);
  assert.deepEqual(
    order.filter((name) => name !== "other"),
    ["slow", "fast"],
  );
  // Other jams are not serialized behind jam-a's lock.
  assert.equal(order[0], "other");
});

/** The same script with one portion's action rewritten, as a cascade would return it. */
function rewritten(script: JamScript, flatIndex: number, action: string): JamScript {
  let index = 0;
  return {
    ...script,
    scenes: script.scenes.map((scene) => ({
      ...scene,
      portions: scene.portions.map((portion) => {
        const current = index;
        index += 1;
        return current === flatIndex ? { ...portion, action } : portion;
      }),
    })),
  };
}

test("committing a whole script lands it as one revision", async () => {
  const store = new InMemoryJamStore();
  const jam = buildJam();
  await store.createJam(jam);
  const landed = await store.commitScript(
    jam.id,
    rewritten(jam.script, 5, "The tail is rewritten."),
    EVERYTHING_EDITABLE,
    { authorId: "host", note: "outline set on beat 5" },
  );
  assert.equal(landed.revision, 2);
  assert.equal(landed.authorId, "host");
  assert.equal(getPortionAt(landed.script, 5)?.portion.action, "The tail is rewritten.");
  // All of it or none of it: the revision holds the whole script, so a reader
  // never sees half a rewritten story.
  assert.equal(getPortionAt(landed.script, 4)?.portion.action, getPortionAt(jam.script, 4)?.portion.action);
});

test("a commit that would rewrite a played or locked portion is refused whole", async () => {
  const store = new InMemoryJamStore();
  const jam = buildJam();
  await store.createJam(jam);
  await assert.rejects(
    store.commitScript(jam.id, rewritten(jam.script, 1, "Too late."), 3),
    (error: unknown) => error instanceof PortionLockedError && error.lockedIndex === 2,
  );
  // Nothing was written, so the room still reads the story it had.
  assert.equal((await store.getCurrentScriptRevision(jam.id))?.revision, 1);
});

test("a commit ahead of the boundary lands while earlier beats are locked", async () => {
  const store = new InMemoryJamStore();
  const jam = buildJam();
  await store.createJam(jam);
  const landed = await store.commitScript(jam.id, rewritten(jam.script, 7, "Still editable."), 3);
  assert.equal(landed.revision, 2);
});

test("a commit computed from a revision that has moved on is refused, not applied over it", async () => {
  const store = new InMemoryJamStore();
  const jam = buildJam();
  await store.createJam(jam);
  // Someone else's edit lands while the cascade is with the provider.
  await store.updatePortion(jam.id, 9, { action: "Another hand." }, EVERYTHING_EDITABLE);
  await assert.rejects(
    store.commitScript(jam.id, rewritten(jam.script, 5, "Stale."), EVERYTHING_EDITABLE, {
      expectedRevision: 1,
    }),
    (error: unknown) =>
      error instanceof StaleRevisionError &&
      error.expectedRevision === 1 &&
      error.currentRevision === 2,
  );
  const current = await store.getCurrentScriptRevision(jam.id);
  assert.equal(current?.revision, 2);
  assert.equal(getPortionAt(current!.script, 9)?.portion.action, "Another hand.");
});

test("a commit naming the current revision lands on top of it", async () => {
  const store = new InMemoryJamStore();
  const jam = buildJam();
  await store.createJam(jam);
  await store.updatePortion(jam.id, 9, { action: "Another hand." }, EVERYTHING_EDITABLE);
  const landed = await store.commitScript(
    jam.id,
    rewritten(jam.script, 5, "Recomputed."),
    EVERYTHING_EDITABLE,
    { expectedRevision: 2 },
  );
  assert.equal(landed.revision, 3);
});
