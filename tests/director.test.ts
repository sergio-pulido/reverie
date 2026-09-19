import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildConfigureMessage,
  buildDirectorScript,
  DIRECTOR_MAX_CHUNK_SECONDS,
  DIRECTOR_MAX_SCRIPT_BEATS,
  DIRECTOR_MIN_CHUNK_SECONDS,
  directorOfferSchema,
  resolveDirectorConfig,
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
  assert.equal((message.script as unknown[]).length, 4);
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
