import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createJamScriptSchema,
  DEFAULT_SCRIPT_FORMAT,
  hardPortionBounds,
  jamScriptSchema,
  scriptFormatSchema,
  totalDurationSeconds,
} from "../src/core/script";
import { buildDefaultFormatScript, buildScript } from "./helpers";

const defaultSchema = createJamScriptSchema(DEFAULT_SCRIPT_FORMAT);

test("accepts a 20-second script made of 5-second portions", () => {
  const script = buildDefaultFormatScript();
  assert.equal(totalDurationSeconds(script), 20);
  assert.ok(defaultSchema.safeParse(script).success);
});

test("rejects a script far from the format's target", () => {
  const script = buildScript(5, 4, 4); // 16 × 5s = 80s, not 20s
  assert.equal(defaultSchema.safeParse(script).success, false);
});

test("rejects portions outside the format's hard duration bounds", () => {
  const script = buildDefaultFormatScript();
  script.scenes[0].portions[0].durationSeconds = 12;
  assert.equal(defaultSchema.safeParse(script).success, false);
});

test("structural schema accepts scripts from any format", () => {
  const script = buildScript(12); // off the default target on purpose
  assert.ok(jamScriptSchema.safeParse(script).success);
});

test("structural schema still refuses a portion the model cannot render", () => {
  const tooShort = buildScript(12);
  tooShort.scenes[0].portions[0].durationSeconds = 4;
  assert.equal(jamScriptSchema.safeParse(tooShort).success, false);
  const tooLong = buildScript(12);
  tooLong.scenes[0].portions[0].durationSeconds = 16;
  assert.equal(jamScriptSchema.safeParse(tooLong).success, false);
});

test("format defaults to 20 seconds of 5-second portions", () => {
  const format = scriptFormatSchema.parse({});
  assert.deepEqual(format, {
    totalSeconds: 20,
    portionMinSeconds: 5,
    portionMaxSeconds: 5,
  });
});

test("format accepts partial overrides", () => {
  const format = scriptFormatSchema.parse({ totalSeconds: 60 });
  assert.equal(format.totalSeconds, 60);
  assert.equal(format.portionMinSeconds, 5);
});

test("format rejects a minimum portion above the maximum", () => {
  const result = scriptFormatSchema.safeParse({
    portionMinSeconds: 12,
    portionMaxSeconds: 8,
  });
  assert.equal(result.success, false);
});

test("format refuses a portion band outside what the model can render", () => {
  assert.equal(scriptFormatSchema.safeParse({ portionMinSeconds: 4 }).success, false);
  assert.equal(scriptFormatSchema.safeParse({ portionMaxSeconds: 16 }).success, false);
});

test("format rejects out-of-range totals", () => {
  assert.equal(scriptFormatSchema.safeParse({ totalSeconds: 5 }).success, false);
  assert.equal(scriptFormatSchema.safeParse({ totalSeconds: 3600 }).success, false);
  // 720s is MAX_PORTIONS × the longest renderable portion, so it is the ceiling.
  assert.equal(scriptFormatSchema.safeParse({ totalSeconds: 721 }).success, false);
});

test("format accepts a tiny 20-second test jam of 5-second portions", () => {
  const format = scriptFormatSchema.parse({
    totalSeconds: 20,
    portionMinSeconds: 5,
    portionMaxSeconds: 5,
  });
  assert.equal(format.totalSeconds, 20);
  assert.equal(scriptFormatSchema.safeParse({ totalSeconds: 8 }).success, false);
});

test("format rejects combinations needing more than 48 portions", () => {
  // 600s of 5s portions could need 120 portions.
  const result = scriptFormatSchema.safeParse({
    totalSeconds: 600,
    portionMinSeconds: 5,
    portionMaxSeconds: 15,
  });
  assert.equal(result.success, false);
  // 720s of 15s portions is exactly 48.
  assert.ok(
    scriptFormatSchema.safeParse({
      totalSeconds: 720,
      portionMinSeconds: 15,
      portionMaxSeconds: 15,
    }).success,
  );
});

test("a custom format validates scripts against its own target", () => {
  const format = scriptFormatSchema.parse({
    totalSeconds: 240,
    portionMinSeconds: 12,
    portionMaxSeconds: 15,
  });
  const schema = createJamScriptSchema(format);
  const script = buildScript(15, 4, 4); // 16 × 15s = 240s
  assert.ok(schema.safeParse(script).success);
  assert.equal(schema.safeParse(buildDefaultFormatScript()).success, false);
});

test("hard bounds never widen past the model band", () => {
  const format = scriptFormatSchema.parse({
    totalSeconds: 240,
    portionMinSeconds: 5,
    portionMaxSeconds: 15,
  });
  // Slack would give 3s..17s; the model band clamps it back to 5s..15s.
  assert.deepEqual(hardPortionBounds(format), { min: 5, max: 15 });
});
