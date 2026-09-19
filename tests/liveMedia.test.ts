import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import {
  classifyMediaError,
  decideLiveAccess,
  isConsentEffective,
  normalizePurpose,
  permittedKinds,
  type LiveConsent,
} from "../src/core/liveMedia";
import {
  apiJwt,
  clientAuthId,
  createVideoSession,
  LiveMediaError,
  mintConnectionToken,
  parseSessionId,
  readVonageAuth,
  TOKEN_MAX_TTL_SECONDS,
  type VonageAuth,
} from "../api/_lib/vonage-video";

const projectAuth: VonageAuth = { mode: "project", apiKey: "47110815", apiSecret: "not-a-real-secret" };

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const applicationAuth: VonageAuth = {
  mode: "application",
  applicationId: "11111111-2222-3333-4444-555555555555",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

function consent(overrides: Partial<LiveConsent> = {}): LiveConsent {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    jam_id: "10000000-0000-4000-8000-000000000001",
    owner_id: "20000000-0000-4000-8000-000000000001",
    kind: "camera",
    purpose: "show the costume",
    asset_ref: "live:30000000-0000-4000-8000-000000000001",
    granted_at: new Date(1_000).toISOString(),
    expires_at: new Date(60_000).toISOString(),
    withdrawn_at: null,
    ...overrides,
  };
}

// --- Access decisions --------------------------------------------------------

test("the server derives the live role from membership, and a client cannot ask for one", () => {
  assert.deepEqual(decideLiveAccess({ role: "host", status: "active", jamStatus: "live" }), { allowed: true, role: "moderator" });
  assert.deepEqual(decideLiveAccess({ role: "member", status: "active", jamStatus: "live" }), { allowed: true, role: "publisher" });
  assert.deepEqual(decideLiveAccess({ role: "member", status: "waiting", jamStatus: "live" }), { allowed: false, reason: "not_active" });
  assert.deepEqual(decideLiveAccess({ role: "member", status: "removed", jamStatus: "live" }), { allowed: false, reason: "not_active" });
  assert.deepEqual(decideLiveAccess({ role: "host", status: "active", jamStatus: "closed" }), { allowed: false, reason: "jam_closed" });
  assert.deepEqual(decideLiveAccess({ role: "host", status: "active", jamStatus: "completed" }), { allowed: false, reason: "jam_closed" });
});

// --- Consent -----------------------------------------------------------------

test("consent stops on withdrawal and on expiry alike", () => {
  assert.equal(isConsentEffective(consent(), 30_000), true);
  assert.equal(isConsentEffective(consent(), 60_001), false, "an expired consent is not effective");
  assert.equal(isConsentEffective(consent({ withdrawn_at: new Date(20_000).toISOString() }), 30_000), false);
  assert.equal(isConsentEffective(consent({ expires_at: "not a date" }), 30_000), false);
});

test("only a participant's own effective consents permit their tracks", () => {
  const mine = consent({ id: "c1", kind: "camera" });
  const alsoMine = consent({ id: "c2", kind: "microphone" });
  const withdrawn = consent({ id: "c3", kind: "screen", withdrawn_at: new Date(5_000).toISOString() });
  const someoneElse = consent({ id: "c4", kind: "screen", owner_id: "99999999-0000-4000-8000-000000000009" });

  const permitted = permittedKinds([mine, alsoMine, withdrawn, someoneElse], mine.owner_id, 30_000);
  assert.deepEqual([...permitted].sort(), ["camera", "microphone"]);
});

test("a purpose is required and bounded", () => {
  assert.deepEqual(normalizePurpose("  use   this palette "), { ok: true, value: "use this palette" });
  assert.equal(normalizePurpose("no").ok, false);
  assert.equal(normalizePurpose("x".repeat(201)).ok, false);
});

test("a refused device permission is classified as denial, not as a fault", () => {
  assert.equal(classifyMediaError({ name: "NotAllowedError" }), "denied");
  assert.equal(classifyMediaError({ name: "NotFoundError" }), "unavailable");
  assert.equal(classifyMediaError({ name: "NotReadableError" }), "in_use");
  assert.equal(classifyMediaError(new Error("boom")), "failed");
});

// --- Credentials -------------------------------------------------------------

test("live media stays off unless it is switched on and fully credentialed", () => {
  const application = {
    REVERIE_LIVE_ENABLED: "true",
    VONAGE_APPLICATION_ID: applicationAuth.applicationId,
    VONAGE_PRIVATE_KEY: applicationAuth.mode === "application" ? applicationAuth.privateKey : "",
  } as NodeJS.ProcessEnv;

  assert.equal(readVonageAuth({ ...application, REVERIE_LIVE_ENABLED: "false" } as NodeJS.ProcessEnv), null);
  assert.equal(readVonageAuth({ REVERIE_LIVE_ENABLED: "true" } as NodeJS.ProcessEnv), null);
  assert.equal(readVonageAuth(application)?.mode, "application");

  // An account-level API key is not a video project key and cannot create a session.
  const accountKey = { REVERIE_LIVE_ENABLED: "true", VONAGE_API_KEY: "abcd1234", VONAGE_API_SECRET: "sixteencharacter" } as NodeJS.ProcessEnv;
  assert.equal(readVonageAuth(accountKey), null);
  assert.equal(readVonageAuth({ ...accountKey, VONAGE_API_KEY: "47110815" } as NodeJS.ProcessEnv)?.mode, "project");
});

test("the browser only ever receives the public identifier", () => {
  assert.equal(clientAuthId(projectAuth), "47110815");
  assert.equal(clientAuthId(applicationAuth), "11111111-2222-3333-4444-555555555555");
});

// --- Tokens ------------------------------------------------------------------

test("a project connection token is signed with the secret and binds the session", () => {
  const { token, expiresAt } = mintConnectionToken(projectAuth, { sessionId: "s".repeat(40), role: "publisher", now: 1_000_000 });
  const [header, payload, signature] = token.split(".");
  const expected = createHmac("sha256", "not-a-real-secret").update(`${header}.${payload}`).digest("base64url");

  assert.equal(signature, expected, "the signature must verify against the API secret");
  const claims = claimsOf(token);
  assert.equal(claims.scope, "session.connect");
  assert.equal(claims.session_id, "s".repeat(40));
  assert.equal(claims.role, "publisher");
  assert.equal(claims.ist, "project");
  assert.equal(Number(claims.exp) - Number(claims.iat), 600);
  assert.equal(expiresAt, new Date((1_000 + 600) * 1_000).toISOString());
});

test("an application connection token verifies against the application key pair", () => {
  const { token } = mintConnectionToken(applicationAuth, { sessionId: "s".repeat(40), role: "moderator", now: 1_000_000 });
  const [header, payload, signature] = token.split(".");
  const verified = createVerify("RSA-SHA256")
    .update(`${header}.${payload}`)
    .end()
    .verify(publicKey, Buffer.from(signature, "base64url"));

  assert.equal(verified, true);
  const claims = claimsOf(token);
  assert.equal(claims.application_id, "11111111-2222-3333-4444-555555555555");
  assert.equal(claims.role, "moderator");
  assert.equal(claims.sub, "video");
  assert.deepEqual(claims.acl, { paths: { "/session/**": {} } });
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
});

test("a token lifetime is clamped and an unknown role is refused", () => {
  const long = mintConnectionToken(projectAuth, { sessionId: "s".repeat(40), role: "subscriber", ttlSeconds: 86_400, now: 0 });
  assert.equal(Number(claimsOf(long.token).exp), TOKEN_MAX_TTL_SECONDS);

  assert.throws(
    () => mintConnectionToken(projectAuth, { sessionId: "s".repeat(40), role: "superuser" as never }),
    (error: unknown) => error instanceof LiveMediaError,
  );
});

test("the REST JWT is short lived and account scoped", () => {
  const claims = claimsOf(apiJwt(projectAuth, 1_000_000));
  assert.equal(claims.iss, "47110815");
  assert.equal(claims.ist, "project");
  assert.ok(Number(claims.exp) - Number(claims.iat) <= 300, "a project JWT may not outlive five minutes");
});

// --- Session creation --------------------------------------------------------

test("a created session is routed, unarchived and authorized per credential mode", async () => {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    return new Response(JSON.stringify([{ session_id: "2_MX4".padEnd(40, "a") }]), { status: 200 });
  }) as unknown as typeof fetch;

  const projectSession = await createVideoSession(projectAuth, { fetchImpl });
  assert.equal(projectSession.length, 40);
  assert.equal(seen[0].url, "https://api.opentok.com/session/create");
  assert.ok(seen[0].headers["X-OPENTOK-AUTH"], "project mode authenticates with X-OPENTOK-AUTH");
  assert.match(seen[0].body, /archiveMode=manual/, "a room never records by default");
  assert.match(seen[0].body, /p2p.preference=disabled/);

  await createVideoSession(applicationAuth, { fetchImpl });
  assert.equal(seen[1].url, "https://video.api.vonage.com/session/create");
  assert.match(seen[1].headers.Authorization, /^Bearer /);
});

test("upstream failures become typed errors that carry no upstream detail", async () => {
  const rejecting = (status: number, body = "secret=leaked") =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  await assert.rejects(
    createVideoSession(projectAuth, { fetchImpl: rejecting(403) }),
    (error: unknown) => {
      assert.ok(error instanceof LiveMediaError);
      assert.equal(error.code, "LIVE_UNAUTHORIZED");
      assert.doesNotMatch(error.safeMessage, /leaked|opentok|vonage\.com/i);
      return true;
    },
  );

  await assert.rejects(
    createVideoSession(projectAuth, { fetchImpl: rejecting(500) }),
    (error: unknown) => error instanceof LiveMediaError && error.code === "LIVE_UPSTREAM_ERROR",
  );

  await assert.rejects(
    createVideoSession(projectAuth, { fetchImpl: (async () => new Response("<html/>", { status: 200 })) as unknown as typeof fetch }),
    (error: unknown) => error instanceof LiveMediaError && error.code === "LIVE_INVALID_RESPONSE",
  );

  const unreachable = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
  await assert.rejects(
    createVideoSession(projectAuth, { fetchImpl: unreachable }),
    (error: unknown) => error instanceof LiveMediaError && error.code === "LIVE_UNREACHABLE",
  );
});

test("only the documented session response shape is accepted", () => {
  assert.equal(parseSessionId(JSON.stringify([{ session_id: "x".repeat(40) }])), "x".repeat(40));
  assert.equal(parseSessionId(JSON.stringify([{ session_id: "short" }])), null);
  assert.equal(parseSessionId(JSON.stringify({ session_id: "x".repeat(40) })), null);
  assert.equal(parseSessionId("[]"), null);
  assert.equal(parseSessionId("not json"), null);
});
