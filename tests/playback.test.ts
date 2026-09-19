import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import type { Jam } from "../src/core/jam";
import {
  advancePlayback,
  flattenPortions,
  initialPlayback,
  lockedPortionIndex,
  minEditablePortionIndex,
  startPlayback,
} from "../src/core/playback";
import { InMemoryJamStore } from "../apps/server/jams";
import { InMemoryPortionMediaStore } from "../apps/server/media";
import {
  createPlaybackRouter,
  PlaybackCoordinator,
  type VideoGenerator,
} from "../apps/server/playback";
import { buildScript } from "./helpers";

function buildJam(): Jam {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    format: { totalSeconds: 240, portionMinSeconds: 10, portionMaxSeconds: 20 },
    script: buildScript(),
  };
}

// --- core rules ---

test("lock window derives from the cursor", () => {
  const count = 16;
  let state = initialPlayback();
  assert.equal(lockedPortionIndex(state, count), null);
  assert.equal(minEditablePortionIndex(state, count), 0);

  state = startPlayback(state);
  assert.equal(state.status, "priming");
  assert.equal(lockedPortionIndex(state, count), 0);
  assert.equal(minEditablePortionIndex(state, count), 1);

  state = advancePlayback(state, count);
  assert.deepEqual(
    [state.status, state.currentPortionIndex],
    ["playing", 0],
  );
  assert.equal(lockedPortionIndex(state, count), 1);
  assert.equal(minEditablePortionIndex(state, count), 2);
});

test("advancing beyond the last portion finishes playback", () => {
  const count = 2;
  let state = advancePlayback(startPlayback(initialPlayback()), count);
  state = advancePlayback(state, count);
  assert.equal(state.currentPortionIndex, 1);
  assert.equal(lockedPortionIndex(state, count), null);
  state = advancePlayback(state, count);
  assert.equal(state.status, "finished");
  assert.equal(minEditablePortionIndex(state, count), count);
});

test("flattenPortions assigns global indices in scene order", () => {
  const flat = flattenPortions(buildScript());
  assert.equal(flat.length, 16);
  assert.equal(flat[5].sceneIndex, 1);
  assert.deepEqual(
    flat.map((portion) => portion.portionIndex),
    Array.from({ length: 16 }, (_, index) => index),
  );
});

// --- router flow with a gated fake generator ---

let server: Server;
let baseUrl: string;
const store = new InMemoryJamStore();
const media = new InMemoryPortionMediaStore();
const gates: Array<() => void> = [];
const generator: VideoGenerator = {
  generate: () =>
    new Promise((resolve) => {
      gates.push(() => resolve(Buffer.from("clip-bytes")));
    }),
};
const coordinator = new PlaybackCoordinator(media, generator);

before(async () => {
  const app = express();
  app.use(createPlaybackRouter(store, { coordinator, media }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(await predicate(), "condition never became true");
}

test("playback start locks portion 0 and generation feeds the media store", async () => {
  const jam = buildJam();
  await store.createJam(jam);

  const start = await fetch(`${baseUrl}/api/jams/${jam.id}/playback/start`, {
    method: "POST",
  });
  assert.equal(start.status, 202);
  const started = await start.json();
  assert.equal(started.playback.status, "priming");
  assert.equal(started.lockedPortionIndex, 0);
  assert.equal(started.minEditablePortionIndex, 1);

  // Advance is refused until the buffered portion's video is ready.
  const early = await fetch(`${baseUrl}/api/jams/${jam.id}/playback/advance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedStateVersion: started.playback.stateVersion }),
  });
  assert.equal(early.status, 409);
  assert.equal((await early.json()).error.code, "media_not_ready");

  await waitFor(() => gates.length > 0);
  gates.shift()!();
  await waitFor(() => media.has(jam.id, 0));

  // Stale version is rejected with the agreed code.
  const stale = await fetch(`${baseUrl}/api/jams/${jam.id}/playback/advance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedStateVersion: 99 }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "stale_state_version");

  const advance = await fetch(`${baseUrl}/api/jams/${jam.id}/playback/advance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedStateVersion: started.playback.stateVersion }),
  });
  assert.equal(advance.status, 200);
  const advanced = await advance.json();
  assert.deepEqual(
    [advanced.playback.status, advanced.playback.currentPortionIndex],
    ["playing", 0],
  );
  assert.equal(advanced.lockedPortionIndex, 1);
  assert.equal(advanced.portions[0].media, "ready");
  assert.notEqual(advanced.portions[1].media, "none");

  // The guard exposes the boundary the script router will enforce.
  assert.deepEqual(coordinator.guard(jam.id, 16), {
    minEditablePortionIndex: 2,
    stateVersion: advanced.playback.stateVersion,
  });
});

test("portion video streams with Range support", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  await media.put(jam.id, 0, Buffer.from("0123456789"), "video/mp4");

  const full = await fetch(`${baseUrl}/api/jams/${jam.id}/portions/0/video`);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), "0123456789");

  const partial = await fetch(`${baseUrl}/api/jams/${jam.id}/portions/0/video`, {
    headers: { range: "bytes=2-4" },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await partial.text(), "234");

  const invalid = await fetch(`${baseUrl}/api/jams/${jam.id}/portions/0/video`, {
    headers: { range: "bytes=8-99" },
  });
  assert.equal(invalid.status, 416);

  const missing = await fetch(`${baseUrl}/api/jams/${jam.id}/portions/3/video`);
  assert.equal(missing.status, 404);
});

test("start is refused through the real app wiring when providers are off", async () => {
  process.env.REVERIE_LIVE_ENABLED = "false";
  const { createApiApp } = await import("../apps/server/app");
  const appStore = new InMemoryJamStore();
  const jam = buildJam();
  await appStore.createJam(jam);
  const app = createApiApp(appStore);
  const appServer = await new Promise<Server>((resolve) => {
    const listening: Server = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = appServer.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/jams/${jam.id}/playback/start`,
      { method: "POST" },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "generation_disabled");
  } finally {
    appServer.close();
  }
});

test("starting twice is rejected", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  await fetch(`${baseUrl}/api/jams/${jam.id}/playback/start`, { method: "POST" });
  const again = await fetch(`${baseUrl}/api/jams/${jam.id}/playback/start`, {
    method: "POST",
  });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, "invalid_transition");
});

test("a portion whose clip is already stored is not generated again", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  // What a restart looks like: the clips outlived the process, the job map did not.
  await media.put(jam.id, 0, Buffer.from("stored-clip"), "video/mp4");
  const gatesBefore = gates.length;

  const start = await fetch(`${baseUrl}/api/jams/${jam.id}/playback/start`, { method: "POST" });
  assert.equal(start.status, 202);
  const started = await start.json();
  assert.equal(started.portions[0].media, "ready");
  assert.equal(gates.length, gatesBefore, "the provider was not asked for a clip it already holds");

  // And playback moves straight on, without waiting for a generation.
  const advance = await fetch(`${baseUrl}/api/jams/${jam.id}/playback/advance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedStateVersion: started.playback.stateVersion }),
  });
  assert.equal(advance.status, 200);
  assert.equal((await advance.json()).playback.currentPortionIndex, 0);
});
