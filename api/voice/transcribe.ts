import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveSlngConfig, SlngError, transcribe, type SlngConfig, type Transcription } from "../../apps/server/providers/slng";
import { MAX_MESSAGE_CHARS } from "../../src/conversation/decision";
import { acceptedContentType, VOICE_LIMITS, type VoiceOk, type VoiceUnavailable } from "../../src/voice/contract";
import { abortOnDisconnect, admit, createGuard, fail, isSignedIn, readAccessToken, type DiscoverEndpointOptions } from "../_lib/discover-http";
import { sendJson } from "../_lib/http";

const REQUESTS_PER_MINUTE = 20;
const MAX_CONCURRENT_CALLS = 4;
const allowRequest = createGuard(REQUESTS_PER_MINUTE);
let activeCalls = 0;

export type Transcriber = {
  model: string;
  transcribe: (audio: Uint8Array, contentType: string, signal: AbortSignal) => Promise<Transcription>;
};

export type VoiceEndpointOptions = DiscoverEndpointOptions & {
  /** Replaces the SLNG adapter resolved from the environment; null means "not configured". */
  transcriber?: Transcriber | null;
};

const UNAVAILABLE_MESSAGES: Record<VoiceUnavailable["code"], string> = {
  VOICE_DISABLED: "Voice input is not switched on here.",
  VOICE_MISCONFIGURED: "Voice input is not set up correctly on the server.",
  VOICE_BUSY: "Voice input is busy right now.",
  VOICE_TIMEOUT: "The speech service did not answer in time.",
  VOICE_FAILED: "The speech service could not transcribe that recording.",
};

function unavailable(code: VoiceUnavailable["code"]): VoiceUnavailable {
  return { status: "unavailable", code, safeMessage: UNAVAILABLE_MESSAGES[code] };
}

function resolveTranscriber(options: VoiceEndpointOptions): Transcriber | VoiceUnavailable {
  if (options.transcriber !== undefined) return options.transcriber ?? unavailable("VOICE_DISABLED");
  let config: SlngConfig | null;
  try {
    config = resolveSlngConfig(options.env ?? process.env);
  } catch (error) {
    if (error instanceof SlngError) return unavailable("VOICE_MISCONFIGURED");
    throw error;
  }
  if (!config) return unavailable("VOICE_DISABLED");
  const resolved = config;
  return {
    model: resolved.model,
    transcribe: (audio, contentType, signal) => transcribe(resolved, { audio, contentType, signal, timeoutMs: VOICE_LIMITS.requestTimeoutMs }),
  };
}

class TooLarge extends Error {}

/** Reads the raw audio body up to `maxBytes`; a larger body is refused rather than buffered. */
async function readAudio(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > maxBytes) throw new TooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Speech to text for Discover. The body is one recording of the viewer speaking; the answer is
 * the final transcript, which the browser puts in the conversation field for the viewer to read,
 * correct and send. This endpoint never makes a turn.
 *
 * The recording is the viewer's media contribution, used only to produce that transcript: it is
 * held in memory for the length of the call, forwarded to SLNG, and dropped. It is never stored
 * or logged, here or in the adapter.
 */
export default async function voiceTranscribe(request: IncomingMessage, response: ServerResponse, options: VoiceEndpointOptions = {}) {
  if (!admit(request, response, allowRequest)) return;

  const accessToken = readAccessToken(request);
  if (!accessToken) {
    fail(response, 401, "UNAUTHENTICATED", "Sign in to use voice input.");
    return;
  }
  const contentType = acceptedContentType(request.headers["content-type"]);
  if (!contentType) {
    fail(response, 415, "UNSUPPORTED_AUDIO", "That recording format is not supported.");
    return;
  }
  const declaredLength = Number(request.headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > VOICE_LIMITS.maxUploadBytes) {
    fail(response, 413, "RECORDING_TOO_LARGE", "That recording is too long.");
    return;
  }

  const transcriber = resolveTranscriber(options);
  if ("status" in transcriber) {
    sendJson(response, 200, transcriber);
    return;
  }
  if (!(await isSignedIn(accessToken, options))) {
    fail(response, 401, "UNAUTHENTICATED", "Sign in to use voice input.");
    return;
  }

  let audio: Uint8Array;
  try {
    audio = await readAudio(request, VOICE_LIMITS.maxUploadBytes);
  } catch (error) {
    if (error instanceof TooLarge) fail(response, 413, "RECORDING_TOO_LARGE", "That recording is too long.");
    else fail(response, 400, "INVALID_REQUEST", "That request was not valid.");
    return;
  }
  if (audio.length === 0) {
    fail(response, 400, "EMPTY_RECORDING", "The recording was empty.");
    return;
  }

  if (activeCalls >= MAX_CONCURRENT_CALLS) {
    sendJson(response, 200, unavailable("VOICE_BUSY"));
    return;
  }
  activeCalls += 1;
  const signal = abortOnDisconnect(response);
  const startedAt = (options.now ?? Date.now)();
  try {
    const result = await transcriber.transcribe(audio, contentType, signal);
    if (!result.transcript) {
      sendJson(response, 200, { status: "empty", safeMessage: "No words were heard in that recording." });
      return;
    }
    const payload: VoiceOk = {
      status: "ok",
      transcript: result.transcript.slice(0, MAX_MESSAGE_CHARS).trim(),
      audioSeconds: result.audioSeconds,
      model: transcriber.model,
      providerMs: Math.max(0, Math.round((options.now ?? Date.now)() - startedAt)),
    };
    sendJson(response, 200, payload);
  } catch (error) {
    if (!(error instanceof SlngError)) throw error;
    sendJson(response, 200, unavailable(error.kind === "timeout" ? "VOICE_TIMEOUT" : "VOICE_FAILED"));
  } finally {
    activeCalls -= 1;
  }
}
