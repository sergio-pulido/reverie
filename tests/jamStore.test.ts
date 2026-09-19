import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { InMemoryJamStore, JamStoreError } from "../apps/server/jams";
import { renderScriptMarkdown } from "../src/core/scriptMarkdown";
import type { Jam } from "../src/core/jam";
import { DEFAULT_SCRIPT_FORMAT } from "../src/core/script";
import { buildScript } from "./helpers";

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

test("creating a jam creates revision 1 from the rendered script", async () => {
  const store = new InMemoryJamStore();
  const jam = buildJam();
  await store.createJam(jam);
  const current = await store.getCurrentScriptRevision(jam.id);
  assert.equal(current?.revision, 1);
  assert.equal(current?.markdown, renderScriptMarkdown(jam.script, jam.source));
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

test("live edits append revisions and undo restores earlier markdown", async () => {
  const store = new InMemoryJamStore();
  const jam = buildJam();
  await store.createJam(jam);
  const original = (await store.getCurrentScriptRevision(jam.id))!.markdown;

  await store.appendScriptRevision(jam.id, "# Edited live");
  const reverted = await store.revertScriptToRevision(jam.id, 1);

  assert.equal(reverted.revision, 3);
  assert.equal(reverted.markdown, original);
  assert.equal(reverted.restoredFromRevision, 1);
  assert.equal((await store.listScriptRevisions(jam.id)).length, 3);
  assert.equal((await store.getScriptRevision(jam.id, 2))?.markdown, "# Edited live");
});

test("raises jam_not_found for revisions of unknown jams", async () => {
  const store = new InMemoryJamStore();
  assert.equal(await store.getCurrentScriptRevision(randomUUID()), null);
  await assert.rejects(
    store.appendScriptRevision(randomUUID(), "# Nope"),
    (error: unknown) =>
      error instanceof JamStoreError && error.code === "jam_not_found",
  );
});
