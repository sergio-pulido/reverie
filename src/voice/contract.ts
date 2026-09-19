import { z } from "zod";
import { MAX_MESSAGE_CHARS } from "../conversation/decision";

/**
 * Wire shape of `POST /api/voice/transcribe`. The browser uploads one recording of the viewer
 * speaking; the server returns the final transcript and nothing else. A transcript only ever
 * becomes text in the conversation field, where the viewer reads and sends it themselves.
 */

export const VOICE_LIMITS = {
  /** One Discover request, said out loud. Recording stops by itself at this length. */
  maxRecordingSeconds: 20,
  /** 20 s of Opus at 32 kbps is about 80 KB; the cap leaves room for a browser that ignores the bitrate. */
  maxUploadBytes: 1_000_000,
  /** The whole server-side transcription call, provider included. */
  requestTimeoutMs: 15_000,
  /** How long the browser waits for the microphone to open, prompt included. */
  microphoneOpenMs: 15_000,
  /** The browser gives up a little after the server would have. */
  clientTimeoutMs: 18_000,
} as const;

/** Containers the browser's recorder produces and the speech model accepts. */
export const VOICE_CONTENT_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"] as const;
export type VoiceContentType = (typeof VOICE_CONTENT_TYPES)[number];

/** The media type without parameters, when it is one we accept. */
export function acceptedContentType(header: string | undefined | null): VoiceContentType | null {
  const base = header?.split(";")[0]?.trim().toLowerCase();
  return VOICE_CONTENT_TYPES.find((type) => type === base) ?? null;
}

export const voiceOkSchema = z.object({
  status: z.literal("ok"),
  transcript: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  /** Length of the audio the model heard, as it reported it. */
  audioSeconds: z.number().nonnegative().nullable(),
  model: z.string().max(80),
  /** Time the provider call took on the server, for the latency receipt. */
  providerMs: z.number().int().nonnegative(),
});

/** The model heard the audio and found no words in it. Not an error, and never a turn. */
export const voiceEmptySchema = z.object({
  status: z.literal("empty"),
  safeMessage: z.string().max(240),
});

export const voiceUnavailableCodes = ["VOICE_DISABLED", "VOICE_MISCONFIGURED", "VOICE_BUSY", "VOICE_TIMEOUT", "VOICE_FAILED"] as const;

export const voiceUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  code: z.enum(voiceUnavailableCodes),
  safeMessage: z.string().max(240),
});

export const voiceErrorSchema = z.object({
  status: z.literal("error"),
  code: z.string().max(64),
  safeMessage: z.string().max(240),
  retryable: z.boolean(),
});

export const voiceResponseSchema = z.discriminatedUnion("status", [voiceOkSchema, voiceEmptySchema, voiceUnavailableSchema, voiceErrorSchema]);

export type VoiceOk = z.infer<typeof voiceOkSchema>;
export type VoiceUnavailable = z.infer<typeof voiceUnavailableSchema>;
export type VoiceResponse = z.infer<typeof voiceResponseSchema>;
