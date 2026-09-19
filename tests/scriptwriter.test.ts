import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCorrectionPrompt,
  buildSystemPrompt,
  completionTokenBudget,
  expectedPortions,
  SCRIPT_ATTEMPTS,
  ScriptwriterError,
  writeJamScript,
  type ScriptCompletion,
} from "../apps/server/scriptwriter";
import {
  DEFAULT_SCRIPT_FORMAT,
  scriptFormatSchema,
  totalDurationSeconds,
} from "../src/core/script";
import type { JamScriptDraft } from "../src/core/scriptDraft";

/** A draft with one scene and `portionCount` equal-length portions. */
function draftOf(portionSeconds: number, portionCount: number): JamScriptDraft {
  return {
    title: "Draft",
    logline: "A draft used to exercise the retry loop.",
    scenes: [
      {
        heading: "Only scene",
        portions: Array.from({ length: portionCount }, () => ({
          durationSeconds: portionSeconds,
          action: "Something happens.",
        })),
      },
    ],
  };
}

/** A valid 4-minute script (4 scenes × 4 portions × 15s). */
function fittedDraft(): JamScriptDraft {
  return {
    title: "Fitted",
    logline: "The corrected draft.",
    scenes: Array.from({ length: 4 }, (_, scene) => ({
      heading: `Scene ${scene + 1}`,
      portions: Array.from({ length: 4 }, () => ({
        durationSeconds: 15,
        action: "A fitted beat.",
      })),
    })),
  };
}

const TEST_CONFIG = { apiKey: "test-key", model: "test-model" };

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

test("correction prompt names a shortfall and the portion plan", () => {
  const prompt = buildCorrectionPrompt(draftOf(15, 8)); // 120s, far under 240s
  assert.match(prompt, /120 seconds across 8 portions/);
  assert.match(prompt, /120 seconds too short/);
  assert.match(prompt, /11 to 30 portions/);
  assert.match(prompt, /exactly 240/);
});

test("correction prompt names an overshoot", () => {
  const prompt = buildCorrectionPrompt(draftOf(40, 8)); // 320s, far over 240s
  assert.match(prompt, /80 seconds too long/);
});

test("retries a too-short draft with a correction and returns the fitted script", async () => {
  const prompts: string[] = [];
  const complete: ScriptCompletion = async ({ system }) => {
    prompts.push(system);
    return JSON.stringify(prompts.length === 1 ? draftOf(15, 8) : fittedDraft());
  };

  const script = await writeJamScript(
    TEST_CONFIG,
    { kind: "from-scratch", prompt: "A test idea." },
    DEFAULT_SCRIPT_FORMAT,
    complete,
  );

  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0], /Correction required/);
  assert.match(prompts[1], /Correction required/);
  assert.equal(totalDurationSeconds(script), 240);
});

test("asks for the right shape when the provider returns unusable JSON", async () => {
  const prompts: string[] = [];
  const complete: ScriptCompletion = async ({ system }) => {
    prompts.push(system);
    return prompts.length === 1 ? "not json at all" : JSON.stringify(fittedDraft());
  };

  const script = await writeJamScript(
    TEST_CONFIG,
    { kind: "from-scratch", prompt: "A test idea." },
    DEFAULT_SCRIPT_FORMAT,
    complete,
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /single JSON object/);
  assert.equal(totalDurationSeconds(script), 240);
});

test("gives up on a typed, retryable failure after the bounded attempts", async () => {
  let calls = 0;
  const complete: ScriptCompletion = async () => {
    calls += 1;
    return JSON.stringify(draftOf(15, 8)); // never fits
  };

  await assert.rejects(
    writeJamScript(
      TEST_CONFIG,
      { kind: "from-scratch", prompt: "A test idea." },
      DEFAULT_SCRIPT_FORMAT,
      complete,
    ),
    (error: unknown) => error instanceof ScriptwriterError && error.retryable,
  );
  assert.equal(calls, SCRIPT_ATTEMPTS);
});
