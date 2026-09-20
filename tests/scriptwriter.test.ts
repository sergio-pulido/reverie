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

/** The 4-minute format the fitted fixtures target; no longer the default. */
const FOUR_MINUTES = scriptFormatSchema.parse({
  totalSeconds: 240,
  portionMinSeconds: 12,
  portionMaxSeconds: 15,
});

test("expected portions follow the format's timing", () => {
  assert.equal(expectedPortions(DEFAULT_SCRIPT_FORMAT), 4); // 60s / 15s avg
  assert.equal(expectedPortions(FOUR_MINUTES), 18); // 240s / 13.5s avg
  assert.equal(
    expectedPortions({ totalSeconds: 60, portionMinSeconds: 5, portionMaxSeconds: 5 }),
    12,
  );
});

test("completion token budget scales with the script size and stays capped", () => {
  const tiny = { totalSeconds: 60, portionMinSeconds: 5, portionMaxSeconds: 5 };
  const huge = scriptFormatSchema.parse({
    totalSeconds: 720,
    portionMinSeconds: 15,
    portionMaxSeconds: 15,
  });
  assert.equal(completionTokenBudget(tiny), 800 + 12 * 300);
  assert.equal(completionTokenBudget(FOUR_MINUTES), 800 + 18 * 300);
  assert.equal(completionTokenBudget(huge), 8000);
});

test("system prompt speaks the format's numbers", () => {
  const prompt = buildSystemPrompt(
    scriptFormatSchema.parse({
      totalSeconds: 60,
      portionMinSeconds: 5,
      portionMaxSeconds: 5,
    }),
  );
  assert.match(prompt, /60 seconds in total/);
  assert.match(prompt, /5-5 seconds each/);
});

test("correction prompt names a shortfall and the portion plan", () => {
  const prompt = buildCorrectionPrompt(draftOf(15, 8), FOUR_MINUTES); // 120s under 240s
  assert.match(prompt, /120 seconds across 8 portions/);
  assert.match(prompt, /120 seconds too short/);
  assert.match(prompt, /16 to 24 portions/);
  assert.match(prompt, /exactly 240/);
});

test("correction prompt names an overshoot", () => {
  const prompt = buildCorrectionPrompt(draftOf(40, 8), FOUR_MINUTES); // 320s over 240s
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
    FOUR_MINUTES,
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
    FOUR_MINUTES,
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

test("the writer asks for a beat beside every portion, in the shape it will be read in", () => {
  const prompt = buildSystemPrompt(DEFAULT_SCRIPT_FORMAT);
  // Beats are born with the script: the phrase and the prose come from one
  // completion and one view of the story.
  assert.match(prompt, /Give every portion a "summary"/);
  assert.match(prompt, /at most 120 characters/);
  assert.match(prompt, /"durationSeconds": number, "summary": string, "action": string/);
});

test("a beat the model wrote survives into the finished script", async () => {
  const draft = fittedDraft();
  draft.scenes[0].portions[0].summary = "she hears the tide answer";
  const complete: ScriptCompletion = async () => JSON.stringify(draft);
  const script = await writeJamScript(
    TEST_CONFIG,
    { kind: "from-scratch", prompt: "A keeper finds a door." },
    FOUR_MINUTES,
    complete,
  );
  assert.equal(script.scenes[0].portions[0].summary, "she hears the tide answer");
  // A portion the model left unsummarised is not given one here; the fill-in
  // in apps/server/outlineWriter.ts is the only thing that writes a missing beat.
  assert.equal(script.scenes[0].portions[1].summary, undefined);
});
