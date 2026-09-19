import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import type { Jam } from "../src/core/jam";
import { InMemoryJamStore } from "../apps/server/jams";
import { createDirectorRouter } from "../apps/server/director";
import { InMemoryDirectorRecordingStore } from "../apps/server/directorRecordings";
import type { DirectorConfig } from "../apps/server/providers/falDirector";
import { FakeDirectorPeer } from "./fakeDirectorPeer";
import { buildScript } from "./helpers";

/**
 * Live HLS delivery, from the routes' side.
 *
 * No media flows here: the fake peer never emits a track, so these cover the
 * shape a viewer meets — what is served, what is refused, and what is cacheable
 * — without depending on a muxer. What happens once frames actually arrive is
 * only knowable from a real session, and is not claimed by these tests.
 */

const CONFIG: DirectorConfig = {
  apiKey: "test-key",
  resolution: "480p",
  aspectRatio: "16:9",
  // Capture stays off: these cover delivery's shape, and the WebM recorder is
  // the thing that pins the event loop.
  record: false,
};
const LIMITS = {
  budgetUsd: 1000,
  usdPerSecond: 0.08,
  maxConcurrentSessions: 4,
  maxSessionSeconds: 60,
};

const store = new InMemoryJamStore();
let delivering: { server: Server; baseUrl: string };
let withheld: { server: Server; baseUrl: string };

async function listen(liveDelivery: boolean): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(
    createDirectorRouter(store, {
      config: CONFIG,
      limits: LIMITS,
      recordings: new InMemoryDirectorRecordingStore(),
      liveDelivery,
      createPeer: () => new FakeDirectorPeer(),
      startSession: async () => "v=0\r\nanswer\r\n",
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function openSession(baseUrl: string): Promise<{
  jam: Jam;
  sessionId: string;
  viewerId: string;
}> {
  const jam: Jam = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    format: { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 },
    script: buildScript(5, 2, 2),
  };
  await store.createJam(jam);
  const response = await fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { jam, sessionId: body.sessionId, viewerId: body.viewerId };
}

before(async () => {
  delivering = await listen(true);
  withheld = await listen(false);
});

after(async () => {
  await new Promise<void>((resolve) => delivering.server.close(() => resolve()));
  await new Promise<void>((resolve) => withheld.server.close(() => resolve()));
});

test("opening a stream issues the viewer an id of the server's choosing", async () => {
  const { jam, sessionId, viewerId } = await openSession(delivering.baseUrl);
  assert.equal(typeof viewerId, "string");
  assert.ok(viewerId.length > 0);
  // A second viewer on the same configuration shares the stream and gets an id
  // of their own, which is what lets the stream outlive either of them leaving.
  const second = await fetch(`${delivering.baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
  });
  assert.equal(second.status, 200);
  const body = await second.json();
  assert.equal(body.sessionId, sessionId);
  assert.equal(body.attached, true);
  assert.notEqual(body.viewerId, viewerId);
});

test("a viewer leaving does not stop the film for the one still watching", async () => {
  const { jam, sessionId, viewerId } = await openSession(delivering.baseUrl);
  const second = await fetch(`${delivering.baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
  });
  const { viewerId: secondViewer } = await second.json();

  const left = await fetch(
    `${delivering.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/end`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewerId }),
    },
  );
  assert.equal(left.status, 204);
  // Still open, because somebody is still watching it.
  const playlist = await fetch(
    `${delivering.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/playlist.m3u8`,
  );
  assert.equal(playlist.status, 200);

  const lastOut = await fetch(
    `${delivering.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/end`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewerId: secondViewer }),
    },
  );
  assert.equal(lastOut.status, 204);
  // The last viewer leaving settles the session rather than leaving it to be
  // reclaimed 90 seconds later, which would bill the whole silence.
  const gone = await fetch(
    `${delivering.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/playlist.m3u8`,
  );
  assert.equal(gone.status, 404);
});

test("a playlist with no segments yet is still served, and never cached", async () => {
  const { jam, sessionId } = await openSession(delivering.baseUrl);
  const response = await fetch(
    `${delivering.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/playlist.m3u8`,
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/vnd\.apple\.mpegurl/,
  );
  // A cached playlist strands a player a window behind live.
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.match(text, /#EXTM3U/);
  assert.match(text, /#EXT-X-MAP:URI="init\.mp4"/);
  assert.ok(!text.includes("#EXTINF"));
});

test("a server not delivering live says so, rather than serving an empty film", async () => {
  const { jam, sessionId } = await openSession(withheld.baseUrl);
  const response = await fetch(
    `${withheld.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/playlist.m3u8`,
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "live_delivery_disabled");
});

test("the init segment is a 404 until the muxer has produced one", async () => {
  const { jam, sessionId } = await openSession(delivering.baseUrl);
  const response = await fetch(
    `${delivering.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/init.mp4`,
  );
  // Retryable: the stream is open, the muxer simply has not reached it yet.
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.retryable, true);
});

test("a segment that never existed and one that expired answer the same way", async () => {
  const { jam, sessionId } = await openSession(delivering.baseUrl);
  const base = `${delivering.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`;
  for (const sequence of ["0", "999"]) {
    const response = await fetch(`${base}/segment/${sequence}.m4s`);
    assert.equal(response.status, 404);
  }
  // A player is never handed a different part of the film in place of the one
  // it asked for, so a nonsense address is refused rather than coerced.
  const negative = await fetch(`${base}/segment/-1.m4s`);
  assert.equal(negative.status, 404);
});

test("delivery routes for a session that is not open are a plain 404", async () => {
  const jam = randomUUID();
  const response = await fetch(
    `${delivering.baseUrl}/api/jams/${jam}/director/session/nope/playlist.m3u8`,
  );
  assert.equal(response.status, 404);
});
