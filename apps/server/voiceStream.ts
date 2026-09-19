import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { isSignedIn, type DiscoverEndpointOptions } from "../../api/_lib/discover-http";
import { clientKey, createRateLimiter, isSameOrigin, requestUrl } from "../../api/_lib/http";
import { MAX_MESSAGE_CHARS } from "../../src/conversation/decision";
import { clientMessageSchema, STREAM_LIMITS, STREAM_PATH, type ServerMessage } from "../../src/voice/streamProtocol";
import {
  finalText,
  hear,
  NOTHING_HEARD,
  parseUpstreamEvent,
  resolveSlngConfig,
  shownText,
  SlngError,
  STREAM_INIT,
  sttUrl,
  type HeardSoFar,
  type SlngConfig,
} from "./providers/slng";

/**
 * Live transcription relay: the browser streams PCM to us, we stream it to SLNG with the key the
 * browser never sees, and send back what SLNG hears. It runs on the long-lived Node server only;
 * a host without it (Vercel functions) refuses the socket and the browser uploads the recording
 * instead.
 *
 * Audio passing through here is the viewer's media contribution, used only to produce the
 * transcript. Frames are forwarded as they arrive and never stored, buffered beyond the moment
 * SLNG's socket opens, or logged.
 */

export interface Upstream {
  send: (data: Buffer | string) => void;
  close: () => void;
}
export type UpstreamHandlers = { onOpen: () => void; onMessage: (text: string) => void; onClose: () => void };
export type ConnectUpstream = (handlers: UpstreamHandlers) => Upstream;

export type VoiceStreamOptions = DiscoverEndpointOptions & {
  /** Replaces the SLNG socket resolved from the environment; null means "not configured". */
  connectUpstream?: ConnectUpstream | null;
  model?: string;
};

const CONNECTIONS_PER_MINUTE = 20;
const MAX_CONCURRENT_SESSIONS = 4;
const SILENCE_CHUNK_BYTES = 3_200;

function slngUpstream(config: SlngConfig): ConnectUpstream {
  return (handlers) => {
    const socket = new WebSocket(sttUrl(config, "wss"), {
      headers: { authorization: `Bearer ${config.apiKey}` },
      handshakeTimeout: STREAM_LIMITS.upstreamOpenTimeoutMs,
    });
    socket.on("open", handlers.onOpen);
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) handlers.onMessage(data.toString());
    });
    // An error is always followed by close, which is where the session learns of it.
    socket.on("error", () => undefined);
    socket.on("close", handlers.onClose);
    return {
      send: (data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
      },
      close: () => socket.terminate(),
    };
  };
}

type Resolved = { connect: ConnectUpstream; model: string } | { code: string; safeMessage: string };

function resolveUpstream(options: VoiceStreamOptions): Resolved {
  if (options.connectUpstream !== undefined) {
    return options.connectUpstream
      ? { connect: options.connectUpstream, model: options.model ?? "test" }
      : { code: "VOICE_DISABLED", safeMessage: "Voice input is not switched on here." };
  }
  try {
    const config = resolveSlngConfig(options.env ?? process.env);
    if (!config) return { code: "VOICE_DISABLED", safeMessage: "Voice input is not switched on here." };
    return { connect: slngUpstream(config), model: config.model };
  } catch (error) {
    if (error instanceof SlngError) return { code: "VOICE_MISCONFIGURED", safeMessage: "Voice input is not set up correctly on the server." };
    throw error;
  }
}

/** One browser socket, from its start message to its final answer. */
function runSession(client: WebSocket, options: VoiceStreamOptions, onEnd: () => void) {
  const now = options.now ?? Date.now;
  let phase: "awaiting-start" | "authorizing" | "streaming" | "stopping" | "done" = "awaiting-start";
  let upstream: Upstream | null = null;
  let upstreamOpen = false;
  const queued: Buffer[] = [];
  let heard: HeardSoFar = NOTHING_HEARD;
  let audioBytes = 0;
  let firstAudioAt: number | null = null;
  let firstPartialAt: number | null = null;
  let stopAt = 0;
  /** Seconds of the viewer's audio sent before stop; the silence after it does not count. */
  let spokenSeconds = 0;
  let settleTimer: NodeJS.Timeout | null = null;
  const timers: NodeJS.Timeout[] = [];
  // Read through a function: the phase changes across awaits, which narrowing cannot see.
  const currentPhase = () => phase;

  const reply = (message: ServerMessage) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  const end = () => {
    if (phase === "done") return;
    phase = "done";
    timers.forEach(clearTimeout);
    if (settleTimer) clearTimeout(settleTimer);
    queued.length = 0;
    upstream?.close();
    if (client.readyState === WebSocket.OPEN) client.close(1000);
    onEnd();
  };
  const fail = (code: string, safeMessage: string) => {
    if (phase === "done") return;
    reply({ type: "error", code, safeMessage });
    end();
  };
  const finish = () => {
    if (phase === "done") return;
    reply({
      type: "final",
      transcript: finalText(heard).slice(0, MAX_MESSAGE_CHARS).trim(),
      timings: {
        firstPartialMs: firstPartialAt !== null && firstAudioAt !== null ? Math.max(0, firstPartialAt - firstAudioAt) : null,
        stopToFinalMs: Math.max(0, now() - stopAt),
        audioBytes,
      },
    });
    end();
  };
  const forward = (frame: Buffer) => {
    if (upstreamOpen) upstream?.send(frame);
    else queued.push(frame);
  };

  timers.push(setTimeout(() => phase === "awaiting-start" && fail("STREAM_NO_START", "The stream did not start."), STREAM_LIMITS.startTimeoutMs));
  timers.push(setTimeout(() => fail("STREAM_TOO_LONG", "The stream ran past its time limit."), STREAM_LIMITS.maxSessionMs));

  const onUpstreamMessage = (text: string) => {
    const event = parseUpstreamEvent(text);
    if (event.kind === "other") return;
    if (event.kind !== "results") {
      fail("STREAM_UPSTREAM", "The speech service stopped the stream.");
      return;
    }
    heard = hear(heard, event);
    if (event.transcript && firstPartialAt === null) firstPartialAt = now();
    const shown = shownText(heard);
    if (shown) reply({ type: "partial", text: shown.slice(0, 2_000) });
    if (phase !== "stopping") return;
    // Done when nothing is pending and SLNG has either closed the utterance or heard past the
    // point where the viewer stopped.
    const heardItAll = event.heardUntil !== null && event.heardUntil >= spokenSeconds;
    if (!heard.partial && (event.speechFinal || heardItAll)) {
      finish();
      return;
    }
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => !heard.partial && finish(), STREAM_LIMITS.settleMs);
  };

  const start = async (accessToken: string) => {
    phase = "authorizing";
    const resolved = resolveUpstream(options);
    if ("code" in resolved) {
      fail(resolved.code, resolved.safeMessage);
      return;
    }
    let signedIn = false;
    try {
      signedIn = await isSignedIn(accessToken, options);
    } catch {
      signedIn = false;
    }
    if (currentPhase() === "done") return;
    if (!signedIn) {
      fail("UNAUTHENTICATED", "Sign in to use voice input.");
      return;
    }
    if (currentPhase() === "authorizing") phase = "streaming";
    upstream = resolved.connect({
      onOpen: () => {
        upstreamOpen = true;
        upstream?.send(JSON.stringify(STREAM_INIT));
        for (const frame of queued.splice(0)) upstream?.send(frame);
        reply({ type: "ready", model: resolved.model });
      },
      onMessage: onUpstreamMessage,
      onClose: () => {
        if (phase === "done") return;
        if (phase === "stopping" && !heard.partial && heard.finals.length > 0) finish();
        else fail("STREAM_UPSTREAM", "The speech service closed the stream.");
      },
    });
  };

  const stop = () => {
    if (phase !== "streaming" && phase !== "authorizing") return;
    phase = "stopping";
    stopAt = now();
    spokenSeconds = audioBytes / STREAM_LIMITS.bytesPerSecond;
    if (audioBytes === 0) {
      finish();
      return;
    }
    // SLNG ends an utterance on silence, not on request: give it some.
    const silence = Buffer.alloc(SILENCE_CHUNK_BYTES);
    for (let sent = 0; sent < (STREAM_LIMITS.trailingSilenceMs / 1_000) * STREAM_LIMITS.bytesPerSecond; sent += SILENCE_CHUNK_BYTES) forward(silence);
    timers.push(
      setTimeout(() => {
        if (!heard.partial) finish();
        else fail("STREAM_NO_FINAL", "The speech service did not finish in time.");
      }, STREAM_LIMITS.finalTimeoutMs),
    );
  };

  client.on("message", (data: RawData, isBinary: boolean) => {
    if (phase === "done") return;
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (isBinary) {
      if (phase !== "authorizing" && phase !== "streaming") return;
      if (buffer.length > STREAM_LIMITS.maxFrameBytes || audioBytes + buffer.length > STREAM_LIMITS.maxStreamBytes) {
        fail("STREAM_TOO_LARGE", "The stream sent more audio than one request may hold.");
        return;
      }
      audioBytes += buffer.length;
      if (firstAudioAt === null) firstAudioAt = now();
      forward(buffer);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      fail("INVALID_REQUEST", "That message was not valid.");
      return;
    }
    const message = clientMessageSchema.safeParse(parsed);
    if (!message.success) {
      fail("INVALID_REQUEST", "That message was not valid.");
      return;
    }
    if (message.data.type === "start") {
      if (phase === "awaiting-start") void start(message.data.accessToken);
    } else {
      stop();
    }
  });
  client.on("close", end);
  client.on("error", end);
}

function refuse(socket: Duplex, status: number, reason: string) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Serves `/api/voice/stream` on the given HTTP server. Other upgrade paths are left alone. */
export function attachVoiceStream(server: Server, options: VoiceStreamOptions = {}) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: STREAM_LIMITS.maxFrameBytes });
  const allow = createRateLimiter(CONNECTIONS_PER_MINUTE, 60_000);
  let active = 0;

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (requestUrl(request).pathname !== STREAM_PATH) return;
    if (!isSameOrigin(request)) return refuse(socket, 403, "Forbidden");
    if (!allow(clientKey(request))) return refuse(socket, 429, "Too Many Requests");
    if (active >= MAX_CONCURRENT_SESSIONS) return refuse(socket, 503, "Service Unavailable");
    sockets.handleUpgrade(request, socket, head, (client) => {
      active += 1;
      let ended = false;
      runSession(client, options, () => {
        if (ended) return;
        ended = true;
        active -= 1;
      });
    });
  });
  return sockets;
}
