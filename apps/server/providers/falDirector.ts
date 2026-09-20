import { z } from "zod";
import type { DirectorScriptBeat } from "../../../src/core/directorProtocol";
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

/**
 * How far ahead of the reported frontier the script must already be in fal's
 * hands, in seconds.
 *
 * **Measured, not chosen.** Session `mu9vnsrb-1` (2026-09-20) was configured
 * with the first 30 seconds of a 60-second film and reported chunks at script
 * offsets 0, 10, 20 — and then **0 again**. Given no more script, fal does not
 * wait and does not stop: it wraps to the top and re-renders the opening. The
 * beats handed over at offsets 30 and 45 were accepted (`prompt_applied`, v2
 * and v3) but arrived after it had already wrapped, so the room watched its
 * first thirty seconds twice and never saw the beats it had edited.
 *
 * The planner therefore runs ahead of the offset it reports — it had consumed
 * 30s of script while reporting 20 — so a lead of two chunks is too late by
 * about a chunk. Forty seconds is four reported chunks at the ten-second
 * chunk fal chose, which leaves margin without handing over the whole film.
 */
export const DIRECTOR_HANDOVER_LEAD_SECONDS = 40;
/** `min_memory` / `max_memory` from /info. */
export const DIRECTOR_MIN_MEMORY = 1;
export const DIRECTOR_MAX_MEMORY = 50;
/**
 * fal bills each session at a minimum of 60 seconds of runtime, so an idle
 * open session costs the same as a working one. Every guard in ./director is
 * built around this number, and so is the shortest film a jam may ask for
 * (`TOTAL_MIN_SECONDS`).
 *
 * Verified against the vendor 2026-09-20, because four places in this repo
 * asserted it and none of them said where it came from:
 * https://fal.ai/h3-max-director — "$0.08 / second", minimum "60 seconds",
 * "A session shorter than that still bills $4.80". Removing this floor would
 * not save anything; it would only make our spend figures understate the
 * invoice. A promotional $0.02/s rate ended 2026-09-14, and a "$1.20 minimum"
 * anywhere is that same 60 seconds at the old rate.
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

/** The pixel dimensions of the stream a config asks fal for. */
export interface DirectorFrameSize {
  width: number;
  height: number;
}

/** Lines on the short side, which is what the model's resolution names count. */
const RESOLUTION_SHORT_SIDE: Readonly<Record<DirectorConfig["resolution"], number>> = {
  "480p": 480,
  "768p": 768,
  "1080p": 1080,
};

const ASPECT_TERMS: Readonly<Record<DirectorConfig["aspectRatio"], [number, number]>> = {
  "16:9": [16, 9],
  "9:16": [9, 16],
  "1:1": [1, 1],
};

/**
 * What size frame this configuration asks for.
 *
 * These are the REQUESTED dimensions, not measured output: the true geometry of
 * every frame is carried by the H.264 SPS inside the stream, and nothing here
 * overrides it. They exist because an fMP4 track header has to declare a size
 * before the first frame is written, and a video track declared without one
 * does not merely lose metadata — it hangs the muxer outright. See
 * `apps/server/directorMuxer.ts`.
 *
 * The long side is rounded to an even number of pixels because H.264 codes in
 * macroblocks and odd dimensions are not representable at this level.
 */
export function directorFrameSize(config: {
  resolution: DirectorConfig["resolution"];
  aspectRatio: DirectorConfig["aspectRatio"];
}): DirectorFrameSize {
  const short = RESOLUTION_SHORT_SIDE[config.resolution];
  const [across, down] = ASPECT_TERMS[config.aspectRatio];
  const long = Math.round((short * Math.max(across, down)) / Math.min(across, down) / 2) * 2;
  return across >= down ? { width: long, height: short } : { width: short, height: long };
}

// The beat shape is the control channel's, and `src/core/directorProtocol.ts`
// owns it — a second copy here would be a second answer to what fal takes.
export type { DirectorScriptBeat };

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
export function buildDirectorScript(
  script: JamScript,
  window: { fromSeconds?: number; toSeconds?: number } = {},
): DirectorScriptBeat[] {
  const from = window.fromSeconds ?? 0;
  const to = window.toSeconds ?? Number.POSITIVE_INFINITY;
  const beats: DirectorScriptBeat[] = [];
  let offset = 0;
  for (const scene of script.scenes) {
    for (const portion of scene.portions) {
      const start = offset;
      offset += portion.durationSeconds;
      if (start < from) continue;
      if (start >= to) return beats;
      if (beats.length >= DIRECTOR_MAX_SCRIPT_BEATS) return beats;
      beats.push({ offset: start, prompt: describePortion(portion) });
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
 *
 * **It carries only the beats of the opening window, not the whole film.** A
 * beat fal holds is a beat the room can no longer change: it has been planned
 * from, and an edit landing on it afterwards rewrites the script while the
 * picture goes on following the version fal was given. So the script is handed
 * over a chunk at a time, by `prompt`, as each beat closes to editing — and
 * `configure` carries exactly the first chunk's worth, because that is what
 * fal generates before it has told us anything.
 *
 * `throughSeconds` defaults to the longest chunk the model will produce, which
 * is the only safe assumption before `configured` reports the real length.
 */
export function buildConfigureMessage(
  config: DirectorConfig,
  script: JamScript,
  options: { memory?: number; throughSeconds?: number } = {},
): Record<string, unknown> {
  const memory = clampMemory(options.memory ?? 12);
  return {
    type: "configure",
    protocol_version: 1,
    prompt_version: 1,
    prompt: buildPremise(script),
    script: buildDirectorScript(script, {
      toSeconds: options.throughSeconds ?? DIRECTOR_MAX_CHUNK_SECONDS,
    }),
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
  // The timeout covers the handshake only. The same signal would also abort
  // the response body, and that body is the session's own stream, kept open
  // for as long as the session runs; a timeout on it would end every session
  // at thirty seconds. So it is cleared the moment the answer is in hand.
  const handshake = new AbortController();
  const timer = setTimeout(() => handshake.abort(), START_SESSION_TIMEOUT_MS);
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
      signal: handshake.signal,
    });
  } catch {
    clearTimeout(timer);
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
  let answer: string | null;
  try {
    answer = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? await readAnswerFromEventStream(response)
      : findSdp(await response.json().catch(() => null));
  } finally {
    clearTimeout(timer);
  }
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
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        console.info("director session stream ended by the provider");
        return;
      }
      // Anything the provider says after the answer is worth reading once.
      const text = decoder.decode(value).trim();
      if (text) console.info("director session stream", { frame: text.slice(0, 300) });
    }
  } catch (error) {
    console.info("director session stream closed", { reason: error instanceof Error ? error.message : String(error) });
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
/**
 * Finds the answer's SDP, and only an answer's. A stream may carry other
 * things with an `sdp` field — the offer read back, a status frame — and an
 * offer taken for the answer sets our own description as the remote one,
 * after which ICE checks against itself and never completes. An offer is
 * told by `a=setup:actpass` (only an offerer says so) or by `type: "offer"`.
 */
function findSdp(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sdp === "string" && record.sdp.length > 0) {
    const isOffer = record.type === "offer" || /^a=setup:actpass/m.test(record.sdp);
    if (!isOffer) return record.sdp;
    console.info("director handshake: skipped an sdp that is an offer, not an answer");
  }
  for (const inner of Object.values(record)) {
    const found = findSdp(inner);
    if (found) return found;
  }
  return null;
}
