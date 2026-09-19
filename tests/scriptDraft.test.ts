import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finalizeScriptDraft,
  ScriptDraftError,
} from "../src/core/scriptDraft";
import { totalDurationSeconds } from "../src/core/script";
import { buildScript } from "./helpers";

test("rescales a slightly long draft onto the 4-minute target", () => {
  const draft = buildScript(17); // 16 × 17s = 272s
  const script = finalizeScriptDraft(draft);
  const total = totalDurationSeconds(script);
  assert.ok(Math.abs(total - 240) <= 15, `total was ${total}`);
  for (const scene of script.scenes) {
    for (const portion of scene.portions) {
      assert.ok(portion.durationSeconds >= 8 && portion.durationSeconds <= 22);
    }
  }
});

test("keeps an on-target draft unchanged in total", () => {
  const script = finalizeScriptDraft(buildScript(15));
  assert.equal(totalDurationSeconds(script), 240);
});

test("settles a short mixed draft exactly on 240 seconds", () => {
  // Shape observed from the live provider: 13 portions, 205s total.
  const durations = [[15, 15], [20, 15], [20, 15, 20, 15], [20, 15, 20], [15]];
  const draft = {
    title: "Draft",
    logline: "A draft that runs short.",
    scenes: durations.map((portionSeconds, index) => ({
      heading: `Scene ${index + 1}`,
      portions: portionSeconds.map((durationSeconds) => ({
        durationSeconds,
        action: "Something happens.",
      })),
    })),
  };
  const script = finalizeScriptDraft(draft);
  assert.equal(totalDurationSeconds(script), 240);
  for (const scene of script.scenes) {
    for (const portion of scene.portions) {
      assert.ok(portion.durationSeconds >= 8 && portion.durationSeconds <= 22);
    }
  }
});

test("rejects drafts too far from the target to rescale", () => {
  assert.throws(() => finalizeScriptDraft(buildScript(8)), ScriptDraftError); // 128s
});

test("rescales onto a custom format's target", () => {
  const format = {
    totalSeconds: 120,
    portionMinSeconds: 6,
    portionMaxSeconds: 10,
  };
  const draft = buildScript(9); // 16 × 9s = 144s, within 1.25× of 120s
  const script = finalizeScriptDraft(draft, format);
  assert.equal(totalDurationSeconds(script), 120);
  for (const scene of script.scenes) {
    for (const portion of scene.portions) {
      assert.ok(portion.durationSeconds >= 4 && portion.durationSeconds <= 12);
    }
  }
});
