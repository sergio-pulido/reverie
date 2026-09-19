import assert from "node:assert/strict";
import test from "node:test";
import {
  formatClock,
  playbackReadingSchema,
  playheadSeconds,
  positionSeconds,
  type PlaybackAnchor,
} from "../src/core/playbackClock";

function anchor(overrides: Partial<PlaybackAnchor["reading"]> = {}, receivedAt = 1_000): PlaybackAnchor {
  return {
    reading: {
      jamId: "6f2f8f4e-1f3a-4a0a-9a1a-000000000000",
      status: "playing",
      elapsedMs: 12_000,
      serverNow: "2026-09-20T10:00:00.000Z",
      stateVersion: 3,
      ...overrides,
    },
    receivedAt,
  };
}

test("with no reading the room is at zero, not at some guessed position", () => {
  assert.equal(positionSeconds(null, 5_000), 0);
});

test("a playing clock advances by time measured here, never by comparing wall clocks", () => {
  assert.equal(positionSeconds(anchor(), 1_000), 12);
  assert.equal(positionSeconds(anchor(), 4_500), 15.5);
});

test("a paused or idle clock does not move, however long the reading is held", () => {
  assert.equal(positionSeconds(anchor({ status: "paused" }), 60_000), 12);
  assert.equal(positionSeconds(anchor({ status: "idle", elapsedMs: 0 }), 60_000), 0);
});

test("a local clock that jumped backwards never rewinds the room", () => {
  assert.equal(positionSeconds(anchor(), 500), 12);
});

test("the playhead stops at the end of the film, because the clock does not know about it", () => {
  // The room's timer keeps counting past the last beat; the bar must not.
  assert.equal(playheadSeconds(anchor(), 41_000, 30), 30);
  assert.equal(playheadSeconds(anchor(), 1_000, 30), 12);
  assert.equal(playheadSeconds(anchor(), 1_000, 0), 0, "a film with no runtime has no playhead");
});

test("the clock reads as minutes and seconds, and nonsense reads as zero", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(9), "0:09");
  assert.equal(formatClock(131), "2:11");
  assert.equal(formatClock(-4), "0:00");
  assert.equal(formatClock(Number.NaN), "0:00");
});

test("a reading is validated before it is trusted", () => {
  const good = playbackReadingSchema.safeParse({
    jamId: "room",
    status: "playing",
    // Postgres sends bigint as a string; it is coerced rather than refused.
    elapsedMs: "4200",
    serverNow: "2026-09-20T10:00:00.000Z",
    stateVersion: 2,
  });
  assert.equal(good.success, true);
  assert.equal(good.success && good.data.elapsedMs, 4200);

  for (const bad of [
    { jamId: "room", status: "rewinding", elapsedMs: 0, serverNow: "x", stateVersion: 1 },
    { jamId: "room", status: "playing", elapsedMs: -1, serverNow: "x", stateVersion: 1 },
    { jamId: "room", status: "playing", elapsedMs: 0, serverNow: "x", stateVersion: 0 },
  ]) {
    assert.equal(playbackReadingSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});
