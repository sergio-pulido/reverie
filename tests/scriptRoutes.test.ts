import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  createJamsRouter,
  InMemoryJamStore,
  type PlaybackGuard,
} from "../apps/server/jams";
import { DEFAULT_SCRIPT_FORMAT } from "../src/core/script";
import type { Jam } from "../src/core/jam";
import { buildScript } from "./helpers";

let server: Server;
let baseUrl: string;
const store = new InMemoryJamStore();
// Tests move the boundary by mutating this; the router reads it per request.
let minEditablePortionIndex = 0;
const guard: PlaybackGuard = () => ({
  minEditablePortionIndex,
  stateVersion: 7,
});
const jam: Jam = {
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

before(async () => {
  await store.createJam(jam);
  const app = express();
  app.use(createJamsRouter(store, guard));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

async function patchPortion(index: number | string, body: unknown, id = jam.id) {
  return fetch(`${baseUrl}/api/jams/${id}/script/portions/${index}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("edits a portion, renders it in script.md, and reverts", async () => {
  const initial = await fetch(`${baseUrl}/api/jams/${jam.id}/script.md`);
  assert.equal(initial.status, 200);
  const initialMarkdown = await initial.text();
  assert.ok(initialMarkdown.startsWith("# The Salt Door"));

  const edit = await patchPortion(2, { action: "The beam sweeps the reef." });
  assert.equal(edit.status, 200);
  const editBody = await edit.json();
  assert.equal(editBody.revision.revision, 2);

  const edited = await fetch(`${baseUrl}/api/jams/${jam.id}/script.md`);
  assert.ok((await edited.text()).includes("The beam sweeps the reef."));

  const revert = await fetch(`${baseUrl}/api/jams/${jam.id}/script/revert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: 1 }),
  });
  assert.equal(revert.status, 200);
  const revertBody = await revert.json();
  assert.equal(revertBody.revision.revision, 3);
  assert.equal(revertBody.revision.restoredFromRevision, 1);

  const restored = await fetch(`${baseUrl}/api/jams/${jam.id}/script.md`);
  assert.equal(await restored.text(), initialMarkdown);
});

test("rejects edits below the lock boundary with portion_locked", async () => {
  minEditablePortionIndex = 3;
  try {
    const locked = await patchPortion(2, { action: "Too late for this." });
    assert.equal(locked.status, 409);
    const body = await locked.json();
    assert.equal(body.error.code, "portion_locked");
    assert.equal(body.error.retryable, false);
    assert.equal(body.error.lockedIndex, 2);
    assert.equal(body.error.stateVersion, 7);

    const editable = await patchPortion(3, { action: "Still editable." });
    assert.equal(editable.status, 200);

    const revert = await fetch(`${baseUrl}/api/jams/${jam.id}/script/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 2 }),
    });
    // Revision 2 differs from current only at portion 2 (locked): rejected.
    assert.equal(revert.status, 409);
    assert.equal((await revert.json()).error.code, "portion_locked");
  } finally {
    minEditablePortionIndex = 0;
  }
});

test("lists revision metadata without scripts and serves one revision fully", async () => {
  const list = await fetch(`${baseUrl}/api/jams/${jam.id}/script/revisions`);
  assert.equal(list.status, 200);
  const { revisions } = await list.json();
  assert.ok(revisions.length >= 3);
  assert.equal(revisions[0].script, undefined);
  assert.ok(revisions[0].createdAt);

  const one = await fetch(`${baseUrl}/api/jams/${jam.id}/script/revisions/2`);
  assert.equal(one.status, 200);
  const { revision } = await one.json();
  assert.equal(revision.script.title, "The Salt Door");
  assert.ok(revision.markdown.includes("The beam sweeps the reef."));
});

test("rejects invalid patches, indices, and unknown jams or revisions", async () => {
  assert.equal((await patchPortion(0, {})).status, 400);
  assert.equal((await patchPortion(0, { durationSeconds: 59 })).status, 409);
  assert.equal((await patchPortion("banana", { action: "x" })).status, 400);
  assert.equal((await patchPortion(99, { action: "x" })).status, 409);
  assert.equal(
    (await patchPortion(0, { action: "x" }, randomUUID())).status,
    404,
  );

  const missing = await fetch(`${baseUrl}/api/jams/${jam.id}/script/revisions/99`);
  assert.equal(missing.status, 404);
});
