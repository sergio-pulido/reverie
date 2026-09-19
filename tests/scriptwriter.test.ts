import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSystemPrompt,
  completionTokenBudget,
  expectedPortions,
} from "../apps/server/scriptwriter";
import { DEFAULT_SCRIPT_FORMAT, scriptFormatSchema } from "../src/core/script";

test("expected portions follow the format's timing", () => {
  assert.equal(expectedPortions(DEFAULT_SCRIPT_FORMAT), 16); // 240s / 15s avg
  assert.equal(
    expectedPortions({ totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 }),
    4,
  );
});

test("completion token budget scales with the script size and stays capped", () => {
  const tiny = { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 };
  const huge = scriptFormatSchema.parse({
    totalSeconds: 900,
    portionMinSeconds: 19,
    portionMaxSeconds: 30,
  });
  assert.equal(completionTokenBudget(tiny), 800 + 4 * 260);
  assert.equal(completionTokenBudget(DEFAULT_SCRIPT_FORMAT), 800 + 16 * 260);
  assert.equal(completionTokenBudget(huge), 8000);
});

test("system prompt speaks the format's numbers", () => {
  const prompt = buildSystemPrompt(
    scriptFormatSchema.parse({
      totalSeconds: 20,
      portionMinSeconds: 5,
      portionMaxSeconds: 5,
    }),
  );
  assert.match(prompt, /20 seconds in total/);
  assert.match(prompt, /5-5 seconds each/);
});
