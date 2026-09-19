import assert from "node:assert/strict";
import { test } from "node:test";
import { jamScriptSchema, totalDurationSeconds } from "../src/core/script";
import { buildScript } from "./helpers";

test("accepts a 4-minute script made of 10-20 second portions", () => {
  const script = buildScript(15);
  assert.equal(totalDurationSeconds(script), 240);
  assert.ok(jamScriptSchema.safeParse(script).success);
});

test("rejects a script far from the 4-minute target", () => {
  const script = buildScript(12); // 16 × 12s = 192s
  assert.equal(jamScriptSchema.safeParse(script).success, false);
});

test("rejects portions outside the hard duration bounds", () => {
  const script = buildScript(15);
  script.scenes[0].portions[0].durationSeconds = 30;
  assert.equal(jamScriptSchema.safeParse(script).success, false);
});
