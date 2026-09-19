import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DirectorAuditLog,
  MAX_AUDIT_ENTRIES_PER_SESSION,
} from "../src/core/directorAudit";
import {
  InMemoryDirectorRecordingStore,
  MAX_RECORDING_BYTES,
  resolveDirectorStorageConfig,
  SupabaseDirectorRecordingStore,
} from "../apps/server/directorRecordings";

function logAt(now: { value: number }) {
  return new DirectorAuditLog(() => new Date(now.value));
}

test("a direction is recorded with who asked, what was sent, and when", () => {
  const now = { value: 1_000 };
  const log = logAt(now);
  const entry = log.record({
    kind: "direction_sent",
    promptVersion: 2,
    body: "Cut to the lighthouse.",
    authorId: "author-1",
    proposalId: "proposal-1",
  });
  assert.equal(entry.at, new Date(1_000).toISOString());
  assert.equal(entry.body, "Cut to the lighthouse.");
  assert.deepEqual(log.directions().length, 1);
});

test("an outcome is resolved by prompt version", () => {
  const now = { value: 0 };
  const log = logAt(now);
  log.record({ kind: "direction_sent", promptVersion: 2, body: "A." });
  log.record({ kind: "direction_sent", promptVersion: 3, body: "B." });
  // Pending is a real state: a direction takes effect at the next chunk.
  assert.equal(log.outcomeOf(2), "pending");

  log.record({ kind: "direction_applied", promptVersion: 2 });
  log.record({ kind: "direction_rejected", promptVersion: 3 });
  assert.equal(log.outcomeOf(2), "applied");
  assert.equal(log.outcomeOf(3), "rejected");
  assert.equal(log.outcomeOf(99), "pending");
});

test("the latest verdict for a version wins", () => {
  const now = { value: 0 };
  const log = logAt(now);
  log.record({ kind: "direction_sent", promptVersion: 2, body: "A." });
  log.record({ kind: "direction_rejected", promptVersion: 2 });
  log.record({ kind: "direction_applied", promptVersion: 2 });
  assert.equal(log.outcomeOf(2), "applied");
});

test("the log is bounded and says how much it dropped", () => {
  const now = { value: 0 };
  const log = logAt(now);
  for (let index = 0; index < MAX_AUDIT_ENTRIES_PER_SESSION + 25; index += 1) {
    log.record({ kind: "chunk_received", chunkIndex: index });
  }
  assert.equal(log.all().length, MAX_AUDIT_ENTRIES_PER_SESSION);
  // A truncated log that does not admit truncation is a misleading one.
  assert.equal(log.droppedCount, 25);
  assert.equal(log.all()[0].chunkIndex, 25);
});

test("entries keep insertion order", () => {
  const now = { value: 0 };
  const log = logAt(now);
  log.record({ kind: "session_opened" });
  now.value = 5;
  log.record({ kind: "direction_sent", promptVersion: 2, body: "A." });
  now.value = 9;
  log.record({ kind: "session_closed" });
  assert.deepEqual(
    log.all().map((entry) => entry.kind),
    ["session_opened", "direction_sent", "session_closed"],
  );
});

test("a recording is stored and read back", async () => {
  const store = new InMemoryDirectorRecordingStore(() => new Date(0));
  assert.equal(store.durable, false);
  assert.equal(await store.get("jam", "session"), null);

  await store.save("jam", "session", Buffer.from("bytes"), "video/webm");
  const stored = await store.get("jam", "session");
  assert.equal(stored?.contentType, "video/webm");
  assert.equal(stored?.bytes.toString(), "bytes");
});

test("an oversized recording is refused rather than stored", async () => {
  const store = new InMemoryDirectorRecordingStore();
  const huge = Buffer.alloc(MAX_RECORDING_BYTES + 1);
  await assert.rejects(() => store.save("jam", "session", huge, "video/webm"));
  assert.equal(await store.get("jam", "session"), null);
});

test("the in-memory store is bounded", async () => {
  const store = new InMemoryDirectorRecordingStore();
  for (let index = 0; index < 12; index += 1) {
    await store.save("jam", `session-${index}`, Buffer.from(`${index}`), "video/webm");
  }
  // The oldest were evicted; the newest survive.
  assert.equal(await store.get("jam", "session-0"), null);
  assert.equal((await store.get("jam", "session-11"))?.bytes.toString(), "11");
});

/**
 * The cases below are written against what a real Supabase Storage answered
 * (local stack, 2026-09-19), not against what its API reference implies. Each
 * one failed before the fix.
 */

function fakeStorage(objects: Map<string, string>) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const key = new URL(String(url)).pathname;
    if ((init?.method ?? "GET") === "POST") {
      // The body is a Uint8Array; stringifying it would store the comma-joined
      // byte values rather than the bytes.
      objects.set(key, Buffer.from(init?.body as Uint8Array).toString());
      return new Response("{}", { status: 200 });
    }
    const found = objects.get(key);
    if (found === undefined) {
      // Storage answers a missing object with HTTP 400 carrying a 404 body.
      return new Response(JSON.stringify({ statusCode: "404", error: "not_found" }), {
        status: 400,
      });
    }
    return new Response(found, { status: 200, headers: { "content-type": "video/mp4" } });
  };
}

test("a missing archive reads as absent, not as a store outage", async () => {
  const store = new SupabaseDirectorRecordingStore(
    { url: "http://storage.test", serviceRoleKey: "key", bucket: "jam-director" },
    { fetchImpl: fakeStorage(new Map()) },
  );
  // Storage replies 400, not 404. Reporting that as an outage would tell a room
  // its archive service is down when the session simply has no recording.
  assert.equal(await store.get("jam", "session"), null);
});

test("the stored key follows the container, and is found again without being told it", async () => {
  const objects = new Map<string, string>();
  const store = new SupabaseDirectorRecordingStore(
    { url: "http://storage.test", serviceRoleKey: "key", bucket: "jam-director" },
    { fetchImpl: fakeStorage(objects) },
  );
  await store.save("jam", "session", Buffer.from("fmp4"), "video/mp4");
  assert.ok(
    [...objects.keys()].some((key) => key.endsWith("/jam/session.mp4")),
    "an fMP4 archive must not be stored under a .webm key",
  );
  assert.equal((await store.get("jam", "session"))?.bytes.toString(), "fmp4");
});

test("the director archive gets its own bucket, not the portion bucket", () => {
  const env = {
    SUPABASE_URL: "http://storage.test",
    SUPABASE_SERVICE_ROLE_KEY: "key",
  } as NodeJS.ProcessEnv;
  // jam-portions allows video/mp4 only and caps objects at 64MB, so it rejected
  // every director upload it was given.
  assert.equal(resolveDirectorStorageConfig(env)?.bucket, "jam-director");
  assert.equal(
    resolveDirectorStorageConfig({ ...env, REVERIE_DIRECTOR_BUCKET: "other-bucket" })?.bucket,
    "other-bucket",
  );
});
