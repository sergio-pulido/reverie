import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApiApp } from "../apps/server/app";

// Exercises the real app wiring (health, routers, JSON 404 catch-all) instead
// of mounting routers directly, so middleware-ordering bugs cannot hide.
let server: Server;
let baseUrl: string;

before(async () => {
  process.env.REVERIE_LIVE_ENABLED = "false";
  const app = createApiApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

test("health responds through the real app", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
});

test("jam routes are reachable, not shadowed by the API catch-all", async () => {
  const response = await fetch(`${baseUrl}/api/jams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { kind: "from-scratch", prompt: "hi" } }),
  });
  // The jams router answers 400 invalid_command; the catch-all would 404.
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_command");
});

test("session routes are reachable through the real app", async () => {
  const response = await fetch(`${baseUrl}/api/sessions/does-not-exist`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
});

test("unknown API routes get the JSON 404 catch-all", async () => {
  const response = await fetch(`${baseUrl}/api/definitely-not-a-route`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, "NOT_FOUND");
});
