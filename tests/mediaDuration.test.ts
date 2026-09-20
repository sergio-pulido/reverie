import assert from "node:assert/strict";
import { test } from "node:test";
import { readMp4DurationSeconds } from "../src/core/mediaDuration";

/**
 * The parser is exercised against files built here rather than against a
 * stored clip: what matters is that it reads the header correctly and answers
 * `null` rather than a guess for anything it cannot read.
 */

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.byteLength + 8, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const payload = Buffer.alloc(100);
  payload.writeUInt8(0, 0); // version
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  return box("mvhd", payload);
}

function mvhdV1(timescale: number, duration: bigint): Buffer {
  const payload = Buffer.alloc(112);
  payload.writeUInt8(1, 0);
  payload.writeUInt32BE(timescale, 20);
  payload.writeBigUInt64BE(duration, 24);
  return box("mvhd", payload);
}

function file(...boxes: Buffer[]): Uint8Array {
  return new Uint8Array(Buffer.concat([box("ftyp", Buffer.from("isom")), ...boxes]));
}

test("a 32-bit header gives the duration the file declares", () => {
  const bytes = file(box("moov", mvhdV0(600, 9_062)));
  assert.equal(readMp4DurationSeconds(bytes)?.toFixed(3), "15.103");
});

test("a 64-bit header is read too", () => {
  const bytes = file(box("moov", mvhdV1(90_000, 466_560n)));
  assert.equal(readMp4DurationSeconds(bytes), 5.184);
});

test("mvhd is found after other boxes inside moov", () => {
  const bytes = file(box("moov", Buffer.concat([box("free", Buffer.alloc(32)), mvhdV0(1_000, 5_184)])));
  assert.equal(readMp4DurationSeconds(bytes), 5.184);
});

test("anything unreadable answers null rather than a guess", () => {
  assert.equal(readMp4DurationSeconds(new Uint8Array(0)), null);
  assert.equal(readMp4DurationSeconds(new Uint8Array([1, 2, 3])), null);
  assert.equal(readMp4DurationSeconds(file(box("mdat", Buffer.alloc(16)))), null, "no moov");
  assert.equal(readMp4DurationSeconds(file(box("moov", Buffer.alloc(16)))), null, "no mvhd");
  assert.equal(readMp4DurationSeconds(file(box("moov", mvhdV0(0, 9_062)))), null, "no timescale");
  assert.equal(readMp4DurationSeconds(file(box("moov", mvhdV0(600, 0)))), null, "unknown length");
});

test("a box claiming to run past the end of the file stops the walk", () => {
  const bytes = Buffer.concat([box("moov", mvhdV0(600, 9_062))]);
  bytes.writeUInt32BE(bytes.byteLength + 64, 0);
  assert.equal(readMp4DurationSeconds(new Uint8Array(bytes)), null);
});
