import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cascadeTokenBudget,
  ensureOutline,
  OUTLINE_ATTEMPTS,
  OutlineWriterError,
  runCascade,
  summaryTokenBudget,
  type OutlineCompletion,
} from "../apps/server/outlineWriter";
import { NebiusError } from "../apps/server/providers/nebius";
import { buildOutline } from "../src/core/outline";
import { jamScriptSchema, type JamScript } from "../src/core/script";

const CONFIG = { apiKey: "test-key", model: "test-model" };

/** Three portions; the first two carry beats, the last does not. */
function scriptOf(): JamScript {
  return jamScriptSchema.parse({
    title: "The Key",
    logline: "Someone loses what they need.",
    scenes: [
      {
        heading: "INT. HALLWAY",
        portions: [
          { durationSeconds: 5, summary: "she finds the key", action: "She kneels." },
          { durationSeconds: 10, summary: "she pockets it", action: "She stands." },
        ],
      },
      {
        heading: "INT. CELLAR",
        portions: [{ durationSeconds: 15, action: "The door gives." }],
      },
    ],
  });
}

/** A completion that answers each call from `replies`, recording what it was asked. */
function completionOf(replies: string[]): OutlineCompletion & { calls: string[] } {
  const calls: string[] = [];
  const complete = (async (options) => {
    calls.push(options.user);
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error("the writer asked for more completions than the test allows");
    return reply;
  }) as OutlineCompletion & { calls: string[] };
  complete.calls = calls;
  return complete;
}

test("a script whose beats are all written costs no call at all", async () => {
  const complete = completionOf([]);
  const whole = jamScriptSchema.parse({
    title: "T",
    logline: "L",
    scenes: [{ heading: "INT. ROOM", portions: [{ durationSeconds: 5, summary: "he waits", action: "He waits." }] }],
  });
  const result = await ensureOutline(CONFIG, whole, complete);
  assert.equal(result.complete, true);
  assert.equal(complete.calls.length, 0);
  assert.deepEqual(result.script, whole);
});

test("one call fills every missing beat and leaves the written ones alone", async () => {
  const complete = completionOf([
    JSON.stringify({ summaries: ["ignored", "ignored too", "she unlocks the cellar"] }),
  ]);
  const result = await ensureOutline(CONFIG, scriptOf(), complete);
  assert.equal(result.complete, true);
  assert.equal(complete.calls.length, 1);
  assert.deepEqual(
    buildOutline(result.script).map((beat) => beat.summary),
    ["she finds the key", "she pockets it", "she unlocks the cellar"],
  );
});

test("a reply of the wrong shape is corrected once, not repeated", async () => {
  const complete = completionOf([
    "not json at all",
    JSON.stringify({ summaries: ["a", "b", "c"] }),
  ]);
  const result = await ensureOutline(CONFIG, scriptOf(), complete);
  assert.equal(result.complete, true);
  assert.equal(complete.calls.length, 2);
  // The second call carries the correction, so the retry fixes the failure
  // rather than asking the same question again.
  assert.match(complete.calls[1], /Correction required/);
});

test("beats that cannot be written leave the script alone and say so", async () => {
  const short = JSON.stringify({ summaries: ["only one"] });
  const complete = completionOf([short, short]);
  const before = scriptOf();
  const result = await ensureOutline(CONFIG, before, complete);
  // A script the room paid for is not lost because its beats failed; the
  // panel shows the gap instead of a phrase nobody wrote.
  assert.equal(result.complete, false);
  assert.deepEqual(result.script, before);
  assert.equal(complete.calls.length, OUTLINE_ATTEMPTS);
});

test("a provider that does not answer does not fail the script either", async () => {
  const complete = (async () => {
    throw new NebiusError("The creative provider did not respond.", true, "no_response");
  }) as OutlineCompletion;
  const result = await ensureOutline(CONFIG, scriptOf(), complete);
  assert.equal(result.complete, false);
});

test("a cascade rewrites the tail from the edited beat", async () => {
  const complete = completionOf([
    JSON.stringify({
      portions: [
        { summary: "she drops it", action: "It rings on the tile." },
        { summary: "she forces the door", action: "Wood splinters." },
      ],
    }),
  ]);
  const next = await runCascade(
    CONFIG,
    scriptOf(),
    { intent: "set", beatIndex: 1, summary: "she drops it" },
    complete,
  );
  assert.deepEqual(
    buildOutline(next).map((beat) => beat.summary),
    ["she finds the key", "she drops it", "she forces the door"],
  );
  assert.match(complete.calls[0], /"she drops it"/);
});

test("a rewrite that does not cover the tail is corrected, then refused", async () => {
  const short = JSON.stringify({ portions: [{ summary: "one", action: "x" }] });
  const complete = completionOf([short, short]);
  await assert.rejects(
    runCascade(CONFIG, scriptOf(), { intent: "reroll", beatIndex: 1 }, complete),
    (error: unknown) =>
      error instanceof OutlineWriterError &&
      error.code === "invalid_cascade" &&
      error.retryable,
  );
  assert.equal(complete.calls.length, OUTLINE_ATTEMPTS);
  assert.match(complete.calls[1], /exactly 2 object\(s\)/);
});

test("a corrected rewrite lands without the edit having to be made again", async () => {
  const complete = completionOf([
    JSON.stringify({ portions: [{ summary: "one", action: "x" }] }),
    JSON.stringify({
      portions: [
        { summary: "she hesitates", action: "She waits." },
        { summary: "the door opens itself", action: "It swings." },
      ],
    }),
  ]);
  const next = await runCascade(CONFIG, scriptOf(), { intent: "reroll", beatIndex: 1 }, complete);
  assert.equal(buildOutline(next)[2].summary, "the door opens itself");
});

test("a provider refusal fails the cascade as a provider failure, with its retryability", async () => {
  const complete = (async () => {
    throw new NebiusError("The creative provider rejected the request (status 429).", true);
  }) as OutlineCompletion;
  await assert.rejects(
    runCascade(CONFIG, scriptOf(), { intent: "set", beatIndex: 0, summary: "x" }, complete),
    (error: unknown) =>
      error instanceof OutlineWriterError &&
      error.code === "generation_failed" &&
      error.retryable,
  );
});

test("the token budgets follow what is actually being written", () => {
  const script = scriptOf();
  assert.equal(summaryTokenBudget(script), 200 + 3 * 60);
  // An edit near the end rewrites less, and costs less, than one at the top.
  assert.equal(cascadeTokenBudget(script, 0), 400 + 3 * 300);
  assert.equal(cascadeTokenBudget(script, 2), 400 + 1 * 300);
});
