/**
 * Measures what a beat actually costs in time, against the live models.
 *
 * It generates the same beat twice — once plainly, once seeded by a reference frame — so the
 * two numbers are comparable rather than being read off two different pages of
 * documentation. Nothing it measures is guessed: every figure printed here came back from
 * the provider during the run.
 *
 * It spends real money. It runs only when REVERIE_LIVE_ENABLED=true and FAL_KEY is set, and
 * it generates the shortest clip the models allow.
 *
 *   pnpm probe:beat-video [path/to/frame.jpg]
 *
 * With no frame it synthesises one, which measures latency honestly but says nothing about
 * likeness quality. Pass a real photograph to judge that.
 */

import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import {
  BEAT_MIN_SECONDS,
  BEAT_MODELS,
  describeReferences,
  generateBeatVideo,
  resolveBeatVideoConfig,
  type BeatClip,
  type LikenessFrame,
} from "../apps/server/providers/falBeatVideo.js";

const BEAT = "A person stands at a rain-streaked window in a dim room, turning slowly toward the camera as neon light crosses their face.";

/**
 * A 512x512 PNG of flat colour.
 *
 * The provider refuses a reference below 256x256 (measured: `image_too_small`, minimum
 * 256x256), so a token image will not do even for a latency measurement. This is a real
 * image of the right size and nothing more: it measures how long the round trip takes and
 * says nothing whatever about how well a face survives it.
 */
function synthesiseFrame(): Buffer {
  const size = 512;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = 90 + ((x >> 3) & 31);
      raw[pixel + 1] = 70 + ((y >> 3) & 31);
      raw[pixel + 2] = 120;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function line(label: string, value: string) {
  console.log(`${label.padEnd(34)} ${value}`);
}

function report(name: string, clip: BeatClip, requestedSeconds: number) {
  console.log("");
  console.log(`--- ${name} -------------------------------------`);
  line("model", clip.model);
  line("request id", clip.requestId);
  line("requested duration (s)", String(requestedSeconds));
  line("submit → downloaded clip (s)", (clip.elapsedMs / 1000).toFixed(1));
  line(
    "provider inference (s)",
    clip.providerInferenceSeconds === null ? "not reported" : clip.providerInferenceSeconds.toFixed(1),
  );
  line("clip bytes", clip.bytes.byteLength.toLocaleString("en-GB"));
  line("content type", clip.contentType);
}

async function main() {
  const config = resolveBeatVideoConfig(process.env);
  if (!config) {
    console.error("Set REVERIE_LIVE_ENABLED=true and FAL_KEY before probing. Nothing was spent.");
    process.exitCode = 1;
    return;
  }

  const framePath = process.argv[2];
  const frameBytes = framePath ? await readFile(framePath) : synthesiseFrame();
  const frame: LikenessFrame = {
    assetRef: "likeness:probe",
    contentType: framePath ? "image/jpeg" : "image/png",
    bytes: frameBytes,
  };

  line("resolution", config.resolution);
  line("aspect ratio", config.aspectRatio);
  line("reference frame", framePath ? `${framePath} (${frameBytes.byteLength} bytes)` : `synthesised 512×512 (${frameBytes.byteLength} bytes) — measures latency only`);
  line("plain model", BEAT_MODELS.plain);
  line("likeness model", BEAT_MODELS.likeness);

  const plain = await generateBeatVideo(config, {
    prompt: BEAT,
    durationSeconds: BEAT_MIN_SECONDS,
    frames: [],
  });
  report("plain beat", plain, BEAT_MIN_SECONDS);

  const likeness = await generateBeatVideo(config, {
    prompt: `${describeReferences(1)} ${BEAT}`,
    durationSeconds: BEAT_MIN_SECONDS,
    frames: [frame],
  });
  report("likeness beat", likeness, BEAT_MIN_SECONDS);

  console.log("");
  line(
    "likeness / plain wall clock",
    `${(likeness.elapsedMs / plain.elapsedMs).toFixed(2)}×`,
  );
  console.log("");
  console.log("Cost is not measured here: neither response carries a price. Read the run's");
  console.log("actual charge from the fal dashboard and record it in docs/PROJECT_STATE.md.");
}

main().catch((error: unknown) => {
  const code = (error as { code?: string }).code ?? "unknown";
  const message = (error as { message?: string }).message ?? String(error);
  console.error(`Probe failed (${code}): ${message}`);
  process.exitCode = 1;
});
