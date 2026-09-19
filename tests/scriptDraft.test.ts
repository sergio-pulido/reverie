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

test("finalizes a tiny 20-second test jam", () => {
  const format = { totalSeconds: 20, portionMinSeconds: 5, portionMaxSeconds: 5 };
  const draft = {
    title: "Tiny",
    logline: "A jam small enough to test live.",
    scenes: [
      {
        heading: "All of it",
        portions: Array.from({ length: 4 }, () => ({
          durationSeconds: 6,
          action: "Something quick happens.",
        })),
      },
    ],
  };
  const script = finalizeScriptDraft(draft, format);
  assert.equal(totalDurationSeconds(script), 20);
  for (const portion of script.scenes[0].portions) {
    assert.ok(portion.durationSeconds >= 3 && portion.durationSeconds <= 7);
  }
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
