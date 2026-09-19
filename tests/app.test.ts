import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApiApp } from "../apps/server/app";
import { InMemoryJamStore } from "../apps/server/jams";
import { InMemoryDirectorIndexStore } from "../apps/server/directorIndex";
import { InMemoryDirectorRecordingStore } from "../apps/server/directorRecordings";
import { FakeDirectorPeer } from "./fakeDirectorPeer";
import { buildScript } from "./helpers";

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

test("the live writer and archive reader share the app's resolved index", async () => {
  const jamStore = new InMemoryJamStore();
  const index = new InMemoryDirectorIndexStore();
  const recordings = new InMemoryDirectorRecordingStore();
  const jam = {
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: new Date(0).toISOString(),
    source: { kind: "from-scratch" as const, prompt: "A lighthouse keeper finds a door." },
    format: { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 },
    script: buildScript(5, 2, 2),
    lifecycle: "live" as const,
  };
  await jamStore.createJam(jam);
  const app = createApiApp(jamStore, {
    directorIndex: index,
    directorRecordings: recordings,
    director: {
      config: {
        apiKey: "test-key",
        resolution: "768p",
        aspectRatio: "16:9",
        record: false,
      },
      limits: {
        budgetUsd: 100,
        usdPerSecond: 0.08,
        maxConcurrentSessions: 1,
        maxSessionSeconds: 60,
      },
      createPeer: () => new FakeDirectorPeer(),
      startSession: async () => "v=0\r\nanswer\r\n",
    },
  });
  const isolated = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => isolated.once("listening", resolve));
  const address = isolated.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const opened = await fetch(`${url}/api/jams/${jam.id}/director/session`, {
      method: "POST",
    });
    assert.equal(opened.status, 201);
    const { sessionId } = await opened.json();

    const archived = await fetch(`${url}/api/jams/${jam.id}/director/archive`);
    assert.equal(archived.status, 200);
    assert.ok(
      (await archived.json()).sessions.some(
        (session: { id: string }) => session.id === sessionId,
      ),
      "the archive router reads the session written by the live router",
    );
    await fetch(`${url}/api/jams/${jam.id}/director/session/${sessionId}/end`, {
      method: "POST",
    });
  } finally {
    isolated.close();
  }
});
