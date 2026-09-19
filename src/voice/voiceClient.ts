import { JamError } from "../lib/errors";
import { ensureAccessToken } from "../lib/session";
import { VOICE_LIMITS, voiceResponseSchema, type VoiceResponse } from "./contract";

const UNREADABLE: VoiceResponse = {
  status: "error",
  code: "VOICE_INVALID_RESPONSE",
  safeMessage: "Voice input sent a response Discover could not trust.",
  retryable: false,
};

/**
 * Uploads one recording as the viewer's own session and returns the parsed answer, or null
 * when the server could not be reached in time. An unexpected shape is an explicit error.
 */
export async function requestTranscript(audio: Blob): Promise<VoiceResponse | null> {
  let accessToken: string;
  try {
    accessToken = await ensureAccessToken("Using voice input");
  } catch (error) {
    if (error instanceof JamError) return { status: "error", code: "VOICE_NO_SESSION", safeMessage: error.safeMessage.slice(0, 240), retryable: error.retryable };
    return null;
  }
  try {
    const response = await fetch("/api/voice/transcribe", {
      method: "POST",
      signal: AbortSignal.timeout(VOICE_LIMITS.clientTimeoutMs),
      headers: { Accept: "application/json", "Content-Type": audio.type || "audio/webm", Authorization: `Bearer ${accessToken}` },
      body: audio,
    });
    const parsed = voiceResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : UNREADABLE;
  } catch {
    return null;
  }
}
