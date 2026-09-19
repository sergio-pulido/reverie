import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import type { Jam } from "../src/core/jam";
import { InMemoryJamStore } from "../apps/server/jams";
import { createDirectorRouter } from "../apps/server/director";
import type { DirectorConfig } from "../apps/server/providers/falDirector";
import { DirectorError } from "../apps/server/providers/falDirector";
import { buildScript } from "./helpers";

const CONFIG: DirectorConfig = {
  apiKey: "test-key",
  resolution: "768p",
  aspectRatio: "16:9",
};

// Deliberately roomy: every session here bills fal's 60-second minimum even
// when it is closed immediately, so a realistic $20 budget would run out
// partway through the file. Budget refusal has its own test below.
const LIMITS = {
  budgetUsd: 1000,
  usdPerSecond: 0.08,
  maxConcurrentSessions: 1,
  maxSessionSeconds: 60,
};

const store = new InMemoryJamStore();
/** Offers seen by the fake fal, so tests can assert what was forwarded. */
let offers: { sdp: string }[] = [];
let nextResult: "ok" | "unavailable" = "ok";
let server: Server;
let baseUrl: string;

function buildJam(): Jam {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    format: { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 },
    script: buildScript(5, 2, 2),
  };
}

function openSession(jamId: string, sdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n") {
  return fetch(`${baseUrl}/api/jams/${jamId}/director/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sdp }),
  });
}

before(async () => {
  const app = express();
  app.use(
    createDirectorRouter(store, {
      config: CONFIG,
      limits: LIMITS,
      startSession: async (_config, offer) => {
        offers.push({ sdp: offer.sdp });
        if (nextResult === "unavailable") {
          throw new DirectorError("The director stream did not respond.", true);
        }
        return { type: "answer", sdp: "v=0\r\nanswer\r\n" };
      },
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

test("a session returns fal's answer plus the jam's own configure message", async () => {
  offers = [];
  const jam = buildJam();
  await store.createJam(jam);

  const response = await openSession(jam.id);
  assert.equal(response.status, 201);
  const body = await response.json();

  assert.equal(body.answer.type, "answer");
  assert.equal(body.maxSessionSeconds, 60);
  assert.ok(body.sessionId);
  // The offer reached fal unchanged.
  assert.equal(offers.length, 1);
  assert.match(offers[0].sdp, /^v=0/);
  // The beats come from the jam's script, not from the client.
  assert.equal(body.configure.type, "configure");
  assert.equal(body.configure.script.length, 4);
  assert.deepEqual(
    body.configure.script.map((beat: { offset: number }) => beat.offset),
    [0, 5, 10, 15],
  );

  await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${body.sessionId}/end`, {
    method: "POST",
  });
});

test("the response never carries the API key", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const response = await openSession(jam.id);
  const raw = await response.text();
  assert.doesNotMatch(raw, /test-key/);
  const { sessionId } = JSON.parse(raw);
  await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/end`, {
    method: "POST",
  });
});

test("an unknown jam is refused before any provider call", async () => {
  offers = [];
  const response = await openSession(randomUUID());
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "not_found");
  assert.equal(offers.length, 0);
});

test("a malformed offer is refused before any provider call", async () => {
  offers = [];
  const jam = buildJam();
  await store.createJam(jam);
  const response = await fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sdp: "" }),
  });
  assert.equal(response.status, 400);
  assert.equal(offers.length, 0);
});

test("a jam may hold only one stream, and the slot frees on end", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const first = await openSession(jam.id);
  assert.equal(first.status, 201);
  const { sessionId } = await first.json();

  const second = await openSession(jam.id);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, "already_open");

  const ended = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/end`,
    { method: "POST" },
  );
  assert.equal(ended.status, 204);
  const third = await openSession(jam.id);
  assert.equal(third.status, 201);
  await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${(await third.json()).sessionId}/end`,
    { method: "POST" },
  );
});

test("a failed handshake releases the reservation it took", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  nextResult = "unavailable";
  const failed = await openSession(jam.id);
  assert.equal(failed.status, 502);
  const body = await failed.json();
  assert.equal(body.error.code, "director_unavailable");
  assert.equal(body.error.retryable, true);

  // The jam is not left holding a session that never opened.
  nextResult = "ok";
  const retried = await openSession(jam.id);
  assert.equal(retried.status, 201);
  await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${(await retried.json()).sessionId}/end`,
    { method: "POST" },
  );
});

test("renew is refused for a session that is not open", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/nope/renew`,
    { method: "POST" },
  );
  assert.equal(response.status, 404);
});

test("ending a session twice is not an error", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const { sessionId } = await (await openSession(jam.id)).json();
  const url = `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/end`;
  assert.equal((await fetch(url, { method: "POST" })).status, 204);
  assert.equal((await fetch(url, { method: "POST" })).status, 204);
});

test("the budget refuses a session it cannot pay for", async () => {
  const poor = express();
  poor.use(
    createDirectorRouter(store, {
      config: CONFIG,
      // Enough for exactly one 60-second session at list price ($4.80).
      limits: { ...LIMITS, budgetUsd: 5 },
      startSession: async () => ({ type: "answer", sdp: "v=0\r\n" }),
    }),
  );
  const poorServer = await new Promise<Server>((resolve) => {
    const started = poor.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = poorServer.address();
  assert.ok(address && typeof address === "object");
  const poorUrl = `http://127.0.0.1:${address.port}`;

  const first = buildJam();
  const second = buildJam();
  await store.createJam(first);
  await store.createJam(second);

  const open = (jamId: string) =>
    fetch(`${poorUrl}/api/jams/${jamId}/director/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\n" }),
    });

  const ok = await open(first.id);
  assert.equal(ok.status, 201);
  const { sessionId } = await ok.json();
  await fetch(
    `${poorUrl}/api/jams/${first.id}/director/session/${sessionId}/end`,
    { method: "POST" },
  );

  // Closing it refunds nothing: fal bills a 60-second minimum regardless.
  const refused = await open(second.id);
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.error.code, "budget_exhausted");
  assert.equal(body.error.retryable, false);
  poorServer.close();
});
