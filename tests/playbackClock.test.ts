import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatPlaybackClock,
  parsePlaybackClock,
  playbackPosition,
  positionMsAt,
  type JamPlaybackClock,
} from "../src/core/playbackClock";

function clock(overrides: Partial<JamPlaybackClock> = {}): JamPlaybackClock {
  return {
    jamId: "11111111-1111-4111-8111-111111111111",
    status: "idle",
    elapsedMs: 0,
    serverNow: "2026-09-19T12:00:00.000Z",
    stateVersion: 1,
    ...overrides,
  };
}

describe("positionMsAt", () => {
  it("advances a playing clock by the local monotonic elapsed time", () => {
    const playing = clock({ status: "playing", elapsedMs: 5_000 });
    assert.equal(positionMsAt(playing, 1_000, 3_500), 7_500);
  });

  it("never advances a paused clock", () => {
    const paused = clock({ status: "paused", elapsedMs: 5_000 });
    assert.equal(positionMsAt(paused, 1_000, 9_999), 5_000);
  });

  it("never advances an idle clock", () => {
    assert.equal(positionMsAt(clock(), 0, 60_000), 0);
  });

  it("never goes backwards if the monotonic reading appears to move back", () => {
    const playing = clock({ status: "playing", elapsedMs: 5_000 });
    assert.equal(positionMsAt(playing, 10_000, 9_000), 5_000);
  });
});

describe("playbackPosition", () => {
  it("returns zero before any clock has been read", () => {
    assert.deepEqual(playbackPosition(null, 0, 0), { elapsedMs: 0, clock: "0:00" });
  });

  it("reports the same counter for two viewers that received the same anchor", () => {
    const anchor = clock({ status: "playing", elapsedMs: 12_000 });
    // Both clients received the anchor at their own t0 and are read at the same offset.
    const first = playbackPosition(anchor, 100, 4_100);
    const second = playbackPosition(anchor, 5_000, 9_000);
    assert.equal(first.clock, "0:16");
    assert.equal(second.clock, "0:16");
    assert.equal(first.elapsedMs, second.elapsedMs);
  });
});

describe("formatPlaybackClock", () => {
  it("formats whole seconds as m:ss and never goes negative", () => {
    assert.equal(formatPlaybackClock(0), "0:00");
    assert.equal(formatPlaybackClock(9_400), "0:09");
    assert.equal(formatPlaybackClock(65_000), "1:05");
    assert.equal(formatPlaybackClock(-5_000), "0:00");
  });
});

describe("parsePlaybackClock", () => {
  it("accepts a well-formed payload", () => {
    const parsed = parsePlaybackClock(clock({ status: "playing", elapsedMs: 1_000 }));
    assert.equal(parsed.status, "playing");
  });

  it("rejects a payload with a bad status or negative elapsed", () => {
    assert.throws(() => parsePlaybackClock(clock({ status: "nope" as never })));
    assert.throws(() => parsePlaybackClock(clock({ elapsedMs: -1 })));
    assert.throws(() => parsePlaybackClock({}));
  });
});
