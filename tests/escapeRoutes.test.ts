import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { createEscapeRouter } from "../apps/server/escape";
import { EscapeRooms } from "../apps/server/escapeSessions";
import { InMemoryEscapeMediaStore } from "../apps/server/escapeMedia";
import { EscapeAuthError, type EscapeCaller } from "../apps/server/escapeAuth";
import { SpendAccount } from "../apps/server/spendLedger";
import { findSegmentModel } from "../apps/server/providers/falSegmentModels";
import { fakeMp4 } from "./fakeMp4";

/**
 * The HTTP surface. Identity is injected here; what it is checked against in
 * production is tests/escapeAuth's concern. What matters at this level is that
 * no route takes the caller's word for who they are and that every refusal
 * answers in the shape the rest of this server uses.
 */

let server: Server;
let baseUrl: string;
let rooms: EscapeRooms;
const media = new InMemoryEscapeMediaStore();
const account = new SpendAccount(100);
/** Who the next request is, and whether authorization lets them in. */
let caller: EscapeCaller | EscapeAuthError = { userId: "host-1", role: "host", status: "active" };

const originalFetch = globalThis.fetch;

function stubFal() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(baseUrl)) return originalFetch(input as RequestInfo);
    if (url.endsWith("/text-to-video")) {
      return new Response(JSON.stringify({ request_id: "req-1" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/status")) {
      return new Response(JSON.stringify({ status: "COMPLETED" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/requests/")) {
      return new Response(JSON.stringify({ video: { url: "https://v3b.fal.media/clip.mp4" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(new Uint8Array(fakeMp4(15.104, 64)), {
      headers: { "content-type": "video/mp4" },
    });
  }) as typeof fetch;
}

function call(path: string, init?: RequestInit) {
  return originalFetch(`${baseUrl}${path}`, init);
}

function post(path: string, body?: unknown) {
  return call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

before(async () => {
  rooms = new EscapeRooms({
    media,
    account,
    fal: { apiKey: "test-key", model: findSegmentModel("minimax/h3-max/text-to-video")! },
    nebius: null,
    limits: { usdPerSecond: 0.08, loopSeconds: 5, maxConcurrentGenerations: 2 },
    sleep: async () => {},
  });
  const app = express();
  app.use(
    createEscapeRouter({
      rooms,
      media,
      account,
      authorize: async () => {
        if (caller instanceof EscapeAuthError) throw caller;
        return caller;
      },
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  stubFal();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("the scenarios a host can choose are served as data, not invented", async () => {
  const response = await call("/api/escape-room/scenarios");
  assert.equal(response.status, 200);
  const { scenarios } = await response.json();
  assert.equal(scenarios.length, 3);
  for (const scenario of scenarios) {
    assert.ok(scenario.id && scenario.title && scenario.logline && scenario.goal);
    assert.ok(scenario.locationCount >= 1);
  }
});

test("only the host opens a room", async () => {
  caller = { userId: "member-1", role: "member", status: "active" };
  const refused = await post("/api/jams/room-a/escape-room", { scenarioId: "night-audit" });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, "escape_forbidden");

  caller = { userId: "host-1", role: "host", status: "active" };
  const opened = await post("/api/jams/room-a/escape-room", { scenarioId: "night-audit" });
  assert.equal(opened.status, 201);
  const snapshot = await opened.json();
  assert.equal(snapshot.scenarioId, "night-audit");
  assert.equal(snapshot.title, "The Night Audit");
  assert.equal(snapshot.location.name, "the reading room");
  assert.equal(snapshot.turn.index, 1);
  assert.deepEqual(snapshot.beats, []);
  assert.equal(snapshot.ended, null);
  assert.equal(snapshot.mediaDurable, false);
  assert.equal(snapshot.spend.budgetUsd, 100);
});

test("a scenario this build does not ship is refused before anything is spent", async () => {
  const response = await post("/api/jams/room-b/escape-room", { scenarioId: "the-moon" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "unknown_scenario");
  assert.equal((await call("/api/jams/room-b/escape-room")).status, 404);
});

test("a caller who is not signed in is refused every route", async () => {
  caller = new EscapeAuthError(401, "escape_unauthenticated", "Sign in to open this room.");
  for (const [method, path] of [
    ["GET", "/api/jams/room-a/escape-room"],
    ["POST", "/api/jams/room-a/escape-room/proposals"],
    ["POST", "/api/jams/room-a/escape-room/votes"],
    ["POST", "/api/jams/room-a/escape-room/settle"],
    ["GET", "/api/jams/room-a/escape-room/segments/anything"],
  ] as const) {
    const response = method === "GET" ? await call(path) : await post(path);
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal((await response.json()).error.code, "escape_unauthenticated");
  }
  caller = { userId: "host-1", role: "host", status: "active" };
});

test("a member proposes, a member votes, and only the host settles", async () => {
  await rooms.idle();
  caller = { userId: "member-1", role: "member", status: "active" };
  const proposed = await post("/api/jams/room-a/escape-room/proposals", {
    body: "lift the counter hatch",
    authorName: "Ada",
  });
  assert.equal(proposed.status, 201);
  const { proposalId, snapshot } = await proposed.json();
  assert.equal(snapshot.turn.proposals.length, 1);
  assert.equal(snapshot.turn.proposals[0].authorName, "Ada");
  assert.equal(snapshot.turn.proposals[0].votes, 0);

  const voted = await post("/api/jams/room-a/escape-room/votes", { proposalId });
  assert.equal(voted.status, 200);
  const afterVote = await voted.json();
  assert.equal(afterVote.turn.yourVote, proposalId);
  assert.equal(afterVote.turn.proposals[0].votes, 1);

  const refused = await post("/api/jams/room-a/escape-room/settle");
  assert.equal(refused.status, 403);

  caller = { userId: "host-1", role: "host", status: "active" };
  const settled = await post("/api/jams/room-a/escape-room/settle");
  assert.equal(settled.status, 200);
  const body = await settled.json();
  assert.ok(body.beatId);
  assert.equal(body.snapshot.beats.length, 1);
  assert.equal(body.snapshot.beats[0].outcome, "advanced");
  assert.equal(body.snapshot.turn.index, 2);
});

test("the author's identity comes from the session, never from the body", async () => {
  const response = await post("/api/jams/room-a/escape-room/proposals", {
    body: "take the torch",
    authorName: "Ada",
    authorId: "somebody-else",
  });
  assert.equal(response.status, 400, "an unknown field is refused outright");
});

test("a generated segment is served by this server, with its measured length", async () => {
  await rooms.idle();
  const snapshot = await (await call("/api/jams/room-a/escape-room")).json();
  const ready = snapshot.beats[0].media;
  assert.equal(ready.status, "ready");
  assert.equal(ready.seconds, 15.104);
  assert.match(ready.src, /^\/api\/jams\/room-a\/escape-room\/segments\/[0-9a-f-]+$/);

  const clip = await call(ready.src);
  assert.equal(clip.status, 200);
  assert.equal(clip.headers.get("content-type"), "video/mp4");
  assert.ok(Number(clip.headers.get("content-length")) > 0);
  assert.equal((await call("/api/jams/room-a/escape-room/segments/nothing")).status, 404);
});

test("an empty turn cannot be settled, and an invalid proposal is refused", async () => {
  const empty = await post("/api/jams/room-a/escape-room/settle");
  assert.equal(empty.status, 409);
  assert.equal((await empty.json()).error.code, "no_proposals");

  const blank = await post("/api/jams/room-a/escape-room/proposals", { body: "   " });
  assert.equal(blank.status, 400);
  const long = await post("/api/jams/room-a/escape-room/proposals", { body: "x".repeat(281) });
  assert.equal(long.status, 400);
  const notAVote = await post("/api/jams/room-a/escape-room/votes", { proposalId: "nope" });
  assert.equal(notAVote.status, 400);
});

test("a jam with no escape room says so rather than making one up", async () => {
  const response = await call("/api/jams/room-never/escape-room");
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_open");
  assert.match(body.error.safeMessage, /not running an escape room/);
});
