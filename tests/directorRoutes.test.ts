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

function buildJam(): Jam {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    format: { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 },
    script: buildScript(5, 2, 2),
  };
}

async function openJamSession(): Promise<{ jam: Jam; sessionId: string }> {
  const jam = buildJam();
  await store.createJam(jam);
  const response = await fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
  });
  assert.equal(response.status, 201);
  const { sessionId } = await response.json();
  return { jam, sessionId };
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

test("the configure message is the jam's script, sent by the server", async () => {
  const { jam, sessionId } = await openJamSession();
  peer.channel.open();

  const [configure] = peer.channel.parsed();
  assert.equal(configure.type, "configure");
  assert.equal(configure.prompt_version, 1);
  assert.equal((configure.script as unknown[]).length, 4);
  assert.deepEqual(
    (configure.script as { offset: number }[]).map((beat) => beat.offset),
    [0, 5, 10, 15],
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

  assert.equal((await endSession(jam.id, sessionId)).status, 204);
  const third = await fetch(`${baseUrl}/api/jams/${jam.id}/director/session`, {
    method: "POST",
  });
  assert.equal(third.status, 201);
  assert.equal((await third.clone().json()).attached, false);
  await endSession(jam.id, (await third.json()).sessionId);
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
  assert.equal((await endSession(jam.id, sessionId)).status, 204);
  assert.ok(peer.closed);
  // The provider was told to stop.
  assert.equal(peer.channel.parsed().at(-1)!.type, "stop");
  assert.equal((await endSession(jam.id, sessionId)).status, 204);
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
  // Beat 1 is on screen; beat 2 is already committed to generation.
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
  const { jam, sessionId } = await openJamSession();
  const watch = () =>
    fetch(`${baseUrl}/api/jams/${jam.id}/director/session/${sessionId}/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\nviewer-offer\r\n" }),
    });

  assert.equal((await (await watch()).json()).viewers, 1);
  assert.equal((await (await watch()).json()).viewers, 2);

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

test("spend follows the seconds the stream actually generated, not its reservation", async () => {
  const before = await remainingUsd();
  const { jam, sessionId } = await openJamSession();
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
