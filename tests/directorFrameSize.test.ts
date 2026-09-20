import assert from "node:assert/strict";
import test from "node:test";
import { directorFrameSize } from "../apps/server/providers/falDirector";
import { usableDimension } from "../apps/server/directorMuxer";

/**
 * The frame size a video track is declared with.
 *
 * This is not metadata hygiene. werift derives the fMP4 display aspect ratio
 * with a Euclidean `gcd` loop over the track's width and height on the FIRST
 * KEYFRAME. Its own type marks both optional, but `undefined % undefined` is
 * `NaN` and `NaN !== 0` is forever true, so a video track declared without a
 * size hangs the muxer thread outright — no init segment, no segments, no
 * error, and (because the worker is alive, merely wedged) no refusal either.
 * Live delivery then serves a 200 with an empty playlist while every segment
 * 404s, which is indistinguishable from a healthy stream that has not started.
 *
 * Diagnosed 2026-09-20 by replaying 5,341 captured RTP packets from a real
 * session: with no size the muxer stopped returning on video packet 19, the
 * first complete frame; with one it produced an init segment and four media
 * segments from the same bytes.
 */

test("every resolution and aspect ratio yields a usable, even-sided frame", () => {
  const resolutions = ["480p", "768p", "1080p"] as const;
  const ratios = ["16:9", "9:16", "1:1"] as const;
  for (const resolution of resolutions) {
    for (const aspectRatio of ratios) {
      const size = directorFrameSize({ resolution, aspectRatio });
      // The only property that actually matters to the muxer: `gcd` must
      // terminate, which it does for any pair of finite positive integers.
      assert.ok(Number.isInteger(size.width) && size.width > 0, `${resolution} ${aspectRatio} width`);
      assert.ok(Number.isInteger(size.height) && size.height > 0, `${resolution} ${aspectRatio} height`);
    }
  }
});

test("the resolution names the short side, and the aspect ratio decides which side that is", () => {
  assert.deepEqual(directorFrameSize({ resolution: "768p", aspectRatio: "16:9" }), { width: 1366, height: 768 });
  assert.deepEqual(directorFrameSize({ resolution: "768p", aspectRatio: "9:16" }), { width: 768, height: 1366 });
  assert.deepEqual(directorFrameSize({ resolution: "768p", aspectRatio: "1:1" }), { width: 768, height: 768 });
  assert.deepEqual(directorFrameSize({ resolution: "480p", aspectRatio: "16:9" }), { width: 854, height: 480 });
  assert.deepEqual(directorFrameSize({ resolution: "1080p", aspectRatio: "16:9" }), { width: 1920, height: 1080 });
});

test("a dimension werift's ratio loop cannot terminate on is never passed through", () => {
  // The guard exists because `gcd` spins forever on anything non-finite: it is
  // the difference between degraded metadata and a hung muxer thread.
  assert.equal(usableDimension(1366), 1366);
  assert.equal(usableDimension(768.4), 768, "rounded, because a frame has whole pixels");
  for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -720]) {
    const guarded = usableDimension(bad as number | undefined);
    assert.ok(
      Number.isFinite(guarded) && Number.isInteger(guarded) && guarded >= 1,
      `${String(bad)} must not reach werift`,
    );
  }
});

test("the real derivation always survives the guard unchanged", () => {
  // The two halves must agree: nothing the deriver produces should be altered
  // by the guard, or the guard is silently masking a broken derivation.
  for (const resolution of ["480p", "768p", "1080p"] as const) {
    for (const aspectRatio of ["16:9", "9:16", "1:1"] as const) {
      const size = directorFrameSize({ resolution, aspectRatio });
      assert.equal(usableDimension(size.width), size.width);
      assert.equal(usableDimension(size.height), size.height);
    }
  }
});
