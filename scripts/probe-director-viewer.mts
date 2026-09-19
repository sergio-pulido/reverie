// Bounded live probe of forwarding a director stream to a viewer.
//
//   REVERIE_PROBE_BASE=http://127.0.0.1:4318 \
//     node --import tsx scripts/probe-director-viewer.mts
//
// It opens ONE session against a running server, attaches a viewer the way a
// browser does, and reports how much RTP was relayed, whether the server kept
// answering while media flowed, and whether /end still worked. This costs
// money: fal bills a director session for a minimum of 60 seconds.
//
// It exists because the difference between relaying packets and muxing them is
// the difference between a server that answers and one that does not.

import { RTCPeerConnection } from "werift";

const BASE = process.env.REVERIE_PROBE_BASE?.trim() || "http://127.0.0.1:4318";
const jam = await (await fetch(`${BASE}/api/jams`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    mode: "import",
    source: { kind: "imported-script", scriptTitle: "Watch probe" },
    scriptMarkdown: "A lighthouse keeper opens a door beneath the sea. ".repeat(12).trim(),
  }),
})).json();
const jamId = jam.jam.id;

const opened = await (await fetch(`${BASE}/api/jams/${jamId}/director/session`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
})).json();
if (opened.error) { console.log("open failed:", opened.error); process.exit(1); }
const sid = opened.sessionId;
console.log(`session ${sid}`);

// A browser, standing in for the real one.
const viewer = new RTCPeerConnection();
viewer.addTransceiver("video", { direction: "recvonly" });
viewer.addTransceiver("audio", { direction: "recvonly" });
let packets = 0;
let firstPacketAt = 0;
viewer.onTrack.subscribe((track) => {
  console.log(`viewer received a ${track.kind} track`);
  track.onReceiveRtp.subscribe(() => {
    if (!packets) { firstPacketAt = Date.now(); console.log(`FIRST RTP after ${firstPacketAt - t0}ms`); }
    packets += 1;
  });
});
const offer = await viewer.createOffer();
await viewer.setLocalDescription(offer);
await new Promise<void>((r) => {
  if (viewer.iceGatheringState === "complete") return r();
  const t = setTimeout(r, 5000);
  viewer.iceGatheringStateChange.subscribe((s) => { if (s === "complete") { clearTimeout(t); r(); } });
});

const t0 = Date.now();
const watch = await fetch(`${BASE}/api/jams/${jamId}/director/session/${sid}/watch`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ sdp: viewer.localDescription?.sdp ?? offer.sdp }),
});
const watchBody = await watch.json();
if (!watch.ok) { console.log("watch failed:", watchBody); }
else {
  await viewer.setRemoteDescription({ type: "answer", sdp: watchBody.answer.sdp });
  console.log("viewer connected to the server");
}

// Health while media flows: this is the invariant that failed with muxing.
for (let i = 0; i < 6; i += 1) {
  await new Promise((r) => setTimeout(r, 5000));
  const started = Date.now();
  let code = "TIMEOUT";
  try {
    const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    code = String(h.status);
  } catch { /* stays TIMEOUT */ }
  console.log(`t+${(i + 1) * 5}s health=${code} in ${Date.now() - started}ms, rtp packets=${packets}`);
}

const end = await fetch(`${BASE}/api/jams/${jamId}/director/session/${sid}/end`, {
  method: "POST", signal: AbortSignal.timeout(10000),
}).catch(() => null);
console.log(`end: ${end ? end.status : "TIMEOUT"}`);
viewer.close();
console.log(`total rtp packets forwarded: ${packets}`);
process.exit(0);
