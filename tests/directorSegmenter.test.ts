import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaStreamTrack } from "werift";
import { DirectorSegmenter, type DirectorSegmentSink } from "../apps/server/directorSegmenter";

/**
 * The worker boundary, exercised for real.
 *
 * These spawn the actual muxer thread. No synthetic H.264 is fed through it —
 * producing valid encoded frames without a provider is not something a test can
 * honestly do — so what is covered is the boundary itself: that the thread
 * starts, that the codec verdict crosses back, and that stopping is bounded.
 * Whether real frames mux correctly is only knowable from a live session.
 */

/** Enough of a track for the segmenter: a kind, a codec, and an RTP event. */
function fakeTrack(kind: "video" | "audio", codec: string): MediaStreamTrack {
  return {
    kind,
    codec: { name: codec },
    onReceiveRtp: { subscribe: () => ({ unSubscribe: () => {} }) },
    onReceiveRtcp: { subscribe: () => ({ unSubscribe: () => {} }) },
  } as unknown as MediaStreamTrack;
}

class RecordingSink implements DirectorSegmentSink {
  readonly inits: { codec: string; bytes: number }[] = [];
  readonly segments: { index: number; bytes: number; duration: number }[] = [];
  finished = false;

  init(segment: Buffer, codec: string): void {
    this.inits.push({ codec, bytes: segment.byteLength });
  }

  segment(index: number, bytes: Buffer, _start: number, durationSeconds: number): void {
    this.segments.push({ index, bytes: bytes.byteLength, duration: durationSeconds });
  }

  finish(): void {
    this.finished = true;
  }
}

/** Waits for a condition the worker thread satisfies asynchronously. */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed_out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a codec fMP4 cannot carry is refused across the worker boundary", async () => {
  const segmenter = new DirectorSegmenter({ trackGraceMs: 0 });
  segmenter.addTrack(fakeTrack("video", "vp8"));
  segmenter.start();

  // The verdict is the worker's, and it has to come back here: serving a
  // playlist of segments no browser can decode would be worse than refusing.
  await until(() => segmenter.refusedBecause !== null);
  assert.equal(segmenter.refusedBecause, "unsupported_codec");
  assert.equal(segmenter.negotiatedCodec, "vp8");
  await segmenter.stop();
});

test("H.264 with Opus opens the muxer rather than refusing it", async () => {
  const sink = new RecordingSink();
  const segmenter = new DirectorSegmenter({ sinks: [sink], trackGraceMs: 0 });
  segmenter.addTrack(fakeTrack("video", "h264"));
  segmenter.addTrack(fakeTrack("audio", "opus"));
  segmenter.start();

  // Nothing is muxed without frames, so the evidence is the absence of a
  // refusal after the worker has had time to render its verdict.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(segmenter.refusedBecause, null);
  assert.equal(segmenter.negotiatedCodec, "h264");
  await segmenter.stop();
  assert.equal(sink.finished, true);
});

test("stopping is bounded even when the muxer never produced anything", async () => {
  const sink = new RecordingSink();
  const segmenter = new DirectorSegmenter({ sinks: [sink], trackGraceMs: 0 });
  segmenter.addTrack(fakeTrack("video", "h264"));
  segmenter.start();

  // The route that settles the paid session waits on this. It may wait for the
  // tail of the film; it may not wait indefinitely.
  const startedAt = Date.now();
  await segmenter.stop();
  assert.ok(Date.now() - startedAt < 5_000);
  assert.equal(sink.finished, true);
  // Idempotent: a session torn down twice is not an error.
  await segmenter.stop();
});

test("a segmenter that never received a track stops without spawning anything", async () => {
  const sink = new RecordingSink();
  const segmenter = new DirectorSegmenter({ sinks: [sink], trackGraceMs: 0 });
  segmenter.start();
  await segmenter.stop();
  assert.equal(sink.finished, true);
  assert.equal(segmenter.publishedCount, 0);
});

test("the inline muxer reaches the same verdict, without a thread", async () => {
  // Inline is the arrangement that stalls a real server, so it exists for tests
  // only — but it must agree with the worker, or the tests describe a different
  // system from the one that ships.
  const segmenter = new DirectorSegmenter({ trackGraceMs: 0, inline: true });
  segmenter.addTrack(fakeTrack("video", "vp9"));
  segmenter.start();
  assert.equal(segmenter.refusedBecause, "unsupported_codec");
  await segmenter.stop();
});
