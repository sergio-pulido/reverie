import { MAX_MESSAGE_CHARS } from "../conversation/decision";
import type { VoiceResponse } from "./contract";
import type { StreamResult } from "./streamClient";

/**
 * The voice control's states, and what each outcome means for the conversation field. Only a
 * final transcript ever reaches the field; nothing here sends a turn.
 */
export type VoicePhase = "idle" | "starting" | "recording" | "transcribing";

/** Why the microphone could not start, as the recorder reports it. */
export type MicrophoneFailure = "unsupported" | "denied" | "no-device" | "busy" | "timeout" | "unknown";

export const MICROPHONE_MESSAGES: Record<MicrophoneFailure, string> = {
  unsupported: "This browser cannot record here. Type what you want instead.",
  denied: "Microphone access was refused. Type what you want instead, or allow the microphone and try again.",
  "no-device": "No microphone was found. Type what you want instead.",
  busy: "The microphone is in use by something else. Type what you want instead.",
  timeout: "The microphone did not open. Type what you want instead, or try again.",
  unknown: "The microphone could not start. Type what you want instead.",
};

const FALLBACK = "Type what you want instead.";

/** What the conversation field should do with one transcription answer. */
export type VoiceOutcome = { kind: "text"; text: string } | { kind: "notice"; message: string };

/**
 * Turns an answer from the transcription endpoint (or null, when it could not be reached) into
 * either text for the field or a plain notice. An empty or blank transcript is a notice, never text.
 */
export function outcomeOf(response: VoiceResponse | null): VoiceOutcome {
  if (!response) return { kind: "notice", message: `Voice input could not reach the server. ${FALLBACK}` };
  switch (response.status) {
    case "ok": {
      const text = response.transcript.trim();
      return text ? { kind: "text", text } : { kind: "notice", message: `Nothing was heard. Try again, or type it.` };
    }
    case "empty":
      return { kind: "notice", message: `Nothing was heard. Try again, or type it.` };
    case "unavailable":
    case "error":
      return { kind: "notice", message: `${response.safeMessage} ${FALLBACK}` };
  }
}

/**
 * Where a transcript goes in the field: after anything the viewer already typed, never over it,
 * and never past the message limit.
 */
export function mergeIntoDraft(draft: string, transcript: string): string {
  const said = transcript.trim();
  if (!said) return draft;
  const kept = draft.trimEnd();
  return (kept ? `${kept} ${said}` : said).slice(0, MAX_MESSAGE_CHARS);
}

/** Label of the one voice control, legible from across a room. */
export function voiceLabel(phase: VoicePhase, secondsLeft: number): string {
  switch (phase) {
    case "idle":
      return "Speak";
    case "starting":
      return "Opening mic…";
    case "recording":
      return `Stop · ${Math.max(0, Math.ceil(secondsLeft))}s`;
    case "transcribing":
      return "Transcribing…";
  }
}

/**
 * Pressing the control: start when idle, stop while recording, give up while the microphone is
 * still opening (a permission prompt nobody answers must not trap the control), and ignore
 * presses while the transcript is on its way.
 */
export function pressAction(phase: VoicePhase): "start" | "stop" | "cancel" | "ignore" {
  if (phase === "idle") return "start";
  if (phase === "recording") return "stop";
  if (phase === "starting") return "cancel";
  return "ignore";
}

/**
 * What the live stream's result means: a final with words is the answer; anything else (no
 * stream, a failure, or no words heard) means the recording is uploaded instead, so nothing the
 * viewer said is lost to a stream that went wrong.
 */
export function streamedAnswer(result: StreamResult | null): VoiceResponse | null {
  if (!result || result.kind !== "final") return null;
  const transcript = result.transcript.trim();
  if (!transcript) return null;
  return { status: "ok", transcript, audioSeconds: result.timings.audioBytes / 32_000, model: "stream", providerMs: result.timings.stopToFinalMs };
}
