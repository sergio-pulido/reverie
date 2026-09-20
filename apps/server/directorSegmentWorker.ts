import { parentPort } from "node:worker_threads";
import { SegmentMuxer, type MuxTrack } from "./directorMuxer";

/**
 * The muxer's thread.
 *
 * Everything expensive about live delivery happens here: jitter buffering,
 * depacketizing, and muxing to fMP4. None of it may happen on the thread that
 * serves HTTP, because a blocked event loop stops the route that ends the paid
 * session — and a server that cannot answer is a server that cannot stop
 * spending (docs/DECISIONS.md).
 *
 * What crosses the boundary is small and one-directional in cost: serialized
 * RTP in, finished segments out. Nothing here touches a socket or a peer.
 */

export type SegmentWorkerCommand =
  | { type: "open"; tracks: MuxTrack[]; targetSegmentSeconds: number }
  | { type: "rtp"; track: number; packet: Uint8Array }
  | { type: "stop" };

export type SegmentWorkerEvent =
  | { type: "init"; bytes: Uint8Array; codec: string }
  | {
      type: "segment";
      index: number;
      bytes: Uint8Array;
      startSeconds: number;
      durationSeconds: number;
    }
  | { type: "refused"; reason: string }
  | { type: "stopped" };

const port = parentPort;
let muxer: SegmentMuxer | null = null;

function post(event: SegmentWorkerEvent): void {
  port?.postMessage(event);
}

port?.on("message", (command: SegmentWorkerCommand) => {
  switch (command.type) {
    case "open":
      if (muxer) return;
      muxer = new SegmentMuxer(
        command.tracks,
        {
          onInit: (bytes, codec) => post({ type: "init", bytes, codec }),
          onSegment: (index, bytes, startSeconds, durationSeconds) =>
            post({ type: "segment", index, bytes, startSeconds, durationSeconds }),
          onRefused: (reason) => post({ type: "refused", reason }),
        },
        { targetSegmentSeconds: command.targetSegmentSeconds },
      );
      return;
    case "rtp":
      muxer?.write(command.track, Buffer.from(command.packet));
      return;
    case "stop": {
      const closing = muxer;
      muxer = null;
      void Promise.resolve(closing?.stop())
        .catch(() => undefined)
        .then(() => {
          // The last segments are posted by `stop` before this lands, so the
          // main thread can close the playlist knowing it has them all.
          post({ type: "stopped" });
        });
      return;
    }
  }
});
