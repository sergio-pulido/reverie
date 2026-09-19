import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import liveToken from "../api/live/token";
import type { VonageAuth } from "../api/_lib/vonage-video";

const JAM_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000002";
const ACCESS_TOKEN = "header.payload.signature";
const SESSION_ID = "2_MX4".padEnd(40, "a");

const auth: VonageAuth = {
  mode: "application",
  applicationId: "11111111-2222-3333-4444-555555555555",
  privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
};

const supabaseEnv = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-for-tests",
} as NodeJS.ProcessEnv;

type Captured = { statusCode: number; body: Record<string, unknown>; headers: Record<string, string> };

function request(options: { method?: string; body?: unknown; authorization?: string; origin?: string }): IncomingMessage {
  const payload = options.body === undefined ? "" : JSON.stringify(options.body);
  const stream = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  stream.method = options.method ?? "POST";
  stream.url = "/api/live/token";
  stream.headers = {
    host: "reverie.test",
    ...(options.authorization ? { authorization: options.authorization } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
  };
  Object.defineProperty(stream, "socket", { value: { remoteAddress: `10.0.0.${Math.floor(Math.random() * 250) + 1}` } });
  return stream;
}

function responseCapture(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { statusCode: 0, body: {}, headers: {} };
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string) { captured.headers[name] = String(value); },
    end(payload?: string) {
      captured.statusCode = (response as unknown as { statusCode: number }).statusCode;
      captured.body = payload ? JSON.parse(payload) : {};
    },
  } as unknown as ServerResponse;
  return { response, captured };
}

/** A Supabase stand-in: identity, the caller's own membership row, the jam, and the RPC. */
function supabaseFetch(overrides: { status?: string; role?: "host" | "member"; jamStatus?: string } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const target = String(url);
    calls.push(target);
    if (target.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: USER_ID }), { status: 200 });
    }
    if (target.includes("/rest/v1/jam_members")) {
      return new Response(JSON.stringify([{ role: overrides.role ?? "member", status: overrides.status ?? "active" }]), { status: 200 });
    }
    if (target.includes("/rest/v1/jams")) {
      return new Response(JSON.stringify([{ status: overrides.jamStatus ?? "live" }]), { status: 200 });
    }
    if (target.includes("/rest/v1/rpc/ensure_jam_live_session")) {
      return new Response(JSON.stringify(SESSION_ID), { status: 200 });
    }
    if (target.includes("video.api.vonage.com")) {
      return new Response(JSON.stringify([{ session_id: SESSION_ID }]), { status: 200 });
    }
    throw new Error(`unexpected call to ${target}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function call(options: Parameters<typeof request>[0], extra: Parameters<typeof liveToken>[2] = {}) {
  const { response, captured } = responseCapture();
  await liveToken(request(options), response, { env: supabaseEnv, auth, ...extra });
  return captured;
}

test("only POST is answered", async () => {
  const captured = await call({ method: "GET" });
  assert.equal(captured.statusCode, 405);
  assert.equal(captured.body.code, "METHOD_NOT_ALLOWED");
});

test("a cross-origin browser call is refused", async () => {
  const captured = await call({ origin: "https://elsewhere.example", body: { jamId: JAM_ID } });
  assert.equal(captured.statusCode, 403);
  assert.equal(captured.body.code, "CROSS_ORIGIN_BLOCKED");
});

test("a deployment without live media says so instead of half-working", async () => {
  const { response, captured } = responseCapture();
  await liveToken(request({ body: { jamId: JAM_ID } }), response, { env: {} as NodeJS.ProcessEnv, auth: null });
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.status, "live_not_configured");
  assert.deepEqual(captured.body.missing, ["vonage", "supabase"]);
});

test("a caller without a bearer token gets no session", async () => {
  const captured = await call({ body: { jamId: JAM_ID } });
  assert.equal(captured.statusCode, 401);
  assert.equal(captured.body.code, "LIVE_UNAUTHENTICATED");
});

test("the request body carries a jam id and nothing else", async () => {
  const withRole = await call({
    authorization: `Bearer ${ACCESS_TOKEN}`,
    body: { jamId: JAM_ID, role: "moderator" },
  });
  assert.equal(withRole.statusCode, 400, "an unknown field is rejected rather than ignored");

  const malformed = await call({ authorization: `Bearer ${ACCESS_TOKEN}`, body: { jamId: "not-a-uuid" } });
  assert.equal(malformed.statusCode, 400);
});

test("a waiting participant cannot join the live stage", async () => {
  const { fetchImpl } = supabaseFetch({ status: "waiting" });
  const captured = await call(
    { authorization: `Bearer ${ACCESS_TOKEN}`, body: { jamId: JAM_ID } },
    { fetchImpl },
  );
  assert.equal(captured.statusCode, 403);
  assert.equal(captured.body.code, "LIVE_FORBIDDEN");
});

test("a closed jam has no live stage", async () => {
  const { fetchImpl } = supabaseFetch({ jamStatus: "closed" });
  const captured = await call(
    { authorization: `Bearer ${ACCESS_TOKEN}`, body: { jamId: JAM_ID } },
    { fetchImpl },
  );
  assert.equal(captured.statusCode, 403);
});

test("an active member receives a publisher token bound to the jam's session", async () => {
  const { fetchImpl, calls } = supabaseFetch();
  const captured = await call(
    { authorization: `Bearer ${ACCESS_TOKEN}`, body: { jamId: JAM_ID } },
    { fetchImpl },
  );

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.status, "ok");
  assert.equal(captured.body.role, "publisher");
  assert.equal(captured.body.sessionId, SESSION_ID);
  assert.equal(captured.body.authId, "11111111-2222-3333-4444-555555555555");

  const claims = JSON.parse(Buffer.from(String(captured.body.token).split(".")[1], "base64url").toString());
  assert.equal(claims.session_id, SESSION_ID);
  assert.equal(claims.role, "publisher");
  assert.ok(!JSON.stringify(captured.body).includes("PRIVATE KEY"), "no key material is ever returned");

  assert.ok(calls.some((url) => url.endsWith("/auth/v1/user")), "identity is resolved from Auth, not from the body");
  assert.ok(calls.some((url) => url.includes(`user_id=eq.${USER_ID}`)), "membership is read for the authenticated user");
  assert.ok(calls.some((url) => url.includes("ensure_jam_live_session")), "the session id is settled by the database");
});

test("the host is the only caller who gets a moderator token", async () => {
  const { fetchImpl } = supabaseFetch({ role: "host" });
  const captured = await call(
    { authorization: `Bearer ${ACCESS_TOKEN}`, body: { jamId: JAM_ID } },
    { fetchImpl },
  );
  assert.equal(captured.body.role, "moderator");
});

test("a rejected Supabase session is an authentication failure, not a live failure", async () => {
  const fetchImpl = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  const captured = await call(
    { authorization: `Bearer ${ACCESS_TOKEN}`, body: { jamId: JAM_ID } },
    { fetchImpl },
  );
  assert.equal(captured.statusCode, 401);
  assert.equal(captured.body.code, "LIVE_UNAUTHENTICATED");
});
