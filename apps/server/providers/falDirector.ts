import { z } from "zod";
import type { JamScript } from "../../../src/core/script";

/**
 * MiniMax H3 Max Director: a realtime, directable video stream.
 *
 * Unlike the queue models in ./falModels, Director is not submit-poll-download.
 * A session is a WebRTC peer connection: the caller POSTs an SDP offer to
 * `/start-session`, fal answers, and from then on video arrives as a media
 * track while direction travels over a JSON control channel. There is no
 * result URL, so nothing here can be stored as a portion clip.
 *
 * Consequence for this build: the BROWSER is the peer and this module only
 * brokers the handshake, because the server holds FAL_KEY and the browser must
 * never see it. See docs/DECISIONS.md for what that costs us in server
 * authority over individual prompts.
 *
 * Every constant below is the vendor's own, read from the model's published
 * `/info` document. They are not tuning knobs.
 */

const DIRECTOR_BASE_URL = "https://fal.run/minimax/h3-max/director";
const START_SESSION_TIMEOUT_MS = 30_000;
/** Bounds the handshake stream; the answer arrives in its first frames. */
const MAX_EVENT_STREAM_BYTES = 256 * 1024;

export const DIRECTOR_MODEL_SLUG = "minimax/h3-max/director";

/** Chunk duration band, identical to the H3 Max queue model's duration band. */
export const DIRECTOR_MIN_CHUNK_SECONDS = 5;
export const DIRECTOR_MAX_CHUNK_SECONDS = 15;
/** `script_max_beats` from /info. */
export const DIRECTOR_MAX_SCRIPT_BEATS = 64;
/** `min_memory` / `max_memory` from /info. */
export const DIRECTOR_MIN_MEMORY = 1;
export const DIRECTOR_MAX_MEMORY = 50;
/**
 * fal bills each session at a minimum of 60 seconds of runtime, so an idle
 * open session costs the same as a working one. Every guard in ./director is
 * built around this number.
 */
export const DIRECTOR_MIN_BILLED_SECONDS = 60;

export class DirectorError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DirectorError";
  }
}

export interface DirectorConfig {
  apiKey: string;
  resolution: "480p" | "768p" | "1080p";
  aspectRatio: "16:9" | "9:16" | "1:1";
  /**
   * Whether to capture the incoming media track.
   *
   * Off by default, and that default is a measured one: capturing 480p at 24fps
   * drove the Node process to 99% CPU and blocked the event loop outright, so
   * the server stopped answering — including the route that stops the paid
   * session. Depacketizing and muxing RTP on the same thread that serves HTTP
   * does not work. Until that runs off-thread (RV-18), a session that only
   * directs and audits is safe and one that records is not.
   */
  record: boolean;
}

const resolutionSchema = z.enum(["480p", "768p", "1080p"]).catch("768p");
const aspectRatioSchema = z.enum(["16:9", "9:16", "1:1"]).catch("16:9");

/**
 * Director is gated behind its own flag on top of the live flag. It is the
 * most expensive thing this server can start, and REVERIE_LIVE_ENABLED already
 * means "queue generation is allowed" — one flag should not silently buy both.
 */
export function resolveDirectorConfig(
  env: NodeJS.ProcessEnv,
): DirectorConfig | null {
  if (env.REVERIE_LIVE_ENABLED !== "true") return null;
  if (env.REVERIE_DIRECTOR_ENABLED !== "true") return null;
  const apiKey = env.FAL_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    resolution: resolutionSchema.parse(env.REVERIE_DIRECTOR_RESOLUTION?.trim()),
    aspectRatio: aspectRatioSchema.parse(env.REVERIE_DIRECTOR_ASPECT_RATIO?.trim()),
    record: env.REVERIE_DIRECTOR_RECORD === "true",
  };
}

/** One direction on the stream's clock, at a whole-second offset. */
export interface DirectorScriptBeat {
  offset: number;
  prompt: string;
}

/**
 * Projects a jam script onto Director's beat timeline.
 *
 * A portion becomes a beat at its cumulative start offset: the portion's own
 * direction takes over at the second it begins and holds until the next beat.
 * That is exactly how Director describes a script beat, so the jam's structure
 * survives the translation instead of being flattened into one prompt.
 *
 * Beats are capped at DIRECTOR_MAX_SCRIPT_BEATS; a longer script is truncated
 * rather than rejected, because the stream can still be directed live past the
 * last beat.
 */
export function buildDirectorScript(script: JamScript): DirectorScriptBeat[] {
  const beats: DirectorScriptBeat[] = [];
  let offset = 0;
  for (const scene of script.scenes) {
    for (const portion of scene.portions) {
      if (beats.length >= DIRECTOR_MAX_SCRIPT_BEATS) return beats;
      beats.push({ offset, prompt: describePortion(portion) });
      offset += portion.durationSeconds;
    }
  }
  return beats;
}

function describePortion(portion: {
  action: string;
  dialogue?: string;
  visualDirection?: string;
}): string {
  // Model output is data: it is concatenated as prose, never interpolated into
  // anything that could read as an instruction to the server.
  return [portion.visualDirection, portion.action, portion.dialogue]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .slice(0, 50_000);
}

/**
 * The opening `configure` message for a jam's stream.
 *
 * `prompt` is the series premise and persists for the whole session; the
 * script beats direct it moment to moment. `prompt_version` starts at 1 and
 * the client increments it for every later `prompt` message — fal rejects a
 * stale version, which is what keeps two directors from racing.
 */
export function buildConfigureMessage(
  config: DirectorConfig,
  script: JamScript,
  options: { memory?: number } = {},
): Record<string, unknown> {
  const memory = clampMemory(options.memory ?? 12);
  return {
    type: "configure",
    protocol_version: 1,
    prompt_version: 1,
    prompt: buildPremise(script),
    script: buildDirectorScript(script),
    resolution: config.resolution,
    aspect_ratio: config.aspectRatio,
    memory,
  };
}

function clampMemory(memory: number): number {
  return Math.min(
    DIRECTOR_MAX_MEMORY,
    Math.max(DIRECTOR_MIN_MEMORY, Math.round(memory)),
  );
}

function buildPremise(script: JamScript): string {
  return [script.title, script.logline].filter(Boolean).join(". ").slice(0, 50_000);
}

/** The client's SDP offer, forwarded verbatim to fal. */
export const directorOfferSchema = z.object({
  sdp: z.string().min(1).max(64_000),
  type: z.literal("offer").default("offer"),
});

export type DirectorOffer = z.infer<typeof directorOfferSchema>;

/**
 * Exchanges our SDP offer for fal's answer, spending the API key here so it
 * never reaches a client. Returns the answer SDP.
 *
 * `/start-session` answers with **Server-Sent Events**, not JSON: a
 * `text/event-stream` whose first `data:` frame carries `{"sdp": "..."}`.
 * Parsing it as JSON is what produced "the director stream returned an
 * unexpected shape" — the body is valid, it is simply framed. The JSON branch
 * below stays because the endpoint's OpenAPI declares a plain JSON response
 * and may serve one.
 */
export async function startDirectorSession(
  config: DirectorConfig,
  offer: DirectorOffer,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${DIRECTOR_BASE_URL}/start-session`, {
      method: "POST",
      headers: {
        authorization: `Key ${config.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
      },
      body: JSON.stringify({ type: "offer", sdp: offer.sdp }),
      signal: AbortSignal.timeout(START_SESSION_TIMEOUT_MS),
    });
  } catch {
    throw new DirectorError("The director stream did not respond.", true);
  }
  if (!response.ok) {
    // The provider body is not echoed: it can carry request detail we do not
    // want in a client response or a log line.
    throw new DirectorError(
      `The director stream refused the session (status ${response.status}).`,
      response.status === 429 || response.status >= 500,
    );
  }
  const answer = (response.headers.get("content-type") ?? "").includes(
    "text/event-stream",
  )
    ? await readAnswerFromEventStream(response)
    : findSdp(await response.json().catch(() => null));
  if (!answer) {
    throw new DirectorError("The director stream returned no answer.", true);
  }
  return answer;
}

/**
 * Reads `data:` frames until one carries an SDP.
 *
 * Read incrementally and abandoned at the answer rather than buffered whole:
 * the stream may stay open for the session, and waiting for it to end would
 * hang the handshake it is supposed to complete.
 */
async function readAnswerFromEventStream(response: Response): Promise<string | null> {
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (buffered.length < MAX_EVENT_STREAM_BYTES) {
      const { done, value } = await reader.read();
      if (value) buffered += decoder.decode(value, { stream: true });
      // Frames are separated by a blank line; the tail may be incomplete.
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = done ? "" : (frames.pop() ?? "");
      for (const frame of frames) {
        const sdp = findSdp(parseEventData(frame));
        if (sdp) return sdp;
      }
      if (done) return null;
    }
    return null;
  } finally {
    // The handshake has what it needs, but the stream is the session's own
    // heartbeat: closing it tells the provider the caller has gone. It is
    // drained in the background instead, frame by frame and discarded, until
    // the provider ends it.
    void drain(reader);
  }
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  } catch {
    // The provider closed it; nothing to do.
  }
}

/** The JSON payload of one SSE frame, ignoring comments and other fields. */
function parseEventData(frame: string): unknown {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Finds an `sdp` string anywhere in a parsed payload. */
function findSdp(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sdp === "string" && record.sdp.length > 0) return record.sdp;
  for (const inner of Object.values(record)) {
    const found = findSdp(inner);
    if (found) return found;
  }
  return null;
}
