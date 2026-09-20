import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { deflateSync } from "node:zlib";
import type { Jam } from "../src/core/jam";
import { InMemoryJamStore } from "../apps/server/jams";
import { createLikenessRouter } from "../apps/server/likeness";
import { FalBudget, type BeatSpendRates } from "../apps/server/falBudget";
import { InMemoryObjectStore } from "../apps/server/privateObjects";
import {
  BEAT_MODELS,
  type BeatClip,
  type BeatRequest,
  type BeatVideoConfig,
} from "../apps/server/providers/falBeatVideo";
import type { LiveConsent, LiveConsentKind } from "../src/core/liveMedia";
import { buildScript } from "./helpers";

const ALICE = "a0000000-0000-4000-8000-00000000000a";
const BRUNO = "b0000000-0000-4000-8000-00000000000b";
const SUPABASE = { url: "https://supabase.test", anonKey: "anon-key" };

const BEAT_CONFIG: BeatVideoConfig = { apiKey: "test-key", resolution: "768P", aspectRatio: "16:9" };
const RATES: BeatSpendRates = {
  plainUsdPerSecond: 0.04,
  likenessUsdPerSecond: 0.08,
  maxConcurrentBeats: 2,
};

/** A valid PNG of the size the routes require, so tests exercise the real check. */
function png(size: number): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.byteLength, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([length, body, tail]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const FRAME = png(512);
const TINY_FRAME = png(64);

/** The room's register, as the tests choose to set it. */
let register: LiveConsent[] = [];
/** Who each bearer token belongs to. A token with no entry is not signed in. */
const tokens = new Map<string, string>([["alice-token", ALICE], ["bruno-token", BRUNO]]);
let memberStatus = new Map<string, string>([[ALICE, "active"], [BRUNO, "active"]]);
let jamStatus = "open";
/** Every request the fake provider saw, so a test can assert what was sent. */
let submitted: BeatRequest[] = [];
let generateFails: Error | null = null;

const store = new InMemoryJamStore();
const budget = new FalBudget(100);
const frames = new InMemoryObjectStore(32);
const clips = new InMemoryObjectStore(32);
let server: Server;
let baseUrl: string;
let now = Date.parse("2026-09-20T12:00:00.000Z");

let sequence = 0;
function consent(overrides: Partial<LiveConsent> & { jam_id: string }): LiveConsent {
  sequence += 1;
  const id = `c0000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  return {
    id,
    owner_id: ALICE,
    kind: "likeness" as LiveConsentKind,
    purpose: "appear as the lead",
    asset_ref: `likeness:${randomUUID()}`,
    granted_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 30 * 60_000).toISOString(),
    withdrawn_at: null,
    ...overrides,
  };
}

/** Stands in for Supabase: Auth, the membership read, and the register read. */
const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  if (url.includes("/auth/v1/user")) {
    // The caller is whoever the token says, which is the only place identity comes from.
    const token = currentToken;
    const userId = token ? tokens.get(token) : undefined;
    return userId ? json({ id: userId }) : new Response("{}", { status: 401 });
  }
  if (url.includes("/rest/v1/jam_members")) {
    const userId = /user_id=eq\.([^&]+)/.exec(url)?.[1] ?? "";
    const status = memberStatus.get(userId);
    return json(status ? [{ role: userId === ALICE ? "host" : "member", status }] : []);
  }
  if (url.includes("/rest/v1/jams")) return json([{ status: jamStatus }]);
  if (url.includes("/rest/v1/jam_live_consents")) {
    const jamId = /jam_id=eq\.([^&]+)/.exec(url)?.[1] ?? "";
    return json(register.filter((row) => row.jam_id === jamId));
  }
  throw new Error(`unexpected fetch: ${url}`);
};

/** Set per request so the Auth stub can answer for the caller being tested. */
let currentToken: string | null = null;

async function generate(_config: BeatVideoConfig, request: BeatRequest): Promise<BeatClip> {
  submitted.push(request);
  if (generateFails) throw generateFails;
  return {
    bytes: Buffer.from("clip-bytes"),
    contentType: "video/mp4",
    model: request.frames.length > 0 ? BEAT_MODELS.likeness : BEAT_MODELS.plain,
    requestId: `req-${submitted.length}`,
    elapsedMs: 5_000,
    providerInferenceSeconds: 2.5,
  };
}

before(async () => {
  const app = express();
  app.use(
    createLikenessRouter(store, {
      supabase: SUPABASE,
      rest: { fetchImpl: fakeFetch },
      beatConfig: BEAT_CONFIG,
      rates: RATES,
      budget,
      frames,
      clips,
      generate,
      now: () => now,
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(() => { server?.close(); });

beforeEach(() => {
  register = [];
  submitted = [];
  generateFails = null;
  jamStatus = "open";
  memberStatus = new Map([[ALICE, "active"], [BRUNO, "active"]]);
  now = Date.parse("2026-09-20T12:00:00.000Z");
});

async function buildJam(): Promise<Jam> {
  const jam: Jam = {
    id: randomUUID(),
    createdAt: new Date(now).toISOString(),
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    lifecycle: "live",
    format: { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 },
    script: buildScript(5, 2, 2),
  };
  await store.createJam(jam);
  return jam;
}

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: { bytes: Buffer; contentType: string },
): Promise<Response> {
  currentToken = token;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": body.contentType } : {}),
    },
    body: body ? new Uint8Array(body.bytes) : undefined,
  });
}

/** A jam where `owner` has agreed to appear and their frame has been attached. */
async function jamWithLikeness(owner = ALICE, token = owner === ALICE ? "alice-token" : "bruno-token") {
  const jam = await buildJam();
  const grant = consent({ jam_id: jam.id, owner_id: owner });
  register.push(grant);
  const stored = await call("PUT", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, token, {
    bytes: FRAME,
    contentType: "image/png",
  });
  assert.equal(stored.status, 201);
  return { jam, grant };
}

test("a frame is attached only to the caller's own standing agreement", async () => {
  const { jam, grant } = await jamWithLikeness();

  const byOther = await call("PUT", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, "bruno-token", {
    bytes: FRAME,
    contentType: "image/png",
  });
  assert.equal(byOther.status, 403);
  assert.equal((await byOther.json()).error.code, "not_yours");
});

test("a participant cannot read another's frame, and can read their own", async () => {
  const { jam, grant } = await jamWithLikeness();

  const mine = await call("GET", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, "alice-token");
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get("content-type"), "image/png");

  const theirs = await call("GET", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, "bruno-token");
  assert.equal(theirs.status, 403);
});

test("a withdrawn agreement can no longer take or give back a frame", async () => {
  const { jam, grant } = await jamWithLikeness();
  register = register.map((row) =>
    row.id === grant.id ? { ...row, withdrawn_at: new Date(now).toISOString() } : row,
  );

  const attach = await call("PUT", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, "alice-token", {
    bytes: FRAME,
    contentType: "image/png",
  });
  assert.equal(attach.status, 403);
  assert.equal((await attach.json()).error.code, "withdrawn_or_expired");

  const read = await call("GET", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, "alice-token");
  assert.equal(read.status, 403);
});

test("an expired agreement is refused exactly as a withdrawn one is", async () => {
  const { jam, grant } = await jamWithLikeness();
  now += 31 * 60_000;

  const read = await call("GET", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, "alice-token");
  assert.equal(read.status, 403);
  assert.equal((await read.json()).error.code, "withdrawn_or_expired");
});

test("withdrawing lets the owner discard their frame, and only them", async () => {
  const { jam, grant } = await jamWithLikeness();
  register = register.map((row) =>
    row.id === grant.id ? { ...row, withdrawn_at: new Date(now).toISOString() } : row,
  );

  const byOther = await call("DELETE", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, "bruno-token");
  assert.equal(byOther.status, 403);

  const byOwner = await call("DELETE", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, "alice-token");
  assert.equal(byOwner.status, 204);
  assert.equal(await frames.get(jam.id, grant.asset_ref.slice("likeness:".length)), null);
});

test("a frame the provider would refuse is refused here first", async () => {
  const jam = await buildJam();
  const grant = consent({ jam_id: jam.id });
  register.push(grant);

  const small = await call("PUT", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, "alice-token", {
    bytes: TINY_FRAME,
    contentType: "image/png",
  });
  assert.equal(small.status, 400);
  assert.equal((await small.json()).error.code, "frame_too_small");

  const wrongType = await call("PUT", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, "alice-token", {
    bytes: FRAME,
    contentType: "image/gif",
  });
  assert.equal(wrongType.status, 400);
});

test("a reference the register did not issue addresses nothing", async () => {
  const jam = await buildJam();
  const forged = await call("PUT", `/api/jams/${jam.id}/likeness/likeness:not-a-uuid`, "alice-token", {
    bytes: FRAME,
    contentType: "image/png",
  });
  assert.equal(forged.status, 404);
});

test("a caller who is not an active member reaches nothing", async () => {
  const { jam, grant } = await jamWithLikeness();
  memberStatus.set(BRUNO, "waiting");

  const waiting = await call("GET", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, "bruno-token");
  assert.equal(waiting.status, 403);

  const anonymous = await call("GET", `/api/jams/${jam.id}/likeness/${grant.asset_ref}`, null);
  assert.equal(anonymous.status, 401);
});

test("a jam with no agreement generates a plain beat, as it did before", async () => {
  const jam = await buildJam();
  const response = await call("POST", `/api/jams/${jam.id}/beats/0/video`, "alice-token");
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.model, BEAT_MODELS.plain);
  assert.equal(body.likeness.standing, "none");
  assert.deepEqual(body.likeness.ownerIds, []);
  assert.equal(submitted.at(-1)?.frames.length, 0);
});

test("a standing agreement puts that person's frame in the beat", async () => {
  const { jam, grant } = await jamWithLikeness();
  const response = await call("POST", `/api/jams/${jam.id}/beats/0/video`, "alice-token");
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.model, BEAT_MODELS.likeness);
  assert.equal(body.likeness.standing, "standing");
  assert.deepEqual(body.likeness.ownerIds, [ALICE]);

  const request = submitted.at(-1);
  assert.equal(request?.frames.length, 1);
  assert.equal(request?.frames[0].assetRef, grant.asset_ref);
  // The provider learns that an image is a character and nothing else about the person.
  assert.match(request?.prompt ?? "", /^Image 1 is a character in this scene\./);
  assert.doesNotMatch(request?.prompt ?? "", new RegExp(ALICE));
});

test("a withdrawn agreement seeds no further beat", async () => {
  const { jam, grant } = await jamWithLikeness();
  register = register.map((row) =>
    row.id === grant.id ? { ...row, withdrawn_at: new Date(now).toISOString() } : row,
  );

  const response = await call("POST", `/api/jams/${jam.id}/beats/1/video`, "alice-token");
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.model, BEAT_MODELS.plain);
  assert.equal(body.likeness.standing, "none");
  assert.equal(submitted.at(-1)?.frames.length, 0);
});

test("an expired agreement seeds no further beat either", async () => {
  const { jam } = await jamWithLikeness();
  now += 31 * 60_000;
  const response = await call("POST", `/api/jams/${jam.id}/beats/1/video`, "alice-token");
  assert.equal(response.status, 201);
  assert.equal(submitted.at(-1)?.frames.length, 0);
});

test("a beat made before a withdrawal keeps saying what it was made from", async () => {
  const { jam, grant } = await jamWithLikeness();
  const made = await call("POST", `/api/jams/${jam.id}/beats/0/video`, "alice-token");
  assert.equal((await made.json()).likeness.standing, "standing");

  register = register.map((row) =>
    row.id === grant.id ? { ...row, withdrawn_at: new Date(now).toISOString() } : row,
  );

  const after = await call("GET", `/api/jams/${jam.id}/beats/0`, "alice-token");
  const body = await after.json();
  // The withdrawal did not reach a beat that already exists, and the beat says so rather
  // than reporting that nobody was ever in it.
  assert.equal(body.likeness.standing, "withdrawn_since");
  assert.notEqual(body.likeness.standing, "none");
  assert.deepEqual(body.likeness.ownerIds, [ALICE]);
});

test("a beat is never generated with a likeness whose frame is missing", async () => {
  const jam = await buildJam();
  register.push(consent({ jam_id: jam.id }));

  const response = await call("POST", `/api/jams/${jam.id}/beats/0/video`, "alice-token");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "frame_missing");
  // Nothing was generated: a missing frame is an error the room sees, not a quiet plain beat.
  assert.equal(submitted.length, 0);
});

test("another participant's standing agreement is used, and only through the register", async () => {
  const { jam } = await jamWithLikeness(BRUNO, "bruno-token");
  const response = await call("POST", `/api/jams/${jam.id}/beats/0/video`, "alice-token");
  const body = await response.json();
  assert.deepEqual(body.likeness.ownerIds, [BRUNO]);
  assert.equal(submitted.at(-1)?.frames.length, 1);
});

test("the clip is served by this server and never as a provider address", async () => {
  const { jam } = await jamWithLikeness();
  await call("POST", `/api/jams/${jam.id}/beats/0/video`, "alice-token");

  const clip = await call("GET", `/api/jams/${jam.id}/beats/0/video`, "alice-token");
  assert.equal(clip.status, 200);
  assert.equal(clip.headers.get("content-type"), "video/mp4");
  assert.equal(await clip.text(), "clip-bytes");

  const byStranger = await call("GET", `/api/jams/${jam.id}/beats/0/video`, null);
  assert.equal(byStranger.status, 401);
});

test("a beat spends against the shared budget and reports what is left", async () => {
  const jam = await buildJam();
  const before = budget.remainingUsd;
  const response = await call("POST", `/api/jams/${jam.id}/beats/0/video`, "alice-token");
  const body = await response.json();
  // 5 seconds at the plain rate.
  assert.equal(Number((before - budget.remainingUsd).toFixed(4)), 0.2);
  assert.equal(body.remainingBudgetUsd, Number(budget.remainingUsd.toFixed(4)));
});

test("a spent budget refuses the beat rather than generating it", async () => {
  const jam = await buildJam();
  const spent = new FalBudget(0.01);
  const app = express();
  app.use(
    createLikenessRouter(store, {
      supabase: SUPABASE,
      rest: { fetchImpl: fakeFetch },
      beatConfig: BEAT_CONFIG,
      rates: RATES,
      budget: spent,
      frames,
      clips,
      generate,
      now: () => now,
    }),
  );
  const local = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = local.address();
  const port = typeof address === "object" && address ? address.port : 0;
  currentToken = "alice-token";
  const response = await fetch(`http://127.0.0.1:${port}/api/jams/${jam.id}/beats/0/video`, {
    method: "POST",
    headers: { authorization: "Bearer alice-token" },
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "budget_exhausted");
  assert.equal(submitted.length, 0);
  local.close();
});

test("without a provider a beat is refused, never mocked", async () => {
  const jam = await buildJam();
  const app = express();
  app.use(
    createLikenessRouter(store, {
      supabase: SUPABASE,
      rest: { fetchImpl: fakeFetch },
      beatConfig: null,
      rates: RATES,
      budget,
      frames,
      clips,
      generate,
      now: () => now,
    }),
  );
  const local = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = local.address();
  const port = typeof address === "object" && address ? address.port : 0;
  currentToken = "alice-token";
  const response = await fetch(`http://127.0.0.1:${port}/api/jams/${jam.id}/beats/0/video`, {
    method: "POST",
    headers: { authorization: "Bearer alice-token" },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "generation_disabled");
  assert.equal(submitted.length, 0);
  local.close();
});

test("a server that cannot check consent will not use anyone's likeness", async () => {
  const jam = await buildJam();
  const app = express();
  app.use(
    createLikenessRouter(store, {
      supabase: null,
      beatConfig: BEAT_CONFIG,
      rates: RATES,
      budget,
      frames,
      clips,
      generate,
      now: () => now,
    }),
  );
  const local = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = local.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/api/jams/${jam.id}/beats/0/video`, {
    method: "POST",
    headers: { authorization: "Bearer alice-token" },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "likeness_not_configured");
  assert.equal(submitted.length, 0);
  local.close();
});

test("a closed jam generates nothing", async () => {
  const jam = await buildJam();
  jamStatus = "closed";
  const response = await call("POST", `/api/jams/${jam.id}/beats/0/video`, "alice-token");
  assert.equal(response.status, 403);
  assert.equal(submitted.length, 0);
});

test("a provider failure is a typed error carrying no provider text", async () => {
  const jam = await buildJam();
  const { BeatVideoError } = await import("../apps/server/providers/falBeatVideo");
  generateFails = new BeatVideoError("beat_provider_refused", "The beat queue refused that request (status 400).", false);
  const response = await call("POST", `/api/jams/${jam.id}/beats/0/video`, "alice-token");
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error.code, "beat_provider_refused");
  assert.doesNotMatch(body.error.safeMessage, /fal|queue\.fal\.run|Key /);
});
