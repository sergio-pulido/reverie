// Bounded live probe of the MiniMax H3 Max Director handshake.
//
//   REVERIE_LIVE_ENABLED=true REVERIE_DIRECTOR_ENABLED=true FAL_KEY=... \
//     node --import tsx scripts/probe-director.mts
//
// It opens ONE session with the real peer this server uses, reports the exact
// shape fal answered with, then stops immediately. This costs money: fal bills
// a director session for a minimum of 60 seconds of runtime whether or not it
// is used. Run it deliberately, not in a loop.
//
// It prints status, content type, top-level keys and value types. It never
// prints the SDP, the answer body or the key.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { RTCPeerConnection } from "werift";
import { startDirectorSession } from "../apps/server/providers/falDirector.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(root, ".env.local"));
} catch {
  // Environment variables may be supplied directly.
}

const apiKey = process.env.FAL_KEY?.trim();
if (!apiKey) {
  console.error("FAL_KEY is not set. Nothing was called.");
  process.exit(1);
}

const BASE = "https://fal.run/minimax/h3-max/director";


const connection = new RTCPeerConnection();
connection.addTransceiver("video", { direction: "recvonly" });
connection.addTransceiver("audio", { direction: "recvonly" });
const control = connection.createDataChannel("fal");

const offer = await connection.createOffer();
await connection.setLocalDescription(offer);
await new Promise<void>((resolve) => {
  if (connection.iceGatheringState === "complete") return resolve();
  const timer = setTimeout(resolve, 5_000);
  connection.iceGatheringStateChange.subscribe((state) => {
    if (state === "complete") {
      clearTimeout(timer);
      resolve();
    }
  });
});

const sdp = connection.localDescription?.sdp ?? offer.sdp;
console.log(`offer: ${sdp.length} chars, ${(sdp.match(/^m=/gm) ?? []).length} media sections`);

const started = Date.now();
let answerSdp: string | null = null;
try {
  // The adapter the server uses, so the probe exercises the real parser.
  answerSdp = await startDirectorSession(
    { apiKey, resolution: "480p", aspectRatio: "16:9" },
    { type: "offer", sdp },
  );
} catch (error) {
  console.log(`handshake failed: ${(error as Error).message}`);
}
console.log(`handshake: ${Date.now() - started}ms`);

console.log(
  `answer sdp: ${answerSdp ? `${answerSdp.length} chars, ${(answerSdp.match(/^m=/gm) ?? []).length} media sections` : "NONE"}`,
);

if (answerSdp) {
  await connection.setRemoteDescription({ type: "answer", sdp: answerSdp });
  console.log("remote description applied; waiting briefly for the channel");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    control.stateChanged.subscribe((state) => {
      console.log(`control channel: ${state}`);
      if (state === "open") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  if (control.readyState === "open") {
    // Stop at once. The session bills a 60-second minimum either way, but
    // leaving it running bills beyond that for nothing.
    control.send(JSON.stringify({ type: "stop" }));
    console.log("sent stop");
  }
}

connection.close();
console.log("closed. this run cost at least one billed minute.");
process.exit(0);
