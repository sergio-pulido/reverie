import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finalizeScriptDraft,
  ScriptDraftError,
} from "../src/core/scriptDraft";
import { totalDurationSeconds } from "../src/core/script";
import { buildScript } from "./helpers";

// The 4-minute format these rescaling tests exercise is no longer the default,
// so they state it. Its portion band sits inside the model band, which keeps
// the hard bounds at 10s..15s after slack and clamping.
const FOUR_MINUTES = {
  totalSeconds: 240,
  portionMinSeconds: 12,
  portionMaxSeconds: 15,
};

test("rescales a slightly long draft onto the 4-minute target", () => {
  const draft = buildScript(17); // 16 × 17s = 272s
  const script = finalizeScriptDraft(draft, FOUR_MINUTES);
  const total = totalDurationSeconds(script);
  assert.ok(Math.abs(total - 240) <= 15, `total was ${total}`);
  for (const scene of script.scenes) {
    for (const portion of scene.portions) {
      assert.ok(portion.durationSeconds >= 10 && portion.durationSeconds <= 15);
    }
  }
});

test("keeps an on-target draft unchanged in total", () => {
  const script = finalizeScriptDraft(buildScript(15), FOUR_MINUTES);
  assert.equal(totalDurationSeconds(script), 240);
});

test("keeps an on-target draft unchanged under the 60-second default", () => {
  const script = finalizeScriptDraft(buildScript(5, 3, 4));
  assert.equal(totalDurationSeconds(script), 60);
});

test("settles a short mixed draft exactly on 240 seconds", () => {
  // The old fixture here was 13 portions of 15-20s. Under the model band a
  // portion caps at 15s, so 13 portions can reach at most 195s and 240s became
  // unreachable by arithmetic, not by a bug. Same intent, 18 portions.
  const durations = [
    [12, 12, 12],
    [14, 12, 14],
    [14, 12, 14, 12],
    [14, 12, 14],
    [12, 14, 12, 14, 12],
  ];
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
  const script = finalizeScriptDraft(draft, FOUR_MINUTES);
  assert.equal(totalDurationSeconds(script), 240);
  for (const scene of script.scenes) {
    for (const portion of scene.portions) {
      assert.ok(portion.durationSeconds >= 10 && portion.durationSeconds <= 15);
    }
  }
});

test("rejects drafts too far from the target to rescale", () => {
  // 128s against a 240s target is below the 0.8x rescale floor.
  assert.throws(
    () => finalizeScriptDraft(buildScript(8), FOUR_MINUTES),
    ScriptDraftError,
  );
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
