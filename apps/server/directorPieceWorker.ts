import { parentPort } from "node:worker_threads";
import { PieceMuxer, type PieceTrack } from "./directorPieceMuxer";

/**
 * The piece muxer's thread.
 *
 * Everything expensive about storing a stream happens here: jitter buffering,
 * depacketizing and muxing to WebM. None of it may happen on the thread that
 * serves HTTP — a blocked event loop stops the route that ends the paid
 * session, and a server that cannot answer is a server that cannot stop
 * spending (docs/DECISIONS.md).
 *
 * What crosses the boundary is small and one-directional in cost: serialized
 * RTP in, finished pieces out. Nothing here touches a socket or a peer.
 */

export type PieceWorkerCommand =
  | { type: "open"; tracks: PieceTrack[]; targetPieceSeconds: number }
  | { type: "rtp"; track: number; packet: Uint8Array }
  | { type: "stop" };

export type PieceWorkerEvent =
  | { type: "init"; bytes: Uint8Array; codec: string }
  | {
      type: "piece";
      index: number;
      bytes: Uint8Array;
      startSeconds: number;
      durationSeconds: number;
    }
  | { type: "refused"; reason: string }
  | { type: "stopped" };

const port = parentPort;
let muxer: PieceMuxer | null = null;

function post(event: PieceWorkerEvent): void {
  port?.postMessage(event);
}

port?.on("message", (command: PieceWorkerCommand) => {
  switch (command.type) {
    case "open":
      if (muxer) return;
      muxer = new PieceMuxer(
        command.tracks,
        {
          onInit: (bytes, codec) => post({ type: "init", bytes, codec }),
          onPiece: (index, bytes, startSeconds, durationSeconds) =>
            post({ type: "piece", index, bytes, startSeconds, durationSeconds }),
          onRefused: (reason) => post({ type: "refused", reason }),
        },
        { targetPieceSeconds: command.targetPieceSeconds },
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
        .finally(() => post({ type: "stopped" }));
      return;
    }
  }
});
