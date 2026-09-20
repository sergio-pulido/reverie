import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import directorArchive from "../api/jams/[id]/director/archive/[[...path]]";

/**
 * The deployed archive routes.
 *
 * Every read below goes to Supabase with the caller's own access token, so
 * these tests stand in for PostgREST and Storage rather than for a store: what
 * is being checked is that the function asks the right questions, refuses the
 * wrong callers, and serves bytes it never buffers.
 */

const JAM_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_JAM = "10000000-0000-4000-8000-0000000000ff";
// The shape apps/server/directorSessions.ts actually mints: not a UUID.
const SESSION_ID = "mu9lukum-3";
const USER_ID = "20000000-0000-4000-8000-000000000002";
const TOKEN = "header.payload.signature";

const env = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-for-tests",
} as NodeJS.ProcessEnv;

function request(path: string, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  stream.method = "GET";
  stream.url = path;
  stream.headers = { host: "reverie.test", ...headers };
  Object.defineProperty(stream, "socket", {
    value: { remoteAddress: `10.0.0.${Math.floor(Math.random() * 250) + 1}` },
  });
  return stream;
}

type Captured = { statusCode: number; headers: Record<string, string>; body: Buffer };

/** A real writable, because the routes that serve media pipe into it. */
function responseCapture(): { response: ServerResponse; captured: Captured } {
  const chunks: Buffer[] = [];
  const captured: Captured = { statusCode: 0, headers: {}, body: Buffer.alloc(0) };
  const writable = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  const response = writable as unknown as ServerResponse;
  response.statusCode = 200;
  response.setHeader = ((name: string, value: string) => {
    captured.headers[name.toLowerCase()] = String(value);
    return response;
  }) as ServerResponse["setHeader"];
  const end = writable.end.bind(writable);
  response.end = ((payload?: unknown) => {
    if (typeof payload === "string") chunks.push(Buffer.from(payload));
    else if (payload instanceof Buffer) chunks.push(payload);
    captured.statusCode = response.statusCode;
    captured.body = Buffer.concat(chunks);
    return end();
  }) as ServerResponse["end"];
  return { response, captured };
}

function json(captured: Captured): Record<string, unknown> {
  return JSON.parse(captured.body.toString("utf8")) as Record<string, unknown>;
}

type Stubs = {
  status?: string;
  sessionJam?: string;
  sessions?: Record<string, unknown>[];
  segments?: Record<string, unknown>[];
  objects?: Record<string, string>;
};

/** Supabase: Auth, the caller's own membership row, the index, and Storage. */
function supabaseFetch(stubs: Stubs = {}) {
  const calls: { url: string; range?: string }[] = [];
  const objects = stubs.objects ?? {};
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    calls.push({ url: target, ...(range ? { range } : {}) });
    if (target.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: USER_ID }), { status: 200 });
    }
    if (target.includes("/rest/v1/jam_members")) {
      return new Response(
        JSON.stringify([{ role: "member", status: stubs.status ?? "active" }]),
        { status: 200 },
      );
    }
    if (target.includes("/rest/v1/jams?")) {
      return new Response(JSON.stringify([{ status: "completed" }]), { status: 200 });
    }
    if (target.includes("/rest/v1/jam_director_sessions")) {
      const rows = stubs.sessions ?? [
        {
          id: SESSION_ID,
          jam_id: stubs.sessionJam ?? JAM_ID,
          configuration_key: "default",
          script_revision: 4,
          codec: "h264",
          container: "mp4",
          started_at: "2026-09-20T09:00:00Z",
          ended_at: "2026-09-20T09:05:00Z",
          complete: true,
          truncated_reason: null,
        },
      ];
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (target.includes("/rest/v1/jam_director_segments")) {
      const rows = stubs.segments ?? [
        { session_id: SESSION_ID, segment_index: 0, start_seconds: 0, duration_seconds: 4, byte_size: 10, object_path: `${JAM_ID}/${SESSION_ID}/0.m4s` },
        { session_id: SESSION_ID, segment_index: 1, start_seconds: 4, duration_seconds: 2.5, byte_size: 8, object_path: `${JAM_ID}/${SESSION_ID}/1.m4s` },
      ];
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (target.includes("/rest/v1/jam_director_audit")) {
      return new Response(JSON.stringify([{ at: "2026-09-20T09:01:00Z", kind: "direction", body: "closer" }]), { status: 200 });
    }
    if (target.includes("/storage/v1/object/")) {
      const key = target.split("/storage/v1/object/")[1];
      const bytes = objects[key];
      if (bytes === undefined) {
        return new Response(JSON.stringify({ statusCode: "404" }), { status: 400 });
      }
      if (range) {
        return new Response(bytes.slice(0, 2), {
          status: 206,
          headers: { "content-type": "video/mp4", "content-range": `bytes 0-1/${bytes.length}` },
        });
      }
      return new Response(bytes, { status: 200, headers: { "content-type": "video/mp4" } });
    }
    throw new Error(`unexpected call: ${target}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function callArchive(path: string, stubs: Stubs = {}, headers: Record<string, string> = {}) {
  const { fetchImpl, calls } = supabaseFetch(stubs);
  const { response, captured } = responseCapture();
  await directorArchive(
    request(path, { authorization: `Bearer ${TOKEN}`, ...headers }),
    response,
    { env, fetchImpl },
  );
  return { captured, calls };
}

test("an unsigned caller is refused before Supabase is asked anything", async () => {
  const { fetchImpl, calls } = supabaseFetch();
  const { response, captured } = responseCapture();
  await directorArchive(request(`/api/jams/${JAM_ID}/director/archive`), response, { env, fetchImpl });
  assert.equal(captured.statusCode, 401);
  assert.equal(calls.length, 0);
});

test("a participant who is not active is refused", async () => {
  const { captured } = await callArchive(`/api/jams/${JAM_ID}/director/archive`, { status: "removed" });
  assert.equal(captured.statusCode, 403);
});

test("a cross-origin browser call is refused", async () => {
  const { captured } = await callArchive(
    `/api/jams/${JAM_ID}/director/archive`,
    {},
    { origin: "https://elsewhere.test" },
  );
  assert.equal(captured.statusCode, 403);
  assert.equal(json(captured).error && (json(captured).error as Record<string, unknown>).code, "cross_origin_blocked");
});

test("an active member lists the sessions the jam archived", async () => {
  const { captured, calls } = await callArchive(`/api/jams/${JAM_ID}/director/archive`);
  assert.equal(captured.statusCode, 200);
  const body = json(captured);
  assert.equal(body.durable, true);
  assert.equal((body.sessions as unknown[]).length, 1);
  // Read with the caller's token, never a service-role key.
  const indexed = calls.find((call) => call.url.includes("jam_director_sessions"));
  assert.ok(indexed?.url.includes(`jam_id=eq.${JAM_ID}`));
});

test("a session's record sums the duration of the pieces that are actually stored", async () => {
  const { captured } = await callArchive(`/api/jams/${JAM_ID}/director/archive/${SESSION_ID}`);
  assert.equal(captured.statusCode, 200);
  const body = json(captured);
  assert.equal(body.durationSeconds, 6.5);
  assert.equal((body.segments as unknown[]).length, 2);
});

test("a session belonging to another jam is not there, rather than forbidden", async () => {
  const { captured } = await callArchive(
    `/api/jams/${JAM_ID}/director/archive/${SESSION_ID}`,
    { sessionJam: OTHER_JAM },
  );
  assert.equal(captured.statusCode, 404);
});

test("the playlist is a VOD playlist that ends, addressing pieces by time", async () => {
  const { captured } = await callArchive(`/api/jams/${JAM_ID}/director/archive/${SESSION_ID}/playlist.m3u8`);
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.headers["content-type"], "application/vnd.apple.mpegurl");
  const playlist = captured.body.toString("utf8");
  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(playlist, /#EXT-X-MAP:URI="media\/init\.mp4"/);
  assert.match(playlist, /#EXTINF:4\.000,\nmedia\/0\.m4s/);
  assert.match(playlist, /#EXTINF:2\.500,\nmedia\/1\.m4s/);
  assert.match(playlist, /#EXT-X-ENDLIST/);
});

test("a session that stored nothing has no playlist to offer", async () => {
  const { captured } = await callArchive(
    `/api/jams/${JAM_ID}/director/archive/${SESSION_ID}/playlist.m3u8`,
    { segments: [] },
  );
  assert.equal(captured.statusCode, 404);
});

test("a piece is served with the caller's range forwarded to storage", async () => {
  const objects = { [`jam-director/${JAM_ID}/${SESSION_ID}/0.m4s`]: "abcdef" };
  const { fetchImpl, calls } = supabaseFetch({ objects });
  const { response, captured } = responseCapture();
  await directorArchive(
    request(`/api/jams/${JAM_ID}/director/archive/${SESSION_ID}/media/0.m4s`, {
      authorization: `Bearer ${TOKEN}`,
      range: "bytes=0-1",
    }),
    response,
    { env, fetchImpl },
  );
  assert.equal(captured.statusCode, 206);
  assert.equal(captured.headers["content-range"], "bytes 0-1/6");
  assert.equal(captured.headers["accept-ranges"], "bytes");
  assert.equal(captured.body.toString("utf8"), "ab");
  assert.equal(calls.find((call) => call.url.includes("/storage/"))?.range, "bytes=0-1");
});

test("a piece the bucket does not hold is not in the archive", async () => {
  const { captured } = await callArchive(
    `/api/jams/${JAM_ID}/director/archive/${SESSION_ID}/media/7.m4s`,
    { objects: {} },
  );
  assert.equal(captured.statusCode, 404);
});

test("the whole film is the initial header followed by its pieces, in order", async () => {
  const objects = {
    [`jam-director/${JAM_ID}/${SESSION_ID}/init.mp4`]: "INIT",
    [`jam-director/${JAM_ID}/${SESSION_ID}/0.m4s`]: "ONE",
    [`jam-director/${JAM_ID}/${SESSION_ID}/1.m4s`]: "TWO",
  };
  const { captured } = await callArchive(
    `/api/jams/${JAM_ID}/director/archive/${SESSION_ID}/video`,
    { objects },
  );
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.toString("utf8"), "INITONETWO");
  // Seeking belongs to the playlist: a byte offset into a concatenation of
  // separate objects is not an offset into anything that exists.
  assert.equal(captured.headers["accept-ranges"], "none");
});

test("a film whose initial header is missing is refused rather than served unplayable", async () => {
  const { captured } = await callArchive(
    `/api/jams/${JAM_ID}/director/archive/${SESSION_ID}/video`,
    { objects: { [`jam-director/${JAM_ID}/${SESSION_ID}/0.m4s`]: "ONE" } },
  );
  assert.equal(captured.statusCode, 404);
});

test("one piece is served as the header plus that piece, with its place on the clock", async () => {
  const objects = {
    [`jam-director/${JAM_ID}/${SESSION_ID}/init.mp4`]: "INIT",
    [`jam-director/${JAM_ID}/${SESSION_ID}/1.m4s`]: "TWO",
  };
  const { captured } = await callArchive(
    `/api/jams/${JAM_ID}/director/archive/${SESSION_ID}/pieces/1`,
    { objects },
  );
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.toString("utf8"), "INITTWO");
  assert.equal(captured.headers["x-piece-start-seconds"], "4");
  assert.equal(captured.headers["x-piece-duration-seconds"], "2.5");
});

test("the audit trail is read for the session, and nothing else", async () => {
  const { captured, calls } = await callArchive(
    `/api/jams/${JAM_ID}/director/archive/${SESSION_ID}/audit`,
  );
  assert.equal(captured.statusCode, 200);
  assert.equal((json(captured).audit as unknown[]).length, 1);
  assert.ok(calls.some((call) => call.url.includes(`jam_director_audit?session_id=eq.${SESSION_ID}`)));
});

test("a jam id that is not a uuid never reaches a PostgREST filter", async () => {
  const { fetchImpl, calls } = supabaseFetch();
  const { response, captured } = responseCapture();
  await directorArchive(
    request("/api/jams/1%20or%20true/director/archive", { authorization: `Bearer ${TOKEN}` }),
    response,
    { env, fetchImpl },
  );
  assert.equal(captured.statusCode, 404);
  assert.equal(calls.length, 0);
});

test("a session id that is not a uuid is still a session id", async () => {
  // Regression: the ledger mints `<base36 time>-<base36 count>`, so a uuid
  // check here refused every film this repository has ever recorded.
  const { captured } = await callArchive(`/api/jams/${JAM_ID}/director/archive/${SESSION_ID}`);
  assert.equal(captured.statusCode, 200);
});

test("a session id carrying PostgREST syntax is refused before it is a filter", async () => {
  const { fetchImpl, calls } = supabaseFetch();
  const { response, captured } = responseCapture();
  await directorArchive(
    request(`/api/jams/${JAM_ID}/director/archive/sess%2Cid.eq`, { authorization: `Bearer ${TOKEN}` }),
    response,
    { env, fetchImpl },
  );
  assert.equal(captured.statusCode, 404);
  assert.ok(!calls.some((call) => call.url.includes("jam_director_sessions")));
});
