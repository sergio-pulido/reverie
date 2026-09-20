import { MediaStreamTrack, RTCPeerConnection } from "werift";
import type { DirectorStream } from "./directorStream";

/**
 * Forwards a live director stream to a watching browser.
 *
 * The browser is a peer of THIS SERVER, never of fal. Every frame still
 * arrives here first, is still auditable and can still be recorded — the
 * viewer gets a copy, not a direct line to the provider. That keeps the
 * "everything through the server" rule while letting people watch it happen
 * instead of waiting for a recording.
 *
 * It relays RTP packets and nothing else: no depacketizing, no muxing, no
 * re-encoding. That distinction is the whole reason this is affordable when
 * recording is not — muxing WebM on this thread pinned a core and blocked the
 * event loop (docs/DECISIONS.md), while a relay just copies packets.
 *
 * One fal session fans out to as many viewers as attach to it, which is what
 * makes a shared configuration cost one stream rather than one per person.
 */

const ICE_GATHERING_TIMEOUT_MS = 5_000;

export interface ViewerPeer {
  /** The answer SDP for the browser that asked to watch. */
  answerSdp: string;
  close(): void;
}

export class DirectorViewerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectorViewerError";
  }
}

/**
 * Builds a peer for one viewer and wires the stream's tracks into it.
 *
 * Tracks are forwarded as they arrive, not only the ones present now: a viewer
 * who attaches before fal has sent its first chunk must still get video when
 * it starts.
 */
export async function attachViewer(
  stream: DirectorStream,
  offerSdp: string,
  /** Called once when this viewer's peer goes away, however it goes. */
  onClosed?: () => void,
): Promise<ViewerPeer> {
  const connection = new RTCPeerConnection();
  const forwarders: (() => void)[] = [];
  let announced = false;
  const announceClosed = () => {
    if (announced) return;
    announced = true;
    onClosed?.();
  };

  // A browser that navigates away or crashes never calls the teardown route,
  // and a paid session with nobody watching is the expensive case. The peer
  // state is the only honest signal that a viewer is gone.
  connection.connectionStateChange.subscribe((state) => {
    console.info("director viewer connection", { jamId: stream.jamId, state });
    if (state === "disconnected" || state === "failed" || state === "closed") {
      announceClosed();
    }
  });

  const unsubscribe = stream.onTrackAvailable((inbound) => {
    const outbound = new MediaStreamTrack({ kind: inbound.kind });
    connection.addTrack(outbound);
    let forwarded = false;
    // Pure relay: the packet that arrived is the packet that leaves.
    const disposer = inbound.onReceiveRtp.subscribe((packet) => {
      try {
        outbound.writeRtp(packet);
        if (!forwarded && inbound.kind === "video" && packet.header.marker) {
          forwarded = true;
          console.info("director relay frame arrived and forwarded (RTP frame end)", { jamId: stream.jamId, timestamp: packet.header.timestamp });
        }
      } catch {
        // A viewer whose peer has gone must not take the session's other
        // viewers, or the session itself, down with it.
      }
    });
    forwarders.push(() => disposer.unSubscribe());
  });

  await connection.setRemoteDescription({ type: "offer", sdp: offerSdp });
  const answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);
  await waitForIceGathering(connection);

  const answerSdp = connection.localDescription?.sdp ?? answer.sdp;
  if (!answerSdp) {
    unsubscribe();
    connection.close();
    announced = true; // never attached, so it is not a viewer that left
    throw new DirectorViewerError("The viewer connection produced no answer.");
  }

  return {
    answerSdp,
    close() {
      unsubscribe();
      for (const stop of forwarders) stop();
      connection.close();
      announceClosed();
    },
  };
}

function waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ICE_GATHERING_TIMEOUT_MS);
    connection.iceGatheringStateChange.subscribe((state) => {
      if (state === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
