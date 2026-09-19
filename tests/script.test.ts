import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createJamScriptSchema,
  DEFAULT_SCRIPT_FORMAT,
  jamScriptSchema,
  scriptFormatSchema,
  totalDurationSeconds,
} from "../src/core/script";
import { buildScript } from "./helpers";

const defaultSchema = createJamScriptSchema(DEFAULT_SCRIPT_FORMAT);

test("accepts a 4-minute script made of 10-20 second portions", () => {
  const script = buildScript(15);
  assert.equal(totalDurationSeconds(script), 240);
  assert.ok(defaultSchema.safeParse(script).success);
});

test("rejects a script far from the format's target", () => {
  const script = buildScript(12); // 16 × 12s = 192s
  assert.equal(defaultSchema.safeParse(script).success, false);
});

test("rejects portions outside the format's hard duration bounds", () => {
  const script = buildScript(15);
  script.scenes[0].portions[0].durationSeconds = 30;
  assert.equal(defaultSchema.safeParse(script).success, false);
});

test("structural schema accepts scripts from any format", () => {
  const script = buildScript(12); // off the default target on purpose
  assert.ok(jamScriptSchema.safeParse(script).success);
});

test("format defaults to 4 minutes of 10-20 second portions", () => {
  const format = scriptFormatSchema.parse({});
  assert.deepEqual(format, {
    totalSeconds: 240,
    portionMinSeconds: 10,
    portionMaxSeconds: 20,
  });
});

test("format accepts partial overrides", () => {
  const format = scriptFormatSchema.parse({ totalSeconds: 480 });
  assert.equal(format.totalSeconds, 480);
  assert.equal(format.portionMinSeconds, 10);
});

test("format rejects a minimum portion above the maximum", () => {
  const result = scriptFormatSchema.safeParse({
    portionMinSeconds: 25,
    portionMaxSeconds: 20,
  });
  assert.equal(result.success, false);
});

test("format rejects out-of-range totals", () => {
  assert.equal(scriptFormatSchema.safeParse({ totalSeconds: 30 }).success, false);
  assert.equal(scriptFormatSchema.safeParse({ totalSeconds: 3600 }).success, false);
});

test("a custom format validates scripts against its own target", () => {
  const format = scriptFormatSchema.parse({
    totalSeconds: 480,
    portionMinSeconds: 20,
    portionMaxSeconds: 40,
  });
  const schema = createJamScriptSchema(format);
  const script = buildScript(30); // 16 × 30s = 480s
  assert.ok(schema.safeParse(script).success);
  assert.equal(schema.safeParse(buildScript(15)).success, false);
});
