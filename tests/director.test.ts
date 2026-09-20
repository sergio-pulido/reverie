import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildConfigureMessage,
  buildDirectorScript,
  DIRECTOR_MAX_CHUNK_SECONDS,
  DIRECTOR_MAX_SCRIPT_BEATS,
  DIRECTOR_MIN_CHUNK_SECONDS,
  directorOfferSchema,
  DirectorError,
  resolveDirectorConfig,
  startDirectorSession,
} from "../apps/server/providers/falDirector";
import {
  PORTION_ABSOLUTE_MAX_SECONDS,
  PORTION_ABSOLUTE_MIN_SECONDS,
} from "../src/core/script";
import { buildScript } from "./helpers";

const LIVE = {
  REVERIE_LIVE_ENABLED: "true",
  REVERIE_DIRECTOR_ENABLED: "true",
  FAL_KEY: "k",
} as NodeJS.ProcessEnv;

test("Director needs its own flag on top of the live flag", () => {
  assert.equal(resolveDirectorConfig({ ...LIVE, REVERIE_DIRECTOR_ENABLED: undefined }), null);
  assert.equal(resolveDirectorConfig({ ...LIVE, REVERIE_LIVE_ENABLED: undefined }), null);
  assert.equal(resolveDirectorConfig({ ...LIVE, FAL_KEY: undefined }), null);
  assert.equal(resolveDirectorConfig(LIVE)?.apiKey, "k");
});

test("resolution and aspect ratio fall back rather than fail", () => {
  assert.equal(resolveDirectorConfig(LIVE)?.resolution, "768p");
  assert.equal(resolveDirectorConfig(LIVE)?.aspectRatio, "16:9");
  assert.equal(
    resolveDirectorConfig({ ...LIVE, REVERIE_DIRECTOR_RESOLUTION: "480p" })?.resolution,
    "480p",
  );
  // 4K is not one of Director's three resolutions.
  assert.equal(
    resolveDirectorConfig({ ...LIVE, REVERIE_DIRECTOR_RESOLUTION: "4K" })?.resolution,
    "768p",
  );
});

test("Director's chunk band is the portion band", () => {
  assert.equal(DIRECTOR_MIN_CHUNK_SECONDS, PORTION_ABSOLUTE_MIN_SECONDS);
  assert.equal(DIRECTOR_MAX_CHUNK_SECONDS, PORTION_ABSOLUTE_MAX_SECONDS);
});

test("portions become beats at their cumulative offset", () => {
  const beats = buildDirectorScript(buildScript(5, 2, 2));
  assert.deepEqual(
    beats.map((beat) => beat.offset),
    [0, 5, 10, 15],
  );
  // Every beat carries its portion's direction, visual first.
  assert.match(beats[0].prompt, /Slow push in\./);
  assert.match(beats[0].prompt, /Scene 1, portion 1 action\./);
  assert.match(beats[0].prompt, /Someone speaks\./);
  // A portion without dialogue simply omits it.
  assert.doesNotMatch(beats[1].prompt, /Someone speaks\./);
});

test("offsets follow uneven portion lengths", () => {
  const script = buildScript(5, 1, 3);
  script.scenes[0].portions[0].durationSeconds = 12;
  script.scenes[0].portions[1].durationSeconds = 7;
  assert.deepEqual(
    buildDirectorScript(script).map((beat) => beat.offset),
    [0, 12, 19],
  );
});

test("a long script is truncated to the beat cap, not rejected", () => {
  const beats = buildDirectorScript(buildScript(5, 20, 4)); // 80 portions
  assert.equal(beats.length, DIRECTOR_MAX_SCRIPT_BEATS);
  assert.equal(beats[0].offset, 0);
});

test("the configure message pins the premise, framing and protocol", () => {
  const config = resolveDirectorConfig(LIVE)!;
  const message = buildConfigureMessage(config, buildScript(5, 2, 2));
  assert.equal(message.type, "configure");
  assert.equal(message.protocol_version, 1);
  assert.equal(message.prompt_version, 1);
  assert.equal(message.resolution, "768p");
  assert.equal(message.aspect_ratio, "16:9");
  assert.equal(message.memory, 12);
  assert.match(String(message.prompt), /The Salt Door/);
  // Only the opening chunk's beats: 0s, 5s and 10s of a 20s film. What fal is
  // given it has planned from, and can never be asked to unplan.
  assert.deepEqual(
    (message.script as { offset: number }[]).map((beat) => beat.offset),
    [0, 5, 10],
  );
});

test("the configure window is the caller's, so a shorter chunk hands over less", () => {
  const config = resolveDirectorConfig(LIVE)!;
  const script = buildScript(5, 2, 2);
  assert.deepEqual(
    (buildConfigureMessage(config, script, { throughSeconds: 5 }).script as { offset: number }[])
      .map((beat) => beat.offset),
    [0],
  );
});

test("the script can be sliced to a window, which is how later beats are handed over", () => {
  const script = buildScript(5, 2, 2);
  assert.deepEqual(
    buildDirectorScript(script, { fromSeconds: 5, toSeconds: 15 }).map((beat) => beat.offset),
    [5, 10],
  );
  // Past the end is empty rather than an error: a stream runs on past the last
  // beat, directed live.
  assert.deepEqual(buildDirectorScript(script, { fromSeconds: 20 }), []);
});

test("memory is clamped to what Director accepts", () => {
  const config = resolveDirectorConfig(LIVE)!;
  const script = buildScript(5, 2, 2);
  assert.equal(buildConfigureMessage(config, script, { memory: 0 }).memory, 1);
  assert.equal(buildConfigureMessage(config, script, { memory: 999 }).memory, 50);
});

test("the offer schema accepts an SDP and refuses anything else", () => {
  assert.ok(directorOfferSchema.safeParse({ sdp: "v=0\r\n" }).success);
  assert.equal(directorOfferSchema.safeParse({ sdp: "" }).success, false);
  assert.equal(directorOfferSchema.safeParse({}).success, false);
  assert.equal(
    directorOfferSchema.safeParse({ sdp: "v=0", type: "answer" }).success,
    false,
  );
  // Bounded: an unbounded SDP is a memory cost with no upside.
  assert.equal(
    directorOfferSchema.safeParse({ sdp: "x".repeat(64_001) }).success,
    false,
  );
});

/** A Response carrying an SSE body, as fal's /start-session actually answers. */
function eventStream(frames: string[], contentType = "text/event-stream; charset=utf-8") {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

const CONFIG = {
  apiKey: "k",
  resolution: "768p",
  aspectRatio: "16:9",
  record: false,
} as const;

test("the answer is read from the event stream fal actually returns", async () => {
  // This is the bug that made a real session fail: the endpoint answers
  // text/event-stream, and parsing it as JSON yields nothing.
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    eventStream([`data: ${JSON.stringify({ sdp: "v=0\r\nanswer\r\n" })}\n\n`])) as typeof fetch;
  try {
    const sdp = await startDirectorSession(CONFIG, { type: "offer", sdp: "v=0\r\n" });
    assert.match(sdp, /^v=0/);
  } finally {
    globalThis.fetch = original;
  }
});

test("frames split across chunks are reassembled", async () => {
  const payload = `data: ${JSON.stringify({ sdp: "v=0\r\nsplit\r\n" })}\n\n`;
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    eventStream([payload.slice(0, 12), payload.slice(12)])) as typeof fetch;
  try {
    const sdp = await startDirectorSession(CONFIG, { type: "offer", sdp: "v=0\r\n" });
    assert.match(sdp, /split/);
  } finally {
    globalThis.fetch = original;
  }
});

test("frames before the answer are skipped, not treated as failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    eventStream([
      ": keep-alive comment\n\n",
      `data: ${JSON.stringify({ status: "starting" })}\n\n`,
      `data: ${JSON.stringify({ sdp: "v=0\r\nlater\r\n" })}\n\n`,
    ])) as typeof fetch;
  try {
    const sdp = await startDirectorSession(CONFIG, { type: "offer", sdp: "v=0\r\n" });
    assert.match(sdp, /later/);
  } finally {
    globalThis.fetch = original;
  }
});

test("a plain JSON answer still works", async () => {
  // The endpoint's OpenAPI declares a JSON response, so both are accepted.
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ answer: { sdp: "v=0\r\njson\r\n" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const sdp = await startDirectorSession(CONFIG, { type: "offer", sdp: "v=0\r\n" });
    assert.match(sdp, /json/);
  } finally {
    globalThis.fetch = original;
  }
});

test("a stream that never carries an answer fails as retryable", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    eventStream([`data: ${JSON.stringify({ status: "starting" })}\n\n`])) as typeof fetch;
  try {
    await assert.rejects(
      () => startDirectorSession(CONFIG, { type: "offer", sdp: "v=0\r\n" }),
      (error: unknown) => error instanceof DirectorError && error.retryable,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("recording is off unless asked for, because it blocks the event loop", () => {
  // Measured, not cautious: capturing 480p/24fps pinned the Node process at
  // 99% CPU and stopped the server answering, including the route that ends
  // the paid session. It stays opt-in until capture runs off-thread.
  assert.equal(resolveDirectorConfig(LIVE)?.record, false);
  assert.equal(
    resolveDirectorConfig({ ...LIVE, REVERIE_DIRECTOR_RECORD: "true" })?.record,
    true,
  );
  assert.equal(
    resolveDirectorConfig({ ...LIVE, REVERIE_DIRECTOR_RECORD: "TRUE" })?.record,
    false,
  );
});
