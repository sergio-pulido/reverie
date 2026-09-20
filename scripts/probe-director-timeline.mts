// Bounded live probe of what a Director session actually reports about its
// position on the script's clock.
//
//   REVERIE_LIVE_ENABLED=true REVERIE_DIRECTOR_ENABLED=true FAL_KEY=... \
//     node --import tsx scripts/probe-director-timeline.mts
//
// Why this exists when scripts/probe-director.mts already opens a session:
// that one sends `stop` the instant the control channel opens, so it never
// sees a single `chunk`. Every beat state the Director screen draws comes
// from `chunk.script_offset_seconds`, and docs/DECISIONS.md records that
// field as never observed. This watches the channel for a bounded window and
// reports whether it arrives, what type it carries, and whether the message
// survives `directorServerMessageSchema` — which drops a whole chunk on a
// single field mismatch.
//
// It costs money: fal bills a director session for a minimum of 60 seconds
// whether or not it is used, so the default window spends the minute that is
// already paid for and nothing beyond it. Run it deliberately, not in a loop.
//
// It prints message types, key names and numeric values. It never prints the
// key, the SDP, the configure payload or any prompt text.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";
import {
  buildConfigureMessage,
  resolveDirectorConfig,
  startDirectorSession,
} from "../apps/server/providers/falDirector.ts";
import { directorVideoCodecs, DIRECTOR_AUDIO_CODECS } from "../apps/server/directorStream.ts";
import { directorServerMessageSchema } from "../src/core/directorProtocol.ts";
import { beatOffsets, beatWindow } from "../src/core/directorBeats.ts";
import type { JamScript } from "../src/core/script.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(root, ".env.local"));
} catch {
  // Environment variables may be supplied directly.
}

const config = resolveDirectorConfig(process.env);
if (!config) {
  console.error(
    "Director is not configured. Needs REVERIE_LIVE_ENABLED=true, REVERIE_DIRECTOR_ENABLED=true and FAL_KEY. Nothing was called.",
  );
  process.exit(1);
}

/** Bounded by default to the minute fal bills anyway. */
const WINDOW_MS = Number(process.env.PROBE_WINDOW_SECONDS ?? 60) * 1_000;

/**
 * Twelve 5s beats: the shortest portion the model's band allows, so a 60s
 * window crosses as many beat boundaries as possible. A boundary that is
 * never crossed proves nothing about whether the timeline advances.
 */
const script: JamScript = {
  title: "Probe: the salt door",
  logline: "A lighthouse keeper finds a door at the bottom of the sea.",
  scenes: Array.from({ length: 3 }, (_, sceneIndex) => ({
    heading: `Scene ${sceneIndex + 1}`,
    portions: Array.from({ length: 4 }, (_, portionIndex) => ({
      durationSeconds: 5,
      action: `Scene ${sceneIndex + 1}, portion ${portionIndex + 1}: the keeper descends.`,
      visualDirection: "Slow push in, cold light.",
    })),
  })),
};
const offsets = beatOffsets(script);

console.log(
  `script: ${offsets.length} beats, offsets ${offsets.join(",")}, runtime ${offsets.length * 5}s`,
);
console.log(`window: ${WINDOW_MS / 1_000}s · resolution ${config.resolution} ${config.aspectRatio}`);

/** What the run observed, reported once at the end rather than inferred from the log. */
const seen = {
  messages: 0,
  byType: new Map<string, number>(),
  unparseable: [] as { type: string; issue: string }[],
  chunks: 0,
  withOffset: 0,
  offsetTypes: new Set<string>(),
  offsets: [] as number[],
  playbackSeconds: [] as number[],
  tracks: [] as string[],
};

/** One message's shape: key names and the type of each value, never the values. */
function shapeOf(value: Record<string, unknown>): string {
  return Object.keys(value)
    .sort()
    .map((key) => {
      const held = value[key];
      const type = held === null ? "null" : Array.isArray(held) ? "array" : typeof held;
      return `${key}:${type}`;
    })
    .join(" ");
}

function onMessage(raw: unknown): void {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(Buffer.from(raw as Uint8Array).toString("utf8"));
  } catch {
    console.log("message: not JSON");
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const message = parsed as Record<string, unknown>;
  const type = typeof message.type === "string" ? message.type : "(no type)";
  seen.messages += 1;
  seen.byType.set(type, (seen.byType.get(type) ?? 0) + 1);

  // The production reducer's own gate: a message that fails this is dropped
  // whole by apps/server/directorStream.ts, which is one of the ways the
  // timeline can sit still while video is plainly arriving.
  const check = directorServerMessageSchema.safeParse(message);
  if (!check.success) {
    const issue = check.error.issues
      .map((problem) => `${problem.path.join(".") || "(root)"}: ${problem.message}`)
      .join("; ");
    seen.unparseable.push({ type, issue });
    console.log(`message ${type}: REFUSED BY SCHEMA — ${issue} | shape ${shapeOf(message)}`);
    return;
  }

  if (type !== "chunk") {
    console.log(`message ${type}: ${shapeOf(message)}`);
    return;
  }

  seen.chunks += 1;
  const offset = message.script_offset_seconds;
  const playback = message.playback_seconds;
  if (typeof playback === "number") seen.playbackSeconds.push(playback);
  seen.offsetTypes.add(offset === undefined ? "absent" : offset === null ? "null" : typeof offset);
  if (typeof offset === "number") {
    seen.withOffset += 1;
    seen.offsets.push(offset);
  }
  const window = beatWindow(offsets, typeof offset === "number" ? offset : null);
  console.log(
    `chunk #${String(message.chunk_index)} v${String(message.prompt_version)} ` +
      `playback=${String(playback)}s script_offset=${offset === undefined ? "ABSENT" : String(offset)} ` +
      `→ beat ${window.currentBeatIndex === null ? "none" : window.currentBeatIndex + 1}/${offsets.length}`,
  );
}

// The same codec preference the server negotiates with, so what fal answers
// here is what it would answer in production.
const connection = new RTCPeerConnection({
  codecs: { video: directorVideoCodecs(true), audio: DIRECTOR_AUDIO_CODECS },
});
connection.addTransceiver("video", { direction: "recvonly" });
connection.addTransceiver("audio", { direction: "recvonly" });
const control = connection.createDataChannel("fal");

control.onMessage.subscribe(onMessage);
control.stateChanged.subscribe((state: string) => {
  console.log(`control channel: ${state}`);
  if (state === "open") {
    control.send(JSON.stringify(buildConfigureMessage(config, script)));
    console.log("sent configure");
  }
});
connection.onTrack.subscribe((track: { kind: string; codec?: { mimeType?: string } }) => {
  const line = `${track.kind}/${track.codec?.mimeType ?? "unknown"}`;
  seen.tracks.push(line);
  console.log(`track: ${line}`);
});

const offer = await connection.createOffer();
await connection.setLocalDescription(offer);
await new Promise<void>((resolve) => {
  if (connection.iceGatheringState === "complete") return resolve();
  const timer = setTimeout(resolve, 5_000);
  connection.iceGatheringStateChange.subscribe((state: string) => {
    if (state === "complete") {
      clearTimeout(timer);
      resolve();
    }
  });
});

const started = Date.now();
let answerSdp: string | null = null;
try {
  answerSdp = await startDirectorSession(config, {
    type: "offer",
    sdp: connection.localDescription?.sdp ?? offer.sdp,
  });
} catch (error) {
  console.log(`handshake failed: ${(error as Error).message}`);
}
console.log(`handshake: ${Date.now() - started}ms, answer ${answerSdp ? "received" : "NONE"}`);

if (answerSdp) {
  await connection.setRemoteDescription({ type: "answer", sdp: answerSdp });
  console.log(`watching the control channel for ${WINDOW_MS / 1_000}s…`);
  await new Promise<void>((resolve) => setTimeout(resolve, WINDOW_MS));
  if (control.readyState === "open") {
    control.send(JSON.stringify({ type: "stop" }));
    console.log("sent stop");
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  }
}
connection.close();

// The verdict, stated rather than left to be read out of the log.
console.log("\n=== what this run observed ===");
console.log(`messages: ${seen.messages}`);
for (const [type, count] of [...seen.byType].sort()) console.log(`  ${type}: ${count}`);
console.log(`tracks: ${seen.tracks.length > 0 ? seen.tracks.join(", ") : "NONE"}`);
console.log(
  `schema refusals: ${seen.unparseable.length}${
    seen.unparseable.length > 0
      ? ` — these messages were dropped whole by the production parser:\n    ${seen.unparseable
          .map((refusal) => `${refusal.type}: ${refusal.issue}`)
          .join("\n    ")}`
      : ""
  }`,
);
console.log(`chunks: ${seen.chunks}`);
console.log(
  `playback_seconds: ${
    seen.playbackSeconds.length > 0
      ? `${seen.playbackSeconds.length} values, total ${seen.playbackSeconds.reduce((sum, value) => sum + value, 0)}s`
      : "NONE"
  }`,
);
console.log(
  `script_offset_seconds: ${seen.withOffset}/${seen.chunks} chunks carried one` +
    ` · types seen: ${seen.offsetTypes.size > 0 ? [...seen.offsetTypes].join(",") : "none"}` +
    (seen.offsets.length > 0
      ? ` · values ${Math.min(...seen.offsets)}..${Math.max(...seen.offsets)}` +
        ` · all whole seconds: ${seen.offsets.every(Number.isInteger) ? "yes" : "NO"}`
      : ""),
);
console.log(
  seen.withOffset > 0
    ? "VERDICT: fal reports a script offset. The timeline's existing position source is real."
    : seen.chunks > 0
      ? "VERDICT: chunks arrive WITHOUT a script offset. The timeline can never advance from this signal alone."
      : "VERDICT: no chunk arrived at all. Nothing can be concluded about the offset field.",
);
console.log("this run cost at least one billed minute.");
process.exit(0);
