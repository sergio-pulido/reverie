import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createJamsRouter, InMemoryJamStore } from "../apps/server/jams";
import type { Jam } from "../src/core/jam";
import { DEFAULT_SCRIPT_FORMAT } from "../src/core/script";
import { buildScript } from "./helpers";

let server: Server;
let baseUrl: string;
const store = new InMemoryJamStore();
const jam: Jam = {
  id: randomUUID(),
  createdAt: "2026-09-19T12:00:00.000Z",
  source: {
    kind: "from-scratch",
    prompt: "A lighthouse keeper finds a door at the bottom of the sea.",
  },
  format: DEFAULT_SCRIPT_FORMAT,
  script: buildScript(15),
};

before(async () => {
  await store.createJam(jam);
  const app = express();
  app.use(createJamsRouter(store));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

async function putScript(markdown: unknown, id = jam.id) {
  return fetch(`${baseUrl}/api/jams/${id}/script`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
}

test("serves the current revision markdown, edits it live, and reverts", async () => {
  const initial = await fetch(`${baseUrl}/api/jams/${jam.id}/script.md`);
  assert.equal(initial.status, 200);
  const initialMarkdown = await initial.text();
  assert.ok(initialMarkdown.startsWith("# The Salt Door"));

  const edit = await putScript("# The Salt Door, edited live");
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).revision.revision, 2);

  const edited = await fetch(`${baseUrl}/api/jams/${jam.id}/script.md`);
  assert.equal(await edited.text(), "# The Salt Door, edited live");

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

test("lists revision metadata without markdown and serves one revision fully", async () => {
  const list = await fetch(`${baseUrl}/api/jams/${jam.id}/script/revisions`);
  assert.equal(list.status, 200);
  const { revisions } = await list.json();
  assert.ok(revisions.length >= 3);
  assert.equal(revisions[0].markdown, undefined);
  assert.ok(revisions[0].markdownChars > 0);

  const one = await fetch(`${baseUrl}/api/jams/${jam.id}/script/revisions/2`);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).revision.markdown, "# The Salt Door, edited live");
});

test("rejects invalid edits and unknown jams or revisions", async () => {
  assert.equal((await putScript("")).status, 400);
  assert.equal((await putScript("# ok", randomUUID())).status, 404);

  const badRevert = await fetch(`${baseUrl}/api/jams/${jam.id}/script/revert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: 99 }),
  });
  assert.equal(badRevert.status, 409);

  const missing = await fetch(`${baseUrl}/api/jams/${jam.id}/script/revisions/99`);
  assert.equal(missing.status, 404);
});
