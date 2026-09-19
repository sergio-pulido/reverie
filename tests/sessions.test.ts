import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { InMemoryJamStore } from "../apps/server/jams";
import { createSessionsRouter } from "../apps/server/sessions";
import { DEFAULT_SCRIPT_FORMAT } from "../src/core/script";
import type { Jam } from "../src/core/jam";
import { buildScript } from "./helpers";

let server: Server;
let baseUrl: string;
let jam: Jam;

before(async () => {
  const jams = new InMemoryJamStore();
  jam = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    format: DEFAULT_SCRIPT_FORMAT,
    script: buildScript(15),
    lifecycle: "live" as const,
  };
  await jams.createJam(jam);

  const app = express();
  app.use(createSessionsRouter(jams));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

async function createSession(body: unknown = { displayName: "Ramon" }) {
  const response = await fetch(`${baseUrl}/api/jams/${jam.id}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response;
}

test("creates a session with default settings and an owner token", async () => {
  const response = await createSession();
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.session.jamId, jam.id);
  assert.equal(body.session.owner.displayName, "Ramon");
  assert.deepEqual(body.session.settings, { language: "en", ambientation: "" });
  assert.ok(body.ownerToken);
});

test("creates a session with custom language and ambientation", async () => {
  const response = await createSession({
    displayName: "Núria",
    settings: { language: "ca", ambientation: "neon-noir rainy Barcelona" },
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.session.settings.language, "ca");
  assert.equal(body.session.settings.ambientation, "neon-noir rainy Barcelona");
});

test("rejects an invalid language tag", async () => {
  const response = await createSession({
    displayName: "Ramon",
    settings: { language: "not a language!" },
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_command");
});

test("returns 404 when the jam does not exist", async () => {
  const response = await fetch(`${baseUrl}/api/jams/${randomUUID()}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Ramon" }),
  });
  assert.equal(response.status, 404);
});

test("owner can update settings; others cannot", async () => {
  const created = await (await createSession()).json();
  const url = `${baseUrl}/api/sessions/${created.session.id}`;

  const unauthorized = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { language: "es" } }),
  });
  assert.equal(unauthorized.status, 403);

  const wrongToken = await fetch(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${randomUUID()}`,
    },
    body: JSON.stringify({ settings: { language: "es" } }),
  });
  assert.equal(wrongToken.status, 403);

  const updated = await fetch(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${created.ownerToken}`,
    },
    body: JSON.stringify({ settings: { language: "es", ambientation: "westerns at dusk" } }),
  });
  assert.equal(updated.status, 200);
  const body = await updated.json();
  assert.equal(body.session.settings.language, "es");
  assert.equal(body.session.settings.ambientation, "westerns at dusk");

  const fetched = await (await fetch(url)).json();
  assert.equal(fetched.session.settings.language, "es");
});

test("rejects an update that changes nothing", async () => {
  const created = await (await createSession()).json();
  const response = await fetch(`${baseUrl}/api/sessions/${created.session.id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${created.ownerToken}`,
    },
    body: JSON.stringify({ settings: {} }),
  });
  assert.equal(response.status, 400);
});

test("lists a jam's sessions without owner tokens", async () => {
  const response = await fetch(`${baseUrl}/api/jams/${jam.id}/sessions`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.sessions));
  assert.ok(body.sessions.length >= 1);
  for (const session of body.sessions) {
    assert.equal(session.ownerToken, undefined);
  }
});

test("renders a per-session script view with playback settings", async () => {
  const created = await (
    await createSession({
      displayName: "Núria",
      settings: { language: "ca", ambientation: "stormy coastal village" },
    })
  ).json();
  const response = await fetch(`${baseUrl}/api/sessions/${created.session.id}/script.md`);
  assert.equal(response.status, 200);
  const markdown = await response.text();
  assert.match(markdown, /Playback for Núria/);
  assert.match(markdown, /language ca/);
  assert.match(markdown, /stormy coastal village/);
});
