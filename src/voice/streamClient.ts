import { ensureAccessToken } from "../lib/session";
import { serverMessageSchema, STREAM_LIMITS, STREAM_PATH, type ServerMessage } from "./streamProtocol";

/**
 * The browser end of the live-transcription socket. Frames sent before the socket opens are
 * queued (bounded by one request's worth of audio); anything that goes wrong resolves `finish`
 * as `failed`, so the caller can upload the recording instead. Partials go to `onPartial` for
 * the screen and nowhere else.
 */

export type StreamResult = { kind: "final"; transcript: string; timings: Extract<ServerMessage, { type: "final" }>["timings"] } | { kind: "failed"; code: string };

export type StreamSession = {
  sendPcm: (frame: ArrayBuffer) => void;
  /** Tells the server the viewer stopped; resolves with the final or with a failure. */
  finish: () => Promise<StreamResult>;
  cancel: () => void;
};

/** How long the browser waits for the final after stop, beyond the server's own limit. */
const CLIENT_FINAL_TIMEOUT_MS = STREAM_LIMITS.finalTimeoutMs + 2_000;

export function openStream(onPartial: (text: string) => void): StreamSession {
  let socket: WebSocket | null = null;
  let queued: ArrayBuffer[] = [];
  let queuedBytes = 0;
  let stopRequested = false;
  let settled: StreamResult | null = null;
  let settle: (result: StreamResult) => void = () => undefined;
  const done = new Promise<StreamResult>((resolve) => {
    settle = (result) => {
      if (settled) return;
      settled = result;
      queued = [];
      resolve(result);
    };
  });

  const flush = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const frame of queued) socket.send(frame);
    queued = [];
    if (stopRequested) socket.send(JSON.stringify({ type: "stop" }));
  };

  void (async () => {
    let accessToken: string;
    try {
      accessToken = await ensureAccessToken("Using voice input");
    } catch {
      settle({ kind: "failed", code: "NO_SESSION" });
      return;
    }
    if (settled) return;
    try {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${window.location.host}${STREAM_PATH}`);
    } catch {
      settle({ kind: "failed", code: "SOCKET_UNAVAILABLE" });
      return;
    }
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      socket?.send(JSON.stringify({ type: "start", accessToken }));
      flush();
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let parsed: ServerMessage;
      try {
        parsed = serverMessageSchema.parse(JSON.parse(event.data));
      } catch {
        settle({ kind: "failed", code: "STREAM_INVALID_MESSAGE" });
        socket?.close();
        return;
      }
      if (parsed.type === "partial") onPartial(parsed.text);
      if (parsed.type === "final") settle({ kind: "final", transcript: parsed.transcript, timings: parsed.timings });
      if (parsed.type === "error") settle({ kind: "failed", code: parsed.code });
    });
    socket.addEventListener("close", () => settle({ kind: "failed", code: "STREAM_CLOSED" }));
  })();

  return {
    sendPcm: (frame) => {
      if (settled || stopRequested) return;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(frame);
        return;
      }
      if (queuedBytes + frame.byteLength > STREAM_LIMITS.maxStreamBytes) return;
      queued.push(frame);
      queuedBytes += frame.byteLength;
    },
    finish: () => {
      if (!stopRequested) {
        stopRequested = true;
        // A socket that never opened will not answer in time; the upload goes now instead.
        if (socket?.readyState !== WebSocket.OPEN) {
          settle({ kind: "failed", code: "STREAM_NOT_OPEN" });
          socket?.close();
          return done;
        }
        flush();
        window.setTimeout(() => settle({ kind: "failed", code: "STREAM_TIMEOUT" }), CLIENT_FINAL_TIMEOUT_MS);
      }
      return done;
    },
    cancel: () => {
      settle({ kind: "failed", code: "CANCELLED" });
      socket?.close();
    },
  };
}
