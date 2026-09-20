import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyLifecycle,
  hasRecording,
  INITIAL_LIFECYCLE,
  lifecycleLabel,
} from "../src/core/jamLifecycle";

test("a new room is live, and starting it plays", () => {
  assert.equal(INITIAL_LIFECYCLE, "live");
  const started = applyLifecycle("live", "start");
  assert.equal(started.ok, true);
  assert.equal(started.lifecycle, "playing");
});

test("stopping a playing room ends it", () => {
  const stopped = applyLifecycle("playing", "stop");
  assert.equal(stopped.ok, true);
  assert.equal(stopped.lifecycle, "ended");
});

test("a stopped room plays again", () => {
  // Anybody in the room can send the stop signal, so a stop that retired the
  // room would let one misplaced press end it for everyone. The takes do not
  // collide: each session keeps its own archive entry.
  const restarted = applyLifecycle("ended", "start");
  assert.equal(restarted.ok, true);
  assert.equal(restarted.lifecycle, "playing");
});

test("stopping twice is refused but leaves the room stopped", () => {
  const again = applyLifecycle("ended", "stop");
  assert.equal(again.ok, false);
  // The refusal still reports where the room actually is, so an idempotent
  // teardown can report the truth rather than an error.
  assert.equal(again.lifecycle, "ended");
});

test("a room that never started cannot be stopped", () => {
  const stopped = applyLifecycle("live", "stop");
  assert.equal(stopped.ok, false);
  assert.equal(stopped.refusal, "not_playing");
  assert.equal(stopped.lifecycle, "live");
});

test("starting a playing room is refused rather than opening a second stream", () => {
  const again = applyLifecycle("playing", "start");
  assert.equal(again.ok, false);
  assert.equal(again.refusal, "already_playing");
});

test("only a stopped room has something to play back", () => {
  assert.equal(hasRecording("live"), false);
  assert.equal(hasRecording("playing"), false);
  assert.equal(hasRecording("ended"), true);
});

test("each state has a label the room can show", () => {
  assert.equal(lifecycleLabel("live"), "Live");
  assert.equal(lifecycleLabel("playing"), "Playing");
  assert.equal(lifecycleLabel("ended"), "Stopped");
});
