import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import type { Jam } from "../src/core/jam";
import { InMemoryJamStore } from "../apps/server/jams";
import { createDirectorRouter, type DirectorRouterOptions } from "../apps/server/director";
import { DirectorLiveSink } from "../apps/server/directorLiveSink";
import {
  InMemoryDirectorIndexStore,
  type OpenSessionInput,
} from "../apps/server/directorIndex";
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
// Roomy on purpose: these tests share one server and most of them deliberately
// leave a stream open, so a realistic concurrency cap would refuse later tests
// for a reason that has nothing to do with what they assert. The cap's own
// refusal is covered in directorRoutes.test.ts.
const LIMITS = {
  budgetUsd: 1000,
  usdPerSecond: 0.08,
  maxConcurrentSessions: 20,
  maxSessionSeconds: 60,
};

const store = new InMemoryJamStore();
let delivering: { server: Server; baseUrl: string };
let withheld: { server: Server; baseUrl: string };

async function listen(liveDelivery: boolean): Promise<{ server: Server; baseUrl: string }> {
  return listenWith({ liveDelivery });
}

async function listenWith(
  extra: Partial<DirectorRouterOptions>,
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(
    createDirectorRouter(store, {
      config: CONFIG,
      limits: LIMITS,
      recordings: new InMemoryDirectorRecordingStore(),
      createPeer: () => new FakeDirectorPeer(),
      startSession: async () => "v=0\r\nanswer\r\n",
      ...extra,
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
    lifecycle: "live",
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
  // Asserted as "leaving succeeded" rather than as a specific 2xx: which
  // success code `/end` returns is incidental to this test, and the meaning is
  // carried by the playlist assertions below.
  assert.ok(left.ok);
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
  assert.ok(lastOut.ok);
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

test("delivery routes never serve a session through another jam URL", async () => {
  const { sessionId } = await openSession(delivering.baseUrl);
  const otherJam = randomUUID();
  const base = `${delivering.baseUrl}/api/jams/${otherJam}/director/session/${sessionId}`;
  for (const path of ["playlist.m3u8", "init.mp4", "segment/0.m4s"]) {
    const response = await fetch(`${base}/${path}`);
    assert.equal(response.status, 404, path);
  }
});

test("invalid viewer data cannot become a whole-room stop", async () => {
  const { jam, sessionId } = await openSession(delivering.baseUrl);
  const base = `${delivering.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`;
  const invalid = await fetch(`${base}/end`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewerId: 42 }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "invalid_command");
  assert.equal((await fetch(`${base}/playlist.m3u8`)).status, 200);
});

test("attaching never starts a stream, so arriving in a room cannot bill", async () => {
  const jam: Jam = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    format: { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 },
    script: buildScript(5, 2, 2),
    lifecycle: "live",
  };
  await store.createJam(jam);

  const early = await fetch(`${delivering.baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attachOnly: true }),
  });
  // Nothing is running and this caller may not open one. Retryable, because a
  // participant who arrived before the host pressed start is early, not wrong.
  assert.equal(early.status, 404);
  const body = await early.json();
  assert.equal(body.error.code, "no_stream");
  assert.equal(body.error.retryable, true);

  // The host starts it; the same attach now joins rather than being refused.
  const started = await fetch(`${delivering.baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
  });
  assert.equal(started.status, 201);
  const host = await started.json();

  const joined = await fetch(`${delivering.baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attachOnly: true }),
  });
  assert.equal(joined.status, 200);
  const viewer = await joined.json();
  assert.equal(viewer.sessionId, host.sessionId);
  assert.equal(viewer.attached, true);
  assert.notEqual(viewer.viewerId, host.viewerId);
});

test("the host's stop ends the stream even while others are watching", async () => {
  const { jam, sessionId } = await openSession(delivering.baseUrl);
  const joined = await fetch(`${delivering.baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attachOnly: true }),
  });
  assert.equal(joined.status, 200);

  // Naming no viewer is the host's deliberate stop, as distinct from one viewer
  // leaving — it ends what the host is paying for, for everyone.
  const stopped = await fetch(
    `${delivering.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/end`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
  assert.ok(stopped.ok);
  const gone = await fetch(
    `${delivering.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/playlist.m3u8`,
  );
  assert.equal(gone.status, 404);
});

/**
 * The routes fed real bytes, without a muxer.
 *
 * `createLiveSink` hands the router a sink the test holds, so init and media
 * segments can be pushed in directly and read back over HTTP. This is what
 * proves the segment address actually parses — `:sequence.m4s` is only a
 * working route if the number survives the extension — and that the bytes and
 * cache headers a player depends on come back intact.
 */
let fedSink: DirectorLiveSink | null = null;
let fed: { server: Server; baseUrl: string };

before(async () => {
  fed = await listenWith({
    liveDelivery: true,
    createLiveSink: () => {
      fedSink = new DirectorLiveSink(3);
      return fedSink;
    },
  });
});

after(async () => {
  await new Promise<void>((resolve) => fed.server.close(() => resolve()));
});

test("segments pushed into the live window are served back byte for byte", async () => {
  const { jam, sessionId } = await openSession(fed.baseUrl);
  assert.ok(fedSink);
  fedSink.init(Buffer.from("init-bytes"), "h264");
  fedSink.segment(0, Buffer.from("segment-zero"), 0, 2);
  fedSink.segment(1, Buffer.from("segment-one"), 2, 2);
  const base = `${fed.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`;

  const playlist = await (await fetch(`${base}/playlist.m3u8`)).text();
  assert.match(playlist, /#EXT-X-MAP:URI="init\.mp4"/);
  assert.ok(playlist.includes("segment/0.m4s"));
  assert.ok(playlist.includes("segment/1.m4s"));

  const init = await fetch(`${base}/init.mp4`);
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("content-type"), "video/mp4");
  // Immutable for the session's life: every viewer after the first can be
  // served a cached copy.
  assert.match(init.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(Buffer.from(await init.arrayBuffer()).toString(), "init-bytes");

  // The number has to survive the `.m4s` extension for this to be a route at all.
  const segment = await fetch(`${base}/segment/1.m4s`);
  assert.equal(segment.status, 200);
  assert.equal(segment.headers.get("content-type"), "video/iso.segment");
  assert.match(segment.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(Buffer.from(await segment.arrayBuffer()).toString(), "segment-one");

  assert.equal((await fetch(`${base}/segment/7.m4s`)).status, 404);
});

test("ending a session stops its segmenter and finishes the live sink", async () => {
  const { jam, sessionId } = await openSession(fed.baseUrl);
  assert.ok(fedSink);
  fedSink.init(Buffer.from("init"), "h264");
  fedSink.segment(0, Buffer.from("segment"), 0, 2);
  const base = `${fed.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`;

  const stopped = await fetch(`${base}/end`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.ok(stopped.ok);
  assert.match(fedSink.playlist("init.mp4", (sequence) => `segment/${sequence}.m4s`), /#EXT-X-ENDLIST/);
});

test("a segment that left the window is gone, not replaced by another", async () => {
  const { jam, sessionId } = await openSession(fed.baseUrl);
  assert.ok(fedSink);
  fedSink.init(Buffer.from("init"), "h264");
  for (let index = 0; index < 5; index += 1) {
    fedSink.segment(index, Buffer.from(`segment-${index}`), index * 2, 2);
  }
  const base = `${fed.baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`;
  // Window of three: 0 and 1 have been evicted.
  assert.equal((await fetch(`${base}/segment/0.m4s`)).status, 404);
  assert.equal((await fetch(`${base}/segment/4.m4s`)).status, 200);
  const playlist = await (await fetch(`${base}/playlist.m3u8`)).text();
  // The media sequence tells a late player where the window now starts.
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:2\n/);
});


/**
 * Races around the handshake window and the two ways to be a viewer.
 *
 * Both of these are spend bugs rather than display bugs: one strands a paid
 * stream outside the ledger, the other ends a stream somebody is watching or
 * leaves one billing with nobody on it.
 */
let releaseHandshake: (() => void) | null = null;
let viewerClosers: (() => void)[] = [];
let raced: { server: Server; baseUrl: string };

before(async () => {
  raced = await listenWith({
    liveDelivery: true,
    startSession: async () => {
      // Stands in for the fal handshake plus ICE gathering: seconds wide in
      // production, and the window the attach poll lands in.
      await new Promise<void>((resolve) => {
        releaseHandshake = resolve;
      });
      return "v=0\r\nanswer\r\n";
    },
    attachViewer: async (_stream, _sdp, onClosed) => {
      viewerClosers.push(() => onClosed?.());
      return { answerSdp: "v=0\r\nviewer\r\n", close() {} };
    },
  });
});

after(async () => {
  await new Promise<void>((resolve) => raced.server.close(() => resolve()));
});

test("a poll during the handshake cannot release the stream being opened", async () => {
  const jam: Jam = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    format: { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 },
    script: buildScript(5, 2, 2),
    lifecycle: "live",
  };
  await store.createJam(jam);
  const url = `${raced.baseUrl}/api/jams/${jam.id}/director/session`;

  // The host presses Start. The handshake is held open.
  const starting = fetch(url, { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 30));

  // A participant's 3s auto-attach poll lands mid-handshake. The session is in
  // the ledger but not yet in the stream map, which used to look exactly like
  // an orphaned reservation and get refunded out from under the host.
  const polled = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attachOnly: true }),
  });
  assert.equal(polled.status, 409);
  const refusal = await polled.json();
  assert.equal(refusal.error.code, "stream_starting");
  assert.equal(refusal.error.retryable, true);

  releaseHandshake?.();
  const started = await starting;
  assert.equal(started.status, 201);
  const host = await started.json();

  // The session survived intact: it is still the ledger's, so it can be
  // renewed, found by configuration, and ended. Before the fix the reservation
  // was gone — renew answered 404 while fal kept billing.
  assert.equal(typeof host.viewerId, "string");
  const renewed = await fetch(`${url}/${host.sessionId}/renew`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewerId: host.viewerId }),
  });
  assert.equal(renewed.status, 204);

  // And the configuration is still held, so a second Start cannot open a
  // second paid stream for the same room.
  const second = await fetch(url, { method: "POST" });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).sessionId, host.sessionId);
});

test("a poll during the index write cannot release the stream being opened", async () => {
  let enteredIndex!: () => void;
  let releaseIndex!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredIndex = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseIndex = resolve;
  });
  class DelayedIndex extends InMemoryDirectorIndexStore {
    override async openSession(input: OpenSessionInput): Promise<void> {
      enteredIndex();
      await gate;
      await super.openSession(input);
    }
  }

  const delayed = await listenWith({ liveDelivery: true, index: new DelayedIndex() });
  try {
    const jam: Jam = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
      format: { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 },
      script: buildScript(5, 2, 2),
      lifecycle: "live",
    };
    await store.createJam(jam);
    const url = `${delayed.baseUrl}/api/jams/${jam.id}/director/session`;

    const starting = fetch(url, { method: "POST" });
    const openingReached = await Promise.race([
      entered.then(() => "index"),
      starting.then((response) => `response:${response.status}`),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
    ]);
    assert.equal(openingReached, "index");
    const polled = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachOnly: true }),
    });
    assert.equal(polled.status, 409);
    assert.equal((await polled.json()).error.code, "stream_starting");

    releaseIndex();
    const started = await starting;
    assert.equal(started.status, 201);
  } finally {
    releaseIndex();
    await new Promise<void>((resolve) => delayed.server.close(() => resolve()));
  }
});

test("a relay peer dropping does not end a stream counted viewers are on", async () => {
  const jam: Jam = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    format: { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 },
    script: buildScript(5, 2, 2),
    lifecycle: "live",
  };
  await store.createJam(jam);
  const url = `${raced.baseUrl}/api/jams/${jam.id}/director/session`;

  const starting = fetch(url, { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseHandshake?.();
  const host = await (await starting).json();

  viewerClosers = [];
  const watch = await fetch(`${url}/${host.sessionId}/watch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sdp: "v=0\r\noffer\r\n" }),
  });
  assert.equal(watch.status, 201);

  // The relay peer flaps — one ICE disconnect. The host is still a counted
  // viewer, so the film must keep running for them.
  viewerClosers.forEach((close) => close());
  await new Promise((resolve) => setTimeout(resolve, 20));

  const alive = await fetch(`${url}/${host.sessionId}`);
  assert.equal(alive.status, 200, "a relay drop must not settle a watched session");
});
