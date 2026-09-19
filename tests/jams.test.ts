import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createJamsRouter } from "../apps/server/jams";

let server: Server;
let baseUrl: string;

before(async () => {
  process.env.REVERIE_LIVE_ENABLED = "false";
  const app = express();
  app.use(createJamsRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

test("rejects an invalid jam command", async () => {
  const response = await fetch(`${baseUrl}/api/jams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { kind: "from-scratch", prompt: "hi" } }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_command");
});

test("rejects an invalid script format", async () => {
  const response = await fetch(`${baseUrl}/api/jams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
      format: { totalSeconds: 5 },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_command");
});

test("refuses generation honestly when live providers are disabled", async () => {
  const response = await fetch(`${baseUrl}/api/jams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "generation_disabled");
});

test("imports a script without calling a live provider and preserves its markdown", async () => {
  const jamId = randomUUID();
  const scriptMarkdown = [
    "# Signal House",
    "",
    "A keeper hears a voice beneath the tide and follows it past the breakwater,",
    "where the old lighthouse answers in a language of long flashes and longer silences.",
    "She counts the gaps the way her grandmother taught her, and the pattern spells a name.",
    "Together they open the sealed door and step into the warm, waiting dark of the stairwell.",
    "Somewhere below, the water has learned to remember every ship it ever swallowed whole.",
    "What they find rewrites the shoreline they both grew up believing was fixed and safe.",
    "By morning the lamp burns green, and the town wakes to a sea that finally answers back.",
  ].join("\n\n");
  const response = await fetch(`${baseUrl}/api/jams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "import",
      jamId,
      source: { kind: "imported-script", scriptTitle: "Signal House" },
      scriptMarkdown,
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.jam.id, jamId);
  assert.equal(body.jam.source.kind, "imported-script");

  const markdown = await fetch(`${baseUrl}/api/jams/${jamId}/script.md`);
  assert.equal(markdown.status, 200);
  assert.equal(await markdown.text(), scriptMarkdown);
});

test("returns 404 for an unknown jam", async () => {
  const response = await fetch(`${baseUrl}/api/jams/does-not-exist`);
  assert.equal(response.status, 404);
});
