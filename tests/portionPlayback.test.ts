import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configurationKey,
  describeConfiguration,
  nextPlayerAction,
  parsePlaybackSnapshot,
  playingPortionIndex,
  type PlaybackSnapshot,
  type PortionMediaStatus,
} from "../src/core/portionPlayback";

function snapshot(
  playback: PlaybackSnapshot["playback"],
  lockedPortionIndex: number | null,
  media: PortionMediaStatus[],
): PlaybackSnapshot {
  return {
    playback,
    lockedPortionIndex,
    minEditablePortionIndex: 0,
    portions: media.map((status, index) => ({
      portionIndex: index,
      durationSeconds: 8,
      media: status,
    })),
  };
}

test("an idle jam is started, not advanced", () => {
  const idle = snapshot({ status: "idle", currentPortionIndex: null, stateVersion: 1 }, null, ["none", "none"]);
  assert.deepEqual(nextPlayerAction(idle), { kind: "start" });
  assert.equal(playingPortionIndex(idle), null);
});

test("the viewer waits while the locked portion is still generating", () => {
  const priming = snapshot({ status: "priming", currentPortionIndex: null, stateVersion: 2 }, 0, ["generating", "none"]);
  assert.deepEqual(nextPlayerAction(priming), { kind: "wait", portionIndex: 0, media: "generating" });
  assert.equal(playingPortionIndex(priming), null);
});

test("a ready locked portion is advanced to with the version the snapshot carried", () => {
  const ready = snapshot({ status: "priming", currentPortionIndex: null, stateVersion: 2 }, 0, ["ready", "none"]);
  assert.deepEqual(nextPlayerAction(ready), {
    kind: "advance",
    portionIndex: 0,
    expectedStateVersion: 2,
  });
});

test("a failed generation is reported, never waited on forever", () => {
  const failed = snapshot({ status: "playing", currentPortionIndex: 0, stateVersion: 3 }, 1, ["ready", "failed"]);
  assert.deepEqual(nextPlayerAction(failed), { kind: "failed", portionIndex: 1 });
  assert.equal(playingPortionIndex(failed), 0);
});

test("the last portion and a finished jam have nothing left to ask for", () => {
  const last = snapshot({ status: "playing", currentPortionIndex: 1, stateVersion: 4 }, null, ["ready", "ready"]);
  assert.deepEqual(nextPlayerAction(last), { kind: "finished" });
  const done = snapshot({ status: "finished", currentPortionIndex: 1, stateVersion: 5 }, null, ["ready", "ready"]);
  assert.deepEqual(nextPlayerAction(done), { kind: "finished" });
  assert.equal(playingPortionIndex(done), null);
});

test("a snapshot the server did not author is rejected", () => {
  assert.throws(() => parsePlaybackSnapshot({ playback: { status: "rolling" } }), /playback_snapshot_invalid/);
  assert.throws(() => parsePlaybackSnapshot(null), /playback_snapshot_invalid/);
});

test("cosmetic differences do not make a second configuration", () => {
  const key = configurationKey({ language: "es", ambientation: "sunlit watercolor" });
  assert.equal(configurationKey({ language: "ES", ambientation: "  sunlit   watercolor " }), key);
  assert.notEqual(configurationKey({ language: "en", ambientation: "sunlit watercolor" }), key);
  assert.notEqual(configurationKey({ language: "es", ambientation: "arctic night" }), key);
});

test("a configuration key separates its parts unambiguously", () => {
  assert.notEqual(
    configurationKey({ language: "es", ambientation: "a|b" }),
    configurationKey({ language: "es", ambientation: "a" }) + "b",
  );
});

test("the configuration reads the way the annotated script view says it", () => {
  assert.equal(
    describeConfiguration({ language: "es", ambientation: "sunlit watercolor" }),
    "language es, ambientation “sunlit watercolor”",
  );
  assert.equal(describeConfiguration({ language: "en", ambientation: "" }), "language en, ambientation as written");
});
