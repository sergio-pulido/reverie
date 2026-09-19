import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
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
      format: { totalSeconds: 30 },
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

test("returns 404 for an unknown jam", async () => {
  const response = await fetch(`${baseUrl}/api/jams/does-not-exist`);
  assert.equal(response.status, 404);
});
