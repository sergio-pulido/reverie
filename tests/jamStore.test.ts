import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  InMemoryJamStore,
  JamStoreError,
  withJamLock,
} from "../apps/server/jams";
import { PortionLockedError } from "../src/core/scriptHistory";
import { DEFAULT_SCRIPT_FORMAT } from "../src/core/script";
import type { Jam } from "../src/core/jam";
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
    lifecycle: "live" as const,
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
