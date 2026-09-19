import assert from "node:assert/strict";
import { test } from "node:test";
import { RtpHeader, RtpPacket } from "werift";
import { PieceMuxer } from "../apps/server/directorPieceMuxer";

/**
 * Real bytes through the real pipeline.
 *
 * VP8's RTP payload format is simple enough to fabricate honestly: a one-byte
 * descriptor (S=1, PID=0) and a three-byte frame header whose P bit says
 * keyframe or not. The muxer never decodes pixels, so a frame of filler is a
 * frame to it. What this proves is the slicing — that pieces begin on
 * keyframes, close past the target length, and carry the right clock — and
 * that the last piece is settled by the muxer's own end-of-stream, not by a
 * guess made at stop.
 */

const CLOCK = 90_000;
/** Descriptor: X=0, N=0, S=1, PID=0. */
const VP8_DESCRIPTOR = 0x10;

function vp8Frame(sequence: number, seconds: number, keyframe: boolean): Buffer {
  const header = new RtpHeader({
    payloadType: 96,
    sequenceNumber: sequence,
    timestamp: seconds * CLOCK,
    ssrc: 1234,
    // One packet per frame, so each packet is the last of its frame.
    marker: true,
  });
  // Frame header: P bit (LSB of the first byte) is 0 for a keyframe.
  const frameHeader = Buffer.from([keyframe ? 0x00 : 0x01, 0x00, 0x00]);
  const filler = Buffer.alloc(64, keyframe ? 0xaa : 0x55);
  const payload = Buffer.concat([Buffer.from([VP8_DESCRIPTOR]), frameHeader, filler]);
  return new RtpPacket(header, payload).serialize();
}

interface Captured {
  inits: { codec: string; bytes: number }[];
  pieces: { index: number; bytes: number; start: number; duration: number }[];
  refused: string[];
}

function capture(): { handlers: ConstructorParameters<typeof PieceMuxer>[1]; got: Captured } {
  const got: Captured = { inits: [], pieces: [], refused: [] };
  return {
    got,
    handlers: {
      onInit: (bytes, codec) => got.inits.push({ codec, bytes: bytes.byteLength }),
      onPiece: (index, bytes, start, duration) =>
        got.pieces.push({ index, bytes: bytes.byteLength, start, duration }),
      onRefused: (reason) => got.refused.push(reason),
    },
  };
}

/** Lets the muxer's asynchronous output queue drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("a VP8 stream is cut into keyframe-aligned pieces of the target length", async () => {
  const { handlers, got } = capture();
  const muxer = new PieceMuxer([{ kind: "video", codec: "vp8" }], handlers, {
    targetPieceSeconds: 10,
  });

  // 30 seconds of one frame per second, a keyframe every 5 seconds.
  for (let second = 0; second < 30; second += 1) {
    muxer.write(0, vp8Frame(second, second, second % 5 === 0));
  }
  await settle();
  await muxer.stop();

  assert.equal(got.refused.length, 0);
  assert.equal(got.inits.length, 1, "the initial header is emitted exactly once");
  assert.equal(got.inits[0].codec, "vp8");
  assert.ok(got.inits[0].bytes > 0);

  // Pieces close at the first keyframe past 10s: 0-10, 10-20, and the tail.
  assert.deepEqual(
    got.pieces.map((piece) => [piece.index, piece.start, piece.duration]),
    [
      [0, 0, 10],
      [1, 10, 10],
      [2, 20, 9],
    ],
  );
  for (const piece of got.pieces) assert.ok(piece.bytes > 0);
});

test("the last piece is settled by the muxer's end-of-stream, not left open", async () => {
  const { handlers, got } = capture();
  const muxer = new PieceMuxer([{ kind: "video", codec: "vp8" }], handlers, {
    targetPieceSeconds: 10,
  });
  // Less than one piece's worth: nothing closes until the stream ends.
  for (let second = 0; second < 4; second += 1) {
    muxer.write(0, vp8Frame(second, second, second === 0));
  }
  await settle();
  assert.equal(got.pieces.length, 0);

  await muxer.stop();
  assert.equal(got.pieces.length, 1);
  assert.equal(got.pieces[0].start, 0);
  // The muxer reported 3s of elapsed film across four one-second frames.
  assert.equal(got.pieces[0].duration, 3);
});

test("a codec WebM cannot carry is refused in the open, and stores nothing", async () => {
  const { handlers, got } = capture();
  const muxer = new PieceMuxer([{ kind: "video", codec: "av1x" }], handlers);
  assert.equal(muxer.refusedBecause, "unsupported_codec");
  assert.deepEqual(got.refused, ["unsupported_codec"]);
  muxer.write(0, vp8Frame(0, 0, true));
  await muxer.stop();
  assert.equal(got.inits.length, 0);
  assert.equal(got.pieces.length, 0);
});

test("H.264 is refused instead of being emitted as WebM and labelled MP4", async () => {
  const { handlers, got } = capture();
  const muxer = new PieceMuxer([{ kind: "video", codec: "h264" }], handlers);
  assert.equal(muxer.refusedBecause, "unsupported_codec");
  assert.deepEqual(got.refused, ["unsupported_codec"]);
  await muxer.stop();
  assert.equal(got.inits.length, 0);
  assert.equal(got.pieces.length, 0);
});

test("stopping a muxer that never saw a frame is bounded and quiet", async () => {
  const { handlers, got } = capture();
  const muxer = new PieceMuxer([{ kind: "video", codec: "vp8" }], handlers);
  const startedAt = Date.now();
  await muxer.stop();
  assert.ok(Date.now() - startedAt < 3_000);
  assert.equal(got.pieces.length, 0);
  // Idempotent.
  await muxer.stop();
});
