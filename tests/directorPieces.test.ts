import assert from "node:assert/strict";
import { test } from "node:test";
import { RtpHeader, RtpPacket, type MediaStreamTrack } from "werift";
import { DirectorPieceRecorder } from "../apps/server/directorPieces";
import type { DirectorSegmentSink } from "../apps/server/directorSegmentSink";

/**
 * The worker boundary, exercised for real: these spawn the actual muxer thread
 * and push fabricated VP8 across it. What is proved is that packets go over,
 * pieces come back, the codec verdict crosses, and stopping is bounded.
 */

const CLOCK = 90_000;

/** A track the recorder can subscribe to, whose RTP the test fires by hand. */
function fakeTrack(kind: "video" | "audio", codec: string) {
  const listeners: ((packet: RtpPacket) => void)[] = [];
  const track = {
    kind,
    codec: { name: codec },
    onReceiveRtp: {
      subscribe: (listener: (packet: RtpPacket) => void) => {
        listeners.push(listener);
        return { unSubscribe: () => listeners.splice(listeners.indexOf(listener), 1) };
      },
    },
    onReceiveRtcp: { subscribe: () => ({ unSubscribe: () => {} }) },
  } as unknown as MediaStreamTrack;
  const emit = (packet: RtpPacket) => {
    for (const listener of listeners) listener(packet);
  };
  return { track, emit, get subscribed() { return listeners.length; } };
}

function vp8Frame(sequence: number, seconds: number, keyframe: boolean): RtpPacket {
  const header = new RtpHeader({
    payloadType: 96,
    sequenceNumber: sequence,
    timestamp: seconds * CLOCK,
    ssrc: 1234,
    marker: true,
  });
  const payload = Buffer.concat([
    Buffer.from([0x10, keyframe ? 0x00 : 0x01, 0x00, 0x00]),
    Buffer.alloc(64, 0xaa),
  ]);
  return new RtpPacket(header, payload);
}

class RecordingSink implements DirectorSegmentSink {
  readonly inits: { codec: string; bytes: number }[] = [];
  readonly pieces: { index: number; start: number; duration: number }[] = [];
  finished = false;
  init(segment: Buffer, codec: string): void {
    this.inits.push({ codec, bytes: segment.byteLength });
  }
  segment(index: number, _bytes: Buffer, start: number, duration: number): void {
    this.pieces.push({ index, start, duration });
  }
  finish(): void {
    this.finished = true;
  }
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed_out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("pieces cross the worker boundary and reach the sink", async () => {
  const sink = new RecordingSink();
  const recorder = new DirectorPieceRecorder({
    sinks: [sink],
    trackGraceMs: 0,
    targetPieceSeconds: 10,
  });
  const video = fakeTrack("video", "vp8");
  recorder.addTrack(video.track);
  recorder.start();
  assert.equal(video.subscribed, 1);

  for (let second = 0; second < 25; second += 1) {
    video.emit(vp8Frame(second, second, second % 5 === 0));
  }
  // Two whole pieces are closable before the stream ends; the tail comes on stop.
  await until(() => sink.pieces.length >= 2);
  await recorder.stop();

  assert.equal(recorder.refusedBecause, null);
  assert.equal(recorder.negotiatedCodec, "vp8");
  assert.equal(sink.inits.length, 1);
  assert.deepEqual(
    sink.pieces.map((piece) => [piece.index, piece.start, piece.duration]),
    [
      [0, 0, 10],
      [1, 10, 10],
      [2, 20, 4],
    ],
  );
  assert.equal(recorder.publishedCount, 3);
  assert.equal(sink.finished, true);
  // The track is released, so a stopped recorder costs nothing per packet.
  assert.equal(video.subscribed, 0);
});

test("a codec WebM cannot carry is refused across the boundary", async () => {
  const recorder = new DirectorPieceRecorder({ trackGraceMs: 0 });
  recorder.addTrack(fakeTrack("video", "av1x").track);
  recorder.start();
  await until(() => recorder.refusedBecause !== null);
  assert.equal(recorder.refusedBecause, "unsupported_codec");
  await recorder.stop();
});

test("stopping is bounded even when the muxer never produced anything", async () => {
  const sink = new RecordingSink();
  const recorder = new DirectorPieceRecorder({ sinks: [sink], trackGraceMs: 0 });
  recorder.addTrack(fakeTrack("video", "vp8").track);
  recorder.start();
  const startedAt = Date.now();
  await recorder.stop();
  assert.ok(Date.now() - startedAt < 5_000);
  assert.equal(sink.finished, true);
  await recorder.stop();
});

test("a recorder that never received a track stops without spawning anything", async () => {
  const sink = new RecordingSink();
  const recorder = new DirectorPieceRecorder({ sinks: [sink], trackGraceMs: 0 });
  recorder.start();
  await recorder.stop();
  assert.equal(sink.finished, true);
  assert.equal(recorder.publishedCount, 0);
});

test("the inline muxer produces the same pieces, without a thread", async () => {
  // Inline is the arrangement that stalls a real server, so it exists for
  // tests only — but it must agree with the worker, or the tests describe a
  // different system from the one that ships.
  const sink = new RecordingSink();
  const recorder = new DirectorPieceRecorder({
    sinks: [sink],
    trackGraceMs: 0,
    targetPieceSeconds: 10,
    inline: true,
  });
  const video = fakeTrack("video", "vp8");
  recorder.addTrack(video.track);
  recorder.start();
  for (let second = 0; second < 25; second += 1) {
    video.emit(vp8Frame(second, second, second % 5 === 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  await recorder.stop();
  assert.deepEqual(
    sink.pieces.map((piece) => [piece.index, piece.start, piece.duration]),
    [
      [0, 0, 10],
      [1, 10, 10],
      [2, 20, 4],
    ],
  );
});
