import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import type { Jam } from "../src/core/jam";
import { InMemoryJamStore } from "../apps/server/jams";
import { InMemoryDirectorIndexStore } from "../apps/server/directorIndex";
import { InMemoryDirectorRecordingStore } from "../apps/server/directorRecordings";
import { DirectorArchiveSink } from "../apps/server/directorArchive";
import { DirectorAuditLog } from "../src/core/directorAudit";
import { createDirectorArchiveRouter } from "../apps/server/directorArchiveRoutes";
import { buildScript } from "./helpers";

const store = new InMemoryJamStore();
let server: Server;
let baseUrl: string;
let index: InMemoryDirectorIndexStore;
let recordings: InMemoryDirectorRecordingStore;

function buildJam(): Jam {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    format: { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 },
    script: buildScript(5, 2, 2),
    lifecycle: "live" as const,
  };
}

/** A sink wired to the in-memory stores, as the segmenter would drive it. */
function buildSink(jamId: string, sessionId: string) {
  return new DirectorArchiveSink({ jamId, sessionId, recordings, index, container: "mp4" });
}

before(async () => {
  index = new InMemoryDirectorIndexStore();
  recordings = new InMemoryDirectorRecordingStore();
  const app = express();
  app.use(createDirectorArchiveRouter(store, { index, recordings }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(() => {
  server.close();
});

test("a segment is indexed only after its bytes are stored", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const sessionId = "sess-ordered";
  await index.openSession({ id: sessionId, jamId: jam.id, configurationKey: "480p" });

  const sink = buildSink(jam.id, sessionId);
  sink.init(Buffer.from("init"), "avc1.42e01f");
  sink.segment(0, Buffer.from("aaaa"), 0, 2);
  sink.segment(1, Buffer.from("bbbb"), 2, 2);
  await sink.drained();

  const segments = await index.listSegments(sessionId);
  assert.deepEqual(segments.map((segment) => segment.segmentIndex), [0, 1]);
  // Every indexed segment must be fetchable; a playlist built from these rows
  // can then never point at an object that is not there.
  for (const segment of segments) {
    assert.ok(await recordings.getObject(segment.objectPath), segment.objectPath);
  }
  assert.equal((await index.getSession(sessionId))?.codec, "avc1.42e01f");
});

test("a segment whose upload fails leaves no row behind", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const sessionId = "sess-failing";
  await index.openSession({ id: sessionId, jamId: jam.id, configurationKey: "480p" });

  const failing = new InMemoryDirectorRecordingStore();
  failing.putObject = async () => {
    throw new Error("storage refused");
  };
  const sink = new DirectorArchiveSink({
    jamId: jam.id,
    sessionId,
    recordings: failing,
    index,
    container: "mp4",
  });
  sink.segment(0, Buffer.from("aaaa"), 0, 2);
  await sink.drained();

  // Recorded as lost rather than indexed: an archive is allowed to be short,
  // never to claim a segment it does not hold.
  assert.equal(sink.lostSegments, 1);
  assert.deepEqual(await index.listSegments(sessionId), []);
});

test("one failed segment does not stop the ones after it", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const sessionId = "sess-partial";
  await index.openSession({ id: sessionId, jamId: jam.id, configurationKey: "480p" });

  let calls = 0;
  const flaky = new InMemoryDirectorRecordingStore();
  const put = flaky.putObject.bind(flaky);
  flaky.putObject = async (path, bytes, contentType) => {
    calls += 1;
    if (calls === 1) throw new Error("storage refused");
    return put(path, bytes, contentType);
  };
  const sink = new DirectorArchiveSink({
    jamId: jam.id,
    sessionId,
    recordings: flaky,
    index,
    container: "mp4",
  });
  sink.segment(0, Buffer.from("aaaa"), 0, 2);
  sink.segment(1, Buffer.from("bbbb"), 2, 2);
  await sink.drained();

  assert.deepEqual((await index.listSegments(sessionId)).map((s) => s.segmentIndex), [1]);
});

test("a session that never finishes is reported as incomplete, with what survived", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const sessionId = "sess-crashed";
  await index.openSession({ id: sessionId, jamId: jam.id, configurationKey: "480p" });
  const sink = buildSink(jam.id, sessionId);
  sink.segment(0, Buffer.from("aaaa"), 0, 2);
  await sink.drained();
  // finish() is never called: the segmenter delivers it fire-and-forget, so a
  // process that dies mid-stream never runs it.

  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/archive/${sessionId}`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.session.complete, false);
  assert.equal(body.segments.length, 1);
  assert.equal(body.durationSeconds, 2);
});

test("the archive lists a jam's sessions and refuses another jam's", async () => {
  const jam = buildJam();
  const other = buildJam();
  await store.createJam(jam);
  await store.createJam(other);
  await index.openSession({ id: "sess-listed", jamId: jam.id, configurationKey: "480p" });

  const listed = await fetch(`${baseUrl}/api/jams/${jam.id}/director/archive`);
  const body = await listed.json();
  assert.ok(body.sessions.some((session: { id: string }) => session.id === "sess-listed"));
  // Honest about what it served: these stores are in-memory.
  assert.equal(body.durable, false);

  // A session id is not a capability: it must belong to the jam in the path.
  const crossed = await fetch(
    `${baseUrl}/api/jams/${other.id}/director/archive/sess-listed`,
  );
  assert.equal(crossed.status, 404);
});

test("the audit trail is served for an archived session", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  await index.openSession({ id: "sess-audit", jamId: jam.id, configurationKey: "480p" });
  await index.recordAudit("sess-audit", {
    at: new Date(0).toISOString(),
    kind: "direction_sent",
    body: "Cut to the lighthouse.",
    authorId: "author-1",
    beatIndex: 3,
  });

  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/archive/sess-audit/audit`,
  );
  const body = await response.json();
  assert.equal(body.audit.length, 1);
  assert.equal(body.audit[0].body, "Cut to the lighthouse.");
});

test("archived bytes are served by this server, not by a storage URL", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const sessionId = "sess-media";
  await index.openSession({ id: sessionId, jamId: jam.id, configurationKey: "480p" });
  const sink = buildSink(jam.id, sessionId);
  sink.segment(0, Buffer.from("segment-bytes"), 0, 2);
  await sink.drained();

  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/archive/${sessionId}/media/0.m4s`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(await response.text(), "segment-bytes");

  const missing = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/archive/${sessionId}/media/99.m4s`,
  );
  assert.equal(missing.status, 404);
});

test("a finished session is served as one playable file", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const sessionId = "sess-video";
  await index.openSession({ id: sessionId, jamId: jam.id, configurationKey: "480p" });
  const sink = buildSink(jam.id, sessionId);
  sink.init(Buffer.from("INIT"), "avc1.42e01f");
  sink.segment(0, Buffer.from("AAAA"), 0, 2);
  sink.segment(1, Buffer.from("BBBB"), 2, 2);
  await sink.drained();

  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/archive/${sessionId}/video`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  // fMP4 is the init segment followed by its media segments, so the
  // concatenation is the file: a plain <video> element can play it.
  assert.equal(await response.text(), "INITAAAABBBB");
});

test("an archive with no init segment is refused, not served unplayable", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const sessionId = "sess-noinit";
  await index.openSession({ id: sessionId, jamId: jam.id, configurationKey: "480p" });
  const sink = buildSink(jam.id, sessionId);
  // Segments without the init segment cannot be decoded by anything.
  sink.segment(0, Buffer.from("AAAA"), 0, 2);
  await sink.drained();

  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/archive/${sessionId}/video`,
  );
  assert.equal(response.status, 404);
});

test("a session that stored nothing has no video to play", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  await index.openSession({ id: "sess-empty", jamId: jam.id, configurationKey: "480p" });
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/archive/sess-empty/video`,
  );
  assert.equal(response.status, 404);
});

test("a direction reaches the durable audit as it is sent, not at the end", async () => {
  const log = new DirectorAuditLog(
    () => new Date(0),
    (entry) => {
      void index.recordAudit("sess-live-audit", entry);
    },
  );
  const jam = buildJam();
  await store.createJam(jam);
  await index.openSession({
    id: "sess-live-audit",
    jamId: jam.id,
    configurationKey: "480p",
  });

  log.record({ kind: "session_opened" });
  log.record({
    kind: "direction_sent",
    promptVersion: 1,
    body: "Cut to the lighthouse.",
    authorId: "author-1",
    beatIndex: 2,
    scriptOffsetSeconds: 4.5,
  });

  // Written as they happen: a process that dies here still has both, which is
  // the whole reason the trail is not flushed at close.
  const stored = await index.listAudit("sess-live-audit");
  assert.deepEqual(stored.map((entry) => entry.kind), ["session_opened", "direction_sent"]);
  assert.equal(stored[1].body, "Cut to the lighthouse.");
  assert.equal(stored[1].beatIndex, 2);
});

test("a durable audit that fails does not disturb the live trail", async () => {
  const log = new DirectorAuditLog(
    () => new Date(0),
    () => {
      throw new Error("the index is unreachable");
    },
  );
  log.record({ kind: "session_opened" });
  // The stream keeps its own account of itself even when nothing can store it.
  assert.deepEqual(log.all().map((entry) => entry.kind), ["session_opened"]);
});

test("a WebM archive stores its pieces under WebM keys and types", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const sessionId = "sess-webm";
  await index.openSession({ id: sessionId, jamId: jam.id, configurationKey: "480p" });
  const sink = new DirectorArchiveSink({
    jamId: jam.id,
    sessionId,
    recordings,
    index,
    container: "webm",
  });
  sink.init(Buffer.from("EBML"), "vp8");
  sink.segment(0, Buffer.from("CLUSTER0"), 0, 10);
  await sink.drained();

  const session = await index.getSession(sessionId);
  assert.equal(session?.container, "webm");
  assert.equal(session?.codec, "vp8");
  const [piece] = await index.listSegments(sessionId);
  assert.ok(piece.objectPath.endsWith("/0.webm"), piece.objectPath);
  assert.equal((await recordings.getObject(`${jam.id}/${sessionId}/init.webm`))?.contentType, "video/webm");
});

test("one piece is served playable on its own, header prepended, for seeking", async () => {
  const jam = buildJam();
  await store.createJam(jam);
  const sessionId = "sess-seek";
  await index.openSession({ id: sessionId, jamId: jam.id, configurationKey: "480p" });
  const sink = new DirectorArchiveSink({
    jamId: jam.id,
    sessionId,
    recordings,
    index,
    container: "webm",
  });
  sink.init(Buffer.from("EBML"), "vp8");
  sink.segment(0, Buffer.from("AAAA"), 0, 10);
  sink.segment(1, Buffer.from("BBBB"), 10, 10);
  await sink.drained();

  // Going to 0:10 means fetching piece 1 — not everything before it.
  const response = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/archive/${sessionId}/pieces/1`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/webm");
  assert.equal(response.headers.get("x-piece-start-seconds"), "10");
  assert.equal(response.headers.get("x-piece-duration-seconds"), "10");
  // A piece decodes from its first frame only with the initial header in front.
  assert.equal(await response.text(), "EBMLBBBB");

  const whole = await fetch(`${baseUrl}/api/jams/${jam.id}/director/archive/${sessionId}/video`);
  assert.equal(whole.headers.get("content-type"), "video/webm");
  assert.equal(await whole.text(), "EBMLAAAABBBB");

  const missing = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/archive/${sessionId}/pieces/7`,
  );
  assert.equal(missing.status, 404);
  const invalid = await fetch(
    `${baseUrl}/api/jams/${jam.id}/director/archive/${sessionId}/pieces/nope`,
  );
  assert.equal(invalid.status, 400);
});
