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

test("an ended room is terminal", () => {
  // Its recording is the artifact; a second session would leave two different
  // films behind one room URL.
  const restarted = applyLifecycle("ended", "start");
  assert.equal(restarted.ok, false);
  assert.equal(restarted.refusal, "already_ended");
  assert.equal(restarted.lifecycle, "ended");
});

test("stopping twice is refused but leaves the room ended", () => {
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

test("only an ended room has something to play back", () => {
  assert.equal(hasRecording("live"), false);
  assert.equal(hasRecording("playing"), false);
  assert.equal(hasRecording("ended"), true);
});

test("each state has a label the room can show", () => {
  assert.equal(lifecycleLabel("live"), "Live");
  assert.equal(lifecycleLabel("playing"), "Playing");
  assert.equal(lifecycleLabel("ended"), "Ended");
});
