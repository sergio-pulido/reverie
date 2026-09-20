import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import type { Jam } from "../src/core/jam";
import { InMemoryJamStore } from "../apps/server/jams";
import { createDirectorRouter } from "../apps/server/director";
import { InMemoryDirectorRecordingStore } from "../apps/server/directorRecordings";
import {
  DirectorError,
  type DirectorConfig,
} from "../apps/server/providers/falDirector";
import { FakeDirectorPeer } from "./fakeDirectorPeer";
import { buildScript } from "./helpers";
import { directorVideoCodecs } from "../apps/server/directorStream";

const CONFIG: DirectorConfig = {
  apiKey: "test-key",
  resolution: "768p",
  aspectRatio: "16:9",
  record: false,
};

// Roomy on purpose: every closed session bills fal's 60-second minimum, so a
// realistic budget would run out partway through the file. Budget refusal has
// its own test.
const LIMITS = {
  budgetUsd: 1000,
  usdPerSecond: 0.08,
  maxConcurrentSessions: 2,
  maxSessionSeconds: 60,
};

const store = new InMemoryJamStore();
const recordings = new InMemoryDirectorRecordingStore();
/** The peer handed to the most recent session, so tests can drive it. */
let peer: FakeDirectorPeer;
let offers: string[] = [];
let nextResult: "ok" | "unavailable" = "ok";
/** Viewer offers seen by the fake forwarder, and how many were torn down. */
let viewerOffers: string[] = [];
let closedViewers = 0;
/** Lets a test drop a viewer the way a closed browser tab would. */
let viewerClosers: (() => void)[] = [];
let server: Server;
let baseUrl: string;

/**
 * A jam whose film is `portionSeconds x 2 x portionsPerScene` long, 20s by default.
 *
 * The length matters to more than the script: a take now stops itself at the
 * end of the film, so a test that drives a stream past that boundary has to
 * ask for a film long enough to contain what it is driving.
 */
function buildJam(portionSeconds = 5, portionsPerScene = 2): Jam {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    lifecycle: "live",
    format: {
      totalSeconds: portionSeconds * 2 * portionsPerScene,
      portionMinSeconds: portionSeconds,
      portionMaxSeconds: portionSeconds,
    },
    script: buildScript(portionSeconds, 2, portionsPerScene),
  };
}

/**
 * Lets the handover that a chunk kicks off finish.
 *
 * It reads the current script, so it is asynchronous by nature: the control
 * message returns before the beats have been sent.
 */
async function settleHandover(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One chunk from fal, at a whole-second offset, handover settled. */
async function deliverChunk(chunkIndex: number, offsetSeconds: number): Promise<void> {
  peer.channel.deliver({
    type: "chunk",
    chunk_index: chunkIndex,
    prompt_version: 1,
    playback_seconds: 5,
    script_offset_seconds: offsetSeconds,
  });
  await settleHandover();
}

async function openJamSession(jam: Jam = buildJam()): Promise<{
  jam: Jam;
  sessionId: string;
  viewerId: string;
}> {
  await store.createJam(jam);
  const response = await fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
  });
  assert.equal(response.status, 201);
  const { sessionId, viewerId } = await response.json();
  return { jam, sessionId, viewerId };
}

function endSession(jamId: string, sessionId: string) {
  return fetch(`${baseUrl}/api/jams/${jamId}/director/session/${sessionId}/end`, {
    method: "POST",
  });
}

before(async () => {
  const app = express();
  app.use(
    createDirectorRouter(store, {
      config: CONFIG,
      limits: LIMITS,
      recordings,
      attachViewer: async (_stream, offerSdp, onClosed) => {
        viewerOffers.push(offerSdp);
        let announced = false;
        const announce = () => {
          if (announced) return;
          announced = true;
          onClosed?.();
        };
        viewerClosers.push(announce);
        return {
          answerSdp: "v=0\r\nviewer-answer\r\n",
          close: () => {
            closedViewers += 1;
            announce();
          },
        };
      },
      createPeer: () => {
        peer = new FakeDirectorPeer();
        return peer;
      },
      startSession: async (_config, offer) => {
        offers.push(offer.sdp);
        if (nextResult === "unavailable") {
          throw new DirectorError("The director stream did not respond.", true);
        }
        return "v=0\r\nanswer\r\n";
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

test("the server is the peer: it offers, receives only, and opens the control channel", async () => {
  offers = [];
  const { jam, sessionId } = await openJamSession();

  // The offer came from this server, not from a client.
  assert.equal(offers.length, 1);
  assert.match(offers[0], /fake-offer/);
  assert.deepEqual(peer.transceivers, ["video", "audio"]);
  assert.equal(peer.label, "fal");
  assert.match(String(peer.remoteSdp), /answer/);

  await endSession(jam.id, sessionId);
});

test("codec preference follows the selected container without removing the fallback", () => {
  assert.deepEqual(
    directorVideoCodecs(true).map((codec) => codec.mimeType),
    ["video/H264", "video/VP8"],
  );
  assert.deepEqual(
    directorVideoCodecs(false).map((codec) => codec.mimeType),
    ["video/VP8", "video/H264"],
  );
});

test("the configure message carries the opening chunk's beats, not the whole film", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();

  const [configure] = peer.channel.parsed();
  assert.equal(configure.type, "configure");
  assert.equal(configure.prompt_version, 1);
  // A beat fal is given can never change again, so it is given only what it
  // will generate before it has reported anything: one chunk at the longest
  // length the model makes. Beat 15s is handed over later, as it closes.
  assert.deepEqual(
    (configure.script as { offset: number }[]).map((beat) => beat.offset),
    [0, 5, 10],
  );

  await endSession(jam.id, sessionId);
});

test("a client cannot reach the provider: it asks the server to direct", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();

  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/direct`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Cut to the lighthouse at dusk.",
        authorId: "author-1",
        proposalId: "proposal-1",
      }),
    },
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).promptVersion, 2);

  // It reached fal as a versioned prompt, sent by this server.
  const prompt = peer.channel.parsed().at(-1)!;
  assert.equal(prompt.type, "prompt");
  assert.equal(prompt.prompt_version, 2);
  assert.equal(prompt.prompt, "Cut to the lighthouse at dusk.");

  await endSession(jam.id, sessionId);
});

test("every direction and verdict lands in the audit trail", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();

  await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/direct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Push in.", authorId: "author-1", proposalId: "p-1" }),
  });
  peer.channel.deliver({ type: "prompt_applied", prompt_version: 2 });
  peer.channel.deliver({
    type: "chunk",
    chunk_index: 0,
    prompt_version: 2,
    playback_seconds: 10,
  });

  const audit = await (
    await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`)
  ).json();

  const kinds = audit.audit.map((entry: { kind: string }) => entry.kind);
  assert.deepEqual(kinds, [
    "session_opened",
    "direction_sent",
    "direction_applied",
    "chunk_received",
  ]);

  const sent = audit.audit[1];
  // The body recorded is the body sent, and it carries who asked for it.
  assert.equal(sent.body, "Push in.");
  assert.equal(sent.authorId, "author-1");
  assert.equal(sent.proposalId, "p-1");
  assert.equal(sent.promptVersion, 2);
  assert.ok(sent.at);
  assert.equal(audit.state.status, "streaming");

  await endSession(jam.id, sessionId);
});

test("a refused direction is recorded and does not end the stream", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();
  await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/direct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Something refused." }),
  });
  peer.channel.deliver({ type: "chunk", chunk_index: 0, prompt_version: 1, playback_seconds: 5 });
  peer.channel.deliver({ type: "prompt_rejected", prompt_version: 2 });

  const audit = await (
    await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`)
  ).json();
  assert.ok(
    audit.audit.some(
      (entry: { kind: string; promptVersion?: number }) =>
        entry.kind === "direction_rejected" && entry.promptVersion === 2,
    ),
  );
  // Per the transactional-scene-contract rule, the stream survives it.
  assert.equal(audit.state.status, "streaming");

  await endSession(jam.id, sessionId);
});

test("direction is refused before the channel is open", async () => {
  const { jam, sessionId } = await openJamSession();
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/direct`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Too early." }),
    },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "stream_not_ready");
  assert.equal(body.error.retryable, true);

  await endSession(jam.id, sessionId);
});

test("an empty or oversized direction is refused", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();
  const before = peer.channel.sent.length;

  for (const body of ["", "   ", "x".repeat(2_001)]) {
    const response = await fetch(
      `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/direct`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    assert.equal(response.status, 400, body.slice(0, 10));
  }
  // Nothing reached the provider.
  assert.equal(peer.channel.sent.length, before);

  await endSession(jam.id, sessionId);
});

test("an unknown jam is refused before any provider call", async () => {
  offers = [];
  const response = await fetch(
    `${baseUrl}/api/jams/${randomUUID()}/director/session`,
    { method: "POST" },
  );
  assert.equal(response.status, 404);
  assert.equal(offers.length, 0);
});

test("a second viewer on the same configuration attaches to the one stream", async () => {
  const { jam, sessionId } = await openJamSession();

  // Not a refusal: the same film is already being paid for, so this viewer
  // joins it rather than buying a second copy.
  const second = await fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
  });
  assert.equal(second.status, 200);
  const joined = await second.json();
  assert.equal(joined.attached, true);
  assert.equal(joined.sessionId, sessionId);
  assert.ok(joined.beats);

  assert.equal((await endSession(jam.id, sessionId)).status, 200);
  assert.equal((await store.getJam(jam.id))?.lifecycle, "ended");

  // The room plays again, as a second take rather than a resurrection: the
  // stop signal belongs to everybody in the room, so it stops the stream
  // rather than retiring the room.
  const reopened = await fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
  });
  assert.equal(reopened.status, 201);
  const nextTake = await reopened.json();
  assert.notEqual(nextTake.sessionId, sessionId);
  assert.equal(nextTake.attached, false);
  assert.equal((await store.getJam(jam.id))?.lifecycle, "playing");
  await endSession(jam.id, nextTake.sessionId);
});

test("a different configuration gets its own stream", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const open = (configuration?: Record<string, string>) =>
    fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configuration ? { configuration } : {}),
    });

  const english = await open({ language: "en", ambientation: "" });
  assert.equal(english.status, 201);
  const spanish = await open({ language: "es", ambientation: "" });
  assert.equal(spanish.status, 201);
  const first = await english.json();
  const second = await spanish.json();
  assert.notEqual(first.sessionId, second.sessionId);

  // Casing and spacing are cosmetic, so they must not multiply streams.
  const sameAgain = await open({ language: "ES", ambientation: "  " });
  assert.equal(sameAgain.status, 200);
  assert.equal((await sameAgain.json()).sessionId, second.sessionId);

  await endSession(jam.id, first.sessionId);
  await endSession(jam.id, second.sessionId);
});

test("a third configuration is refused once the streams are full", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const open = (language: string) =>
    fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configuration: { language, ambientation: "" } }),
    });

  const a = await open("en");
  const b = await open("es");
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const c = await open("fr");
  assert.equal(c.status, 409);
  assert.equal((await c.json()).error.code, "too_many_sessions");

  await endSession(jam.id, (await a.json()).sessionId);
  await endSession(jam.id, (await b.json()).sessionId);
});

test("a failed handshake releases the reservation and closes the peer", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  nextResult = "unavailable";
  const failed = await fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
  });
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error.code, "director_unavailable");
  assert.ok(peer.closed);

  nextResult = "ok";
  const retried = await fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
  });
  assert.equal(retried.status, 201);
  await endSession(jam.id, (await retried.json()).sessionId);
});

test("ending a session closes the peer and is idempotent", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();
  assert.equal((await endSession(jam.id, sessionId)).status, 200);
  assert.ok(peer.closed);
  // The provider was told to stop.
  assert.equal(peer.channel.parsed().at(-1)!.type, "stop");
  assert.equal((await endSession(jam.id, sessionId)).status, 200);
});

test("state and audit are gone once a session is closed", async () => {
  const { jam, sessionId } = await openJamSession();
  await endSession(jam.id, sessionId);
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`,
  );
  assert.equal(response.status, 404);
});

test("a session with no recording reports no recording, not an error", async () => {
  const { jam, sessionId } = await openJamSession();
  await endSession(jam.id, sessionId);
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/recordings/${sessionId}`,
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "not_found");
});

test("a stored recording is served by this server", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  await recordings.save(jam.id, "session-x", Buffer.from("webm-bytes"), "video/webm");
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/recordings/session-x`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/webm");
  assert.equal(await response.text(), "webm-bytes");
});

test("the audit records where the stream stood when a direction was sent", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();

  // The stream reaches the third beat of a 5s-portion script.
  peer.channel.deliver({
    type: "chunk",
    chunk_index: 0,
    prompt_version: 1,
    playback_seconds: 10,
    script_offset_seconds: 10,
  });
  await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/direct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Hold on her face." }),
  });

  const audit = await (
    await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`)
  ).json();
  const sent = audit.audit.find(
    (entry: { kind: string }) => entry.kind === "direction_sent",
  );
  // "Which beat was playing when this was sent" is what an audit gets asked.
  assert.equal(sent.scriptOffsetSeconds, 10);
  assert.equal(audit.state.scriptOffsetSeconds, 10);

  await endSession(jam.id, sessionId);
});

test("a direction on a locked beat is refused, and says which are still open", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();
  // What is closed is what fal has been GIVEN, so the chunk length decides how
  // far ahead that reaches: at five seconds a chunk, the opening configure
  // covers beats 0-2 and nothing further has been handed over yet.
  peer.channel.deliver({ type: "configured", prompt_version: 1, chunk_duration: 5 });
  // Beat 1 is on screen; beat 2 is already with the provider.
  peer.channel.deliver({
    type: "chunk",
    chunk_index: 0,
    prompt_version: 1,
    playback_seconds: 5,
    script_offset_seconds: 5,
  });

  const direct = (beatIndex: number) =>
    fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/direct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Rewrite this beat.", beatIndex }),
    });

  for (const locked of [0, 1, 2]) {
    const response = await direct(locked);
    assert.equal(response.status, 409, `beat ${locked}`);
    const body = await response.json();
    assert.equal(body.error.code, "beat_locked");
    assert.equal(body.error.retryable, false);
    assert.equal(body.beats.minEditableBeatIndex, 3);
  }

  // Beat 3 is far enough ahead to still change.
  const open = await direct(3);
  assert.equal(open.status, 202);
  assert.deepEqual((await open.json()).beats, {
    currentBeatIndex: 1,
    lockedBeatIndex: 2,
    minEditableBeatIndex: 3,
  });

  await endSession(jam.id, sessionId);
});

test("direction without a beat index is not gated by the lock", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();
  peer.channel.deliver({
    type: "chunk",
    chunk_index: 0,
    prompt_version: 1,
    playback_seconds: 5,
    script_offset_seconds: 5,
  });

  // A live aside from the room is direction without being a beat edit, so
  // there is no beat for the window to protect.
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/direct`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Hold on her face." }),
    },
  );
  assert.equal(response.status, 202);

  await endSession(jam.id, sessionId);
});

test("before the first chunk the opening beat is already closed", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/direct`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Change the opening.", beatIndex: 0 }),
    },
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "beat_locked");

  await endSession(jam.id, sessionId);
});

test("the registry reports the strictest open stream for a jam", async () => {
  const { DirectorStreamRegistry } = await import("../apps/server/director");
  const registry = new DirectorStreamRegistry();
  // No stream: nothing is locked, so every portion stays editable.
  assert.equal(registry.minEditablePortionIndex("jam-a"), 0);

  registry.set("s1", {
    jamId: "jam-a",
    beats: { currentBeatIndex: 1, lockedBeatIndex: 2, minEditableBeatIndex: 3 },
  } as never);
  registry.set("s2", {
    jamId: "jam-a",
    beats: { currentBeatIndex: 3, lockedBeatIndex: 4, minEditableBeatIndex: 5 },
  } as never);
  registry.set("s3", {
    jamId: "other-jam",
    beats: { currentBeatIndex: 9, lockedBeatIndex: 10, minEditableBeatIndex: 11 },
  } as never);

  // A jam can hold one stream per configuration, and an edit is only safe if
  // it is ahead of all of them, so the strictest wins.
  assert.equal(registry.minEditablePortionIndex("jam-a"), 5);
  // Another jam's streams do not lock this one.
  assert.equal(registry.minEditablePortionIndex("nobody"), 0);

  registry.delete("s2");
  assert.equal(registry.minEditablePortionIndex("jam-a"), 3);
});

test("the registry hands the outline the strictest window and the jam's own streams", async () => {
  const { DirectorStreamRegistry } = await import("../apps/server/director");
  const registry = new DirectorStreamRegistry();
  // Nothing open: nothing is playing and nothing is locked, which is not the
  // same claim as "the first beat is playing".
  assert.deepEqual(registry.beatWindow("jam-a"), {
    currentBeatIndex: null,
    lockedBeatIndex: null,
    minEditableBeatIndex: 0,
  });
  assert.deepEqual(registry.streamsFor("jam-a"), []);

  const lenient = { jamId: "jam-a", beats: { currentBeatIndex: 1, lockedBeatIndex: 2, minEditableBeatIndex: 3 } };
  const strict = { jamId: "jam-a", beats: { currentBeatIndex: 3, lockedBeatIndex: 4, minEditableBeatIndex: 5 } };
  registry.set("s1", lenient as never);
  registry.set("s2", strict as never);
  registry.set("s3", { jamId: "other-jam", beats: { currentBeatIndex: 9, lockedBeatIndex: 10, minEditableBeatIndex: 11 } } as never);

  // An edit is only safe if it is ahead of every open stream, so the window
  // the room is shown is the strictest one.
  assert.deepEqual(registry.beatWindow("jam-a"), strict.beats);
  assert.deepEqual(registry.streamsFor("jam-a"), [lenient, strict] as never);
  assert.deepEqual(registry.streamsFor("nobody"), []);
});

test("a viewer is forwarded the stream this server already holds", async () => {
  const { jam, sessionId } = await openJamSession();
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/watch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\nviewer-offer\r\n" }),
    },
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.answer.type, "answer");
  assert.match(body.answer.sdp, /viewer-answer/);
  // The viewer's offer reached the forwarder, not fal.
  assert.equal(viewerOffers.length, 1);
  assert.match(viewerOffers[0], /viewer-offer/);

  await endSession(jam.id, sessionId);
  // Stopping the session tears the viewer down; it watches nothing now.
  assert.equal(closedViewers, 1);
});

test("watching a session that is not open is refused", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/nope/watch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\n" }),
    },
  );
  assert.equal(response.status, 404);
});

test("a session id cannot be used through another jam's routes", async () => {
  const { jam, sessionId } = await openJamSession();
  const other = buildJam();
  await store.createJam(other);
  const prefix = `${baseUrl}/api/jams/${other.id}/director/session/${sessionId}`;

  const attempts = [
    fetch(prefix),
    fetch(`${prefix}/direct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Cross the rooms." }),
    }),
    fetch(`${prefix}/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\nviewer-offer\r\n" }),
    }),
    fetch(`${prefix}/renew`, { method: "POST" }),
    fetch(`${prefix}/end`, { method: "POST" }),
  ];
  for (const response of await Promise.all(attempts)) assert.equal(response.status, 404);

  assert.equal(
    (await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`)).status,
    200,
  );
  assert.equal((await store.getJam(jam.id))?.lifecycle, "playing");
  await endSession(jam.id, sessionId);
  assert.equal((await endSession(other.id, sessionId)).status, 404);
});

test("a malformed viewer offer never reaches the forwarder", async () => {
  const { jam, sessionId } = await openJamSession();
  const before = viewerOffers.length;
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/watch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "" }),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(viewerOffers.length, before);
  await endSession(jam.id, sessionId);
});

test("the last viewer leaving stops the session, because nobody is watching", async () => {
  viewerClosers = [];
  const { jam, sessionId, viewerId } = await openJamSession();
  const watch = () =>
    fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\nviewer-offer\r\n" }),
    });

  assert.equal((await (await watch()).json()).viewers, 1);
  assert.equal((await (await watch()).json()).viewers, 2);

  // Opening the session counted its opener as a viewer too, so the relay peers
  // are not the whole audience until that one leaves. Watching by either route
  // keeps the stream: the rule is "nobody is watching", not "no relay peers".
  await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/end`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewerId }),
  });

  // One of two leaving is not the last one; the session keeps running.
  viewerClosers[0]();
  assert.equal(
    (await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`)).status,
    200,
  );

  // The last one leaving stops it, rather than billing on to the idle timeout.
  viewerClosers[1]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    (await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`)).status,
    404,
  );
});

test("a session nobody has joined yet is not stopped by the viewer rule", async () => {
  // Having had no audience is different from having lost one.
  const { jam, sessionId } = await openJamSession();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    (await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`)).status,
    200,
  );
  await endSession(jam.id, sessionId);
});

test("ending one session leaves another session's viewers alone", async () => {
  const first = await openJamSession();
  const second = await openJamSession();
  const watch = (jamId: string, sessionId: string) =>
    fetch(`${baseUrl}/api/jams/${jamId}/director/session/${sessionId}/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\nviewer-offer\r\n" }),
    });
  await watch(first.jam.id, first.sessionId);
  await watch(second.jam.id, second.sessionId);
  const closedBefore = closedViewers;

  await endSession(first.jam.id, first.sessionId);
  // Exactly one viewer torn down: the other session still has its audience.
  assert.equal(closedViewers - closedBefore, 1);
  assert.equal(
    (await fetch(`${baseUrl}/api/jams/${second.jam.id}/director/session/${second.sessionId}`)).status,
    200,
  );
  await endSession(second.jam.id, second.sessionId);
});

test("the budget route names this server's ceiling before any session is opened", async () => {
  const response = await fetch(`${baseUrl}/api/jams/${randomUUID()}/director/budget`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.configured, true);
  assert.equal(body.spend.budgetUsd, LIMITS.budgetUsd);
  assert.equal(body.spend.usdPerSecond, LIMITS.usdPerSecond);
  assert.equal(body.spend.minBilledSeconds, 60, "fal's per-session minimum, not a guess");
  assert.equal(body.spend.sessionUsd, 0, "no session, nothing spent");
  assert.equal(
    body.maxSessionSeconds,
    LIMITS.maxSessionSeconds,
    "and where a take stops itself, so a screen can say so before play is pressed",
  );
});

/** What the server says is left before this test opens anything of its own. */
async function remainingUsd(): Promise<number> {
  const body = await (await fetch(`${baseUrl}/api/jams/${randomUUID()}/director/budget`)).json();
  return body.spend.remainingUsd;
}

test("an open session is billed the provider's minimum before it has generated a second", async () => {
  const before = await remainingUsd();
  const { jam, sessionId } = await openJamSession();
  const { spend, state } = await (
    await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`)
  ).json();

  assert.equal(state.generatedSeconds, 0);
  // 60s minimum at $0.08: the money is already committed whether or not it runs.
  assert.equal(spend.sessionUsd.toFixed(2), "4.80");
  assert.equal(spend.remainingUsd.toFixed(2), (before - 4.8).toFixed(2));

  await endSession(jam.id, sessionId);
});

test("watching a stopped room points at its recording instead of 404", async () => {
  const { jam, sessionId } = await openJamSession();
  await endSession(jam.id, sessionId);

  const watched = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/watch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\noffer\r\n" }),
    },
  );
  assert.equal(watched.status, 409);
  const body = await watched.json();
  assert.equal(body.error.code, "jam_ended");
  assert.equal(body.archive, `/api/jams/${jam.id}/director/archive`);
});

test("watching a session that never existed is still a plain 404", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const watched = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/nope/watch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\noffer\r\n" }),
    },
  );
  assert.equal(watched.status, 404);
});

test("a room stopped by its last viewer leaving is stopped, not left playing", async () => {
  viewerClosers = [];
  const { jam, sessionId, viewerId } = await openJamSession();
  const watched = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/watch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\nviewer-offer\r\n" }),
    },
  );
  assert.equal(watched.status, 201);

  // Opening the session counted its opener as a viewer, so the relay peer is
  // not the whole audience until that one leaves: a stream is watched if
  // anybody is watching it by any route.
  await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/end`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewerId }),
  });

  // The viewer rule stops the session without going through the end route, so
  // the lifecycle has to move with the teardown rather than with the request.
  viewerClosers[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Read from the store rather than from a refused reopen: a stopped room can
  // be played again now, so the only evidence that the teardown moved the
  // lifecycle is the lifecycle itself.
  assert.equal((await store.getJam(jam.id))?.lifecycle, "ended");
});

test("the whole film being generated is recorded, and ends nothing", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();

  // The jam's script is 20 seconds, so these two chunks are the whole film.
  // Four real takes on 2026-09-20 were torn down here, 1ms after the last
  // chunk and before hls.js had a playable segment: generation finishing says
  // the film exists, not that anybody has seen it.
  peer.channel.deliver({
    type: "chunk",
    chunk_index: 0,
    prompt_version: 1,
    playback_seconds: 10,
    script_offset_seconds: 0,
  });
  peer.channel.deliver({
    type: "chunk",
    chunk_index: 1,
    prompt_version: 1,
    playback_seconds: 20,
    script_offset_seconds: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`,
  );
  assert.equal(response.status, 200, "the take is still running");
  const { state, audit } = await response.json();
  assert.equal(state.generatedSeconds, 30);
  const generated = audit.filter(
    (entry: { kind: string }) => entry.kind === "film_generated",
  );
  assert.equal(generated.length, 1, "recorded once");
  assert.equal(generated[0].detail, "30s generated of a 20s film");
  assert.equal(peer.closed, false, "and the provider connection is still open");

  await endSession(jam.id, sessionId);
});

test("a stop can say it was the film being watched out, and the trail keeps it", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();
  const closing = peer;

  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/end`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "played_to_end" }),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(closing.closed, true);
  assert.equal((await store.getJam(jam.id))?.lifecycle, "ended");
  // What the trail records for it is asserted on the stream itself, where the
  // trail lives: see "a stop records the reason it was given" below.
});

test("a reason the server does not know is refused, never recorded", async () => {
  // The trail records what this server knows; a browser does not get to write
  // free text into it, and an unknown reason must not collapse into a
  // reasonless whole-room stop either.
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/end`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "because I said so" }),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`)).status,
    200,
    "and the take it could not name a reason for is still running",
  );
  await endSession(jam.id, sessionId);
});

test("a take short of the film's length keeps running too", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();
  // Half of a 20-second film, and the frontier still inside it.
  peer.channel.deliver({
    type: "chunk",
    chunk_index: 0,
    prompt_version: 1,
    playback_seconds: 10,
    script_offset_seconds: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const { state } = await (
    await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`)
  ).json();
  assert.equal(state.generatedSeconds, 10);
  await endSession(jam.id, sessionId);
});

test("the budget names the film's length, so a room knows where a take ends", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const body = await (
    await fetch(`${baseUrl}/api/jams/${jam.id}/director/budget`)
  ).json();
  assert.equal(body.filmSeconds, 20);
  assert.equal(body.maxSessionSeconds, LIMITS.maxSessionSeconds);
  // A jam this server does not hold still gets its budget answered.
  const unknown = await (
    await fetch(`${baseUrl}/api/jams/${randomUUID()}/director/budget`)
  ).json();
  assert.equal(unknown.filmSeconds, null);
  assert.equal(unknown.configured, true);
});

test("spend follows the seconds the stream actually generated, not its reservation", async () => {
  const before = await remainingUsd();
  // A two-minute film, so ninety seconds of it is a take still running rather
  // than one that has reached its end and stopped itself.
  const { jam, sessionId } = await openJamSession(buildJam(15, 4));
  peer.channel.open();
  // 90 seconds of video: past the minimum, so the bill follows the chunks.
  for (let index = 0; index < 6; index += 1) {
    peer.channel.deliver({
      type: "chunk",
      chunk_index: index,
      prompt_version: 1,
      playback_seconds: 15,
      script_offset_seconds: index * 5,
    });
  }

  const { spend, state } = await (
    await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`)
  ).json();
  assert.equal(state.generatedSeconds, 90);
  // The session may bill at most its reservation — 60s × $0.08, the limit it
  // stops at — so the figure is capped there rather than quoting more.
  assert.equal(spend.sessionUsd.toFixed(2), "4.80");
  assert.equal(spend.remainingUsd.toFixed(2), (before - 4.8).toFixed(2));

  await endSession(jam.id, sessionId);
});

test("a recording server builds the session's sinks and finishes them on end", async () => {
  const built: { jamId: string; sessionId: string; container: string }[] = [];
  let finished = 0;
  const app = express();
  app.use(
    createDirectorRouter(store, {
      config: { ...CONFIG, record: true },
      limits: LIMITS,
      recordings,
      createPeer: () => new FakeDirectorPeer(),
      startSession: async () => "v=0\r\nanswer\r\n",
      createSegmentSinks: (session) => {
        built.push(session);
        return [{ init() {}, segment() {}, finish() { finished += 1; } }];
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const jam = buildJam();
  await store.createJam(jam);
  try {
    const opened = await fetch(`http://127.0.0.1:${port}/api/jams/${jam.id}/director/session`, {
      method: "POST",
    });
    assert.equal(opened.status, 201);
    const { sessionId } = await opened.json();
    // The sinks are the session's own: built for this jam and this session.
    assert.deepEqual(built, [{ jamId: jam.id, sessionId, container: "webm" }]);

    const ended = await fetch(
      `http://127.0.0.1:${port}/api/jams/${jam.id}/director/session/${sessionId}/end`,
      { method: "POST" },
    );
    assert.equal(ended.status, 200);
    // No track ever arrived, so nothing was muxed; the sink is still told the
    // session is over, and the route did not wait on a muxer for it.
    assert.equal(finished, 1);
  } finally {
    server.close();
  }
});

test("live delivery and recording share one MP4 pipeline", async () => {
  const built: { jamId: string; sessionId: string; container: string }[] = [];
  let finished = 0;
  const app = express();
  app.use(
    createDirectorRouter(store, {
      config: { ...CONFIG, record: true },
      limits: LIMITS,
      recordings,
      liveDelivery: true,
      createPeer: () => new FakeDirectorPeer(),
      startSession: async () => "v=0\r\nanswer\r\n",
      createSegmentSinks: (session) => {
        built.push(session);
        return [{ init() {}, segment() {}, finish() { finished += 1; } }];
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const jam = buildJam();
  await store.createJam(jam);
  try {
    const opened = await fetch(`http://127.0.0.1:${port}/api/jams/${jam.id}/director/session`, {
      method: "POST",
    });
    assert.equal(opened.status, 201);
    const { sessionId } = await opened.json();
    assert.deepEqual(built, [{ jamId: jam.id, sessionId, container: "mp4" }]);

    const ended = await fetch(
      `http://127.0.0.1:${port}/api/jams/${jam.id}/director/session/${sessionId}/end`,
      { method: "POST" },
    );
    assert.equal(ended.status, 200);
    assert.equal(finished, 1);
  } finally {
    server.close();
  }
});

test("a server that does not record builds no sinks at all", async () => {
  let built = 0;
  const app = express();
  app.use(
    createDirectorRouter(store, {
      config: { ...CONFIG, record: false },
      limits: LIMITS,
      recordings,
      createPeer: () => new FakeDirectorPeer(),
      startSession: async () => "v=0\r\nanswer\r\n",
      createSegmentSinks: () => {
        built += 1;
        return [];
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const jam = buildJam();
  await store.createJam(jam);
  try {
    const opened = await fetch(`http://127.0.0.1:${port}/api/jams/${jam.id}/director/session`, {
      method: "POST",
    });
    assert.equal(opened.status, 201);
    assert.equal(built, 0);
    const { sessionId } = await opened.json();
    await fetch(`http://127.0.0.1:${port}/api/jams/${jam.id}/director/session/${sessionId}/end`, {
      method: "POST",
    });
  } finally {
    server.close();
  }
});

test("opening a session reports the same spend the read route does", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const opened = await (
    await fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, { method: "POST" })
  ).json();
  assert.equal(opened.spend.sessionUsd.toFixed(2), "4.80");
  assert.equal(opened.spend.budgetUsd, LIMITS.budgetUsd);
  const read = await (
    await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${opened.sessionId}`)
  ).json();
  assert.deepEqual(read.spend, opened.spend);
  await endSession(jam.id, opened.sessionId);
});

// The script is handed to fal a chunk at a time, not all at once in
// `configure`. That is what makes an edit reach the picture: a beat fal has
// been given is planned from and cannot change, so a beat is only given once
// it has closed — and what is sent is read from the story as it stands then.

/** Drives a stream to a chunk boundary and returns what fal was sent. */
function scriptsSent(): { prompt_version: number; script_mode?: string; replan?: boolean; script: { offset: number; prompt: string }[] }[] {
  return peer.channel
    .parsed()
    .filter((message) => message.type === "prompt" && Array.isArray(message.script)) as never;
}

test("beats are handed over as the stream advances, one chunk ahead of the frontier", async () => {
  // 8 beats of 5s: long enough that a handover is not the whole film.
  const { jam, sessionId } = await openJamSession(buildJam(5, 4));
  peer.channel.open();
  peer.channel.deliver({ type: "configured", prompt_version: 1, chunk_duration: 5 });

  // Nothing has been handed over yet: configure covered the opening window.
  assert.deepEqual(scriptsSent(), []);

  // fal is generating [5,10) and will need [10,15) next — which configure
  // already covered, so this chunk is due nothing.
  await deliverChunk(0, 5);
  assert.deepEqual(scriptsSent(), [], "nothing is sent twice");

  // Now it is generating [10,15) and needs [15,20): beat 3, and only beat 3.
  await deliverChunk(1, 10);

  const [first] = scriptsSent();
  assert.ok(first, "the beats of the next chunk were sent");
  assert.deepEqual(first.script.map((beat) => beat.offset), [15]);
  // The same versioned channel a direction uses, one higher than the last.
  assert.equal(first.prompt_version, 2);
  // Queued after what is planned rather than cutting into it.
  assert.equal(first.script_mode, "append");
  assert.equal(first.replan, false);

  await endSession(jam.id, sessionId);
});

test("a beat handed over is closed, and a beat still to come is not", async () => {
  const { jam, sessionId } = await openJamSession(buildJam(5, 4));
  peer.channel.open();
  peer.channel.deliver({ type: "configured", prompt_version: 1, chunk_duration: 5 });

  const window = async () => {
    const response = await fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}`);
    return (await response.json()).beats;
  };
  // Configure carried [0,15): beats 0, 1 and 2 are with the provider.
  assert.equal((await window()).minEditableBeatIndex, 3);

  await deliverChunk(0, 5);
  assert.equal((await window()).minEditableBeatIndex, 3, "still nothing more given");

  await deliverChunk(1, 10);
  // Beat 3 has now gone too, so the first beat an edit may touch is 4.
  assert.equal((await window()).minEditableBeatIndex, 4);

  await endSession(jam.id, sessionId);
});

test("what is handed over is the story as it stands, not the one the take opened with", async () => {
  const { jam, sessionId } = await openJamSession(buildJam(5, 4));
  peer.channel.open();
  peer.channel.deliver({ type: "configured", prompt_version: 1, chunk_duration: 5 });

  // An edit lands on beat 3 while the take runs — a beat nothing has been told
  // about yet, which is the only kind an edit can land on.
  const current = await store.getCurrentScriptRevision(jam.id);
  assert.ok(current);
  const rewritten = structuredClone(current.script);
  // Beat 3 of this film — two scenes of four portions — is the fourth portion
  // of the first scene, and it starts at 15s.
  rewritten.scenes[0].portions[3].action = "The door gives to a flood.";
  await store.commitScript(jam.id, rewritten, 3, { expectedRevision: current.revision });

  await deliverChunk(0, 5);
  await deliverChunk(1, 10);

  const [first] = scriptsSent();
  assert.deepEqual(first.script.map((beat) => beat.offset), [15]);
  assert.match(first.script[0].prompt, /The door gives to a flood\./);

  await endSession(jam.id, sessionId);
});

test("a beat is never handed over twice, and the end of the film is not an error", async () => {
  const { jam, sessionId } = await openJamSession(buildJam(5, 2));
  peer.channel.open();
  peer.channel.deliver({ type: "configured", prompt_version: 1, chunk_duration: 5 });

  for (const offset of [0, 5, 10, 15, 20]) {
    await deliverChunk(offset / 5, offset);
  }

  const offsets = scriptsSent().flatMap((message) => message.script.map((beat) => beat.offset));
  assert.deepEqual(offsets, [15], "beat 3 once, and nothing past the last beat");
  assert.deepEqual(
    scriptsSent().map((message) => message.prompt_version),
    [2],
  );

  await endSession(jam.id, sessionId);
});
