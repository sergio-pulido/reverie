import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beatOffsets,
  beatWindow,
  beatWindowForScript,
  currentBeatIndex,
  isBeatLocked,
} from "../src/core/directorBeats";
import { buildScript } from "./helpers";

test("beats start at their cumulative offset", () => {
  assert.deepEqual(beatOffsets(buildScript(5, 2, 2)), [0, 5, 10, 15]);
  const uneven = buildScript(5, 1, 3);
  uneven.scenes[0].portions[0].durationSeconds = 12;
  uneven.scenes[0].portions[1].durationSeconds = 7;
  assert.deepEqual(beatOffsets(uneven), [0, 12, 19]);
});

test("the current beat is the last one that has started", () => {
  const offsets = [0, 5, 10, 15];
  assert.equal(currentBeatIndex(offsets, null), null);
  assert.equal(currentBeatIndex(offsets, 0), 0);
  assert.equal(currentBeatIndex(offsets, 4), 0);
  assert.equal(currentBeatIndex(offsets, 5), 1);
  assert.equal(currentBeatIndex(offsets, 14), 2);
  assert.equal(currentBeatIndex(offsets, 99), 3);
});

test("before the first chunk the opening beat is already committed", () => {
  // configure carried the whole script to the provider, so beat 0 is gone
  // already — the same shape as the player's priming state.
  assert.deepEqual(beatWindow([0, 5, 10, 15], null), {
    currentBeatIndex: null,
    lockedBeatIndex: 0,
    minEditableBeatIndex: 1,
  });
});

test("the playing beat and the next one are both closed", () => {
  // This is the window the user asked for: the next beat is blocked so the
  // room has time to react before a change would have reached the screen.
  assert.deepEqual(beatWindow([0, 5, 10, 15], 5), {
    currentBeatIndex: 1,
    lockedBeatIndex: 2,
    minEditableBeatIndex: 3,
  });
});

test("nothing is editable once the last beat is playing", () => {
  assert.deepEqual(beatWindow([0, 5, 10, 15], 15), {
    currentBeatIndex: 3,
    lockedBeatIndex: null,
    minEditableBeatIndex: 4,
  });
  assert.deepEqual(beatWindow([0, 5, 10, 15], 12), {
    currentBeatIndex: 2,
    lockedBeatIndex: 3,
    minEditableBeatIndex: 4,
  });
});

test("an empty outline locks nothing", () => {
  assert.deepEqual(beatWindow([], null), {
    currentBeatIndex: null,
    lockedBeatIndex: null,
    minEditableBeatIndex: 0,
  });
});

test("locked covers everything below the editable boundary", () => {
  const window = beatWindow([0, 5, 10, 15], 5);
  assert.ok(isBeatLocked(window, 0), "played");
  assert.ok(isBeatLocked(window, 1), "playing");
  assert.ok(isBeatLocked(window, 2), "locked for generation");
  assert.equal(isBeatLocked(window, 3), false, "still editable");
});

test("the window can be read straight off a script", () => {
  assert.deepEqual(beatWindowForScript(buildScript(5, 2, 2), 10), {
    currentBeatIndex: 2,
    lockedBeatIndex: 3,
    minEditableBeatIndex: 4,
  });
});
