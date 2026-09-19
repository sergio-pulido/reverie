import { z } from "zod";
import { MAX_MESSAGE_CHARS } from "../conversation/decision";
import { VOICE_LIMITS } from "./contract";

/**
 * The live-transcription socket between the browser and our server (`/api/voice/stream`). The
 * browser streams 16 kHz mono 16-bit PCM as binary frames; the server relays it to SLNG and sends
 * back what it hears. Partials are for the screen only. Only `final` carries text that may go in
 * the conversation field, and even that is never sent as a turn by anything but the viewer.
 */

export const STREAM_PATH = "/api/voice/stream";

export const STREAM_LIMITS = {
  /** SLNG accepts only linear16 on this route; 16 kHz mono is what the model is tuned for. */
  sampleRate: 16_000,
  bytesPerSecond: 32_000,
  /** One frame of about 100 ms; anything much bigger is refused. */
  maxFrameBytes: 16_384,
  /** The whole recording plus the silence appended at the end. */
  maxStreamBytes: (VOICE_LIMITS.maxRecordingSeconds + 2) * 32_000,
  /** The first message, carrying the viewer's token, must arrive within this. */
  startTimeoutMs: 5_000,
  /** Opening the upstream socket. */
  upstreamOpenTimeoutMs: 5_000,
  /** Silence appended after stop, so SLNG's endpointing closes the utterance. */
  trailingSilenceMs: 700,
  /** After stop: the final should follow the silence within this, or the browser falls back. */
  finalTimeoutMs: 3_000,
  /** After stop, with nothing pending, this long without new results means it is all in. */
  settleMs: 1_200,
  /** A socket lives no longer than a recording and its answer. */
  maxSessionMs: (VOICE_LIMITS.maxRecordingSeconds + 8) * 1_000,
} as const;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start"), accessToken: z.string().min(1).max(4_096) }),
  z.strictObject({ type: z.literal("stop") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), model: z.string().max(80) }),
  /** What has been heard so far. Display only: never a turn, never the field. */
  z.object({ type: z.literal("partial"), text: z.string().max(2_000) }),
  z.object({
    type: z.literal("final"),
    /** Empty when no words were heard. */
    transcript: z.string().max(MAX_MESSAGE_CHARS),
    timings: z.object({
      /** From the first audio frame reaching the server to the first partial from SLNG. */
      firstPartialMs: z.number().int().nonnegative().nullable(),
      /** From the stop message reaching the server to the final being ready. */
      stopToFinalMs: z.number().int().nonnegative(),
      audioBytes: z.number().int().nonnegative(),
    }),
  }),
  /** The stream cannot give an answer; the browser falls back to uploading the recording. */
  z.object({ type: z.literal("error"), code: z.string().max(64), safeMessage: z.string().max(240) }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
