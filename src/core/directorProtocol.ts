import { z } from "zod";

/**
 * The MiniMax H3 Max Director control channel, as pure data.
 *
 * Kept out of the transport so the rules can be tested without a browser: the
 * repo has no component harness, and a peer connection is not something a unit
 * test can open. Server output is parsed, never trusted.
 */

/** Messages the client may send, per the model's `client_message_types`. */
export type DirectorClientMessage =
  | { type: "configure"; [key: string]: unknown }
  | { type: "prompt"; prompt_version: number; prompt?: string; replan?: boolean }
  | { type: "ping"; client_ts: number }
  | { type: "stop" };

/**
 * Server messages this client acts on. The model publishes sixteen; the rest
 * are metrics and audio events that do not change what the viewer sees, so
 * they are allowed through as "ignored" rather than treated as protocol
 * errors — a stricter union would break the moment fal adds a message.
 */
/** The message types this client folds into state; see the reducer below. */
const DIRECTOR_HANDLED_TYPES = new Set([
  "configured",
  "chunk",
  "prompt_applied",
  "prompt_rejected",
  "stream_exhausted",
  "error",
]);

export const directorServerMessageSchema = z.union([
  z.object({
    type: z.literal("configured"),
    prompt_version: z.number().int().min(1),
    chunk_duration: z.number().int().nullish(),
    resolution: z.string().nullish(),
  }),
  z.object({
    type: z.literal("chunk"),
    chunk_index: z.number().int().min(0),
    prompt_version: z.number().int().min(1),
    playback_seconds: z.number(),
    script_offset_seconds: z.number().int().min(0).nullish(),
  }),
  z.object({
    type: z.literal("prompt_applied"),
    prompt_version: z.number().int().min(1),
  }),
  z.object({
    type: z.literal("prompt_rejected"),
    prompt_version: z.number().int().min(1).nullish(),
  }),
  z.object({
    type: z.literal("stream_exhausted"),
    reason: z.enum(["stopped", "session_limit"]),
    chunks: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    error: z.string(),
  }),
  // Anything else fal sends: metrics, audio events, messages added after this
  // was written. Deliberately last and deliberately loose — but it must not
  // swallow a KNOWN message that arrived malformed, which is a protocol
  // violation rather than something to shrug at.
  z
    .object({ type: z.string() })
    .refine((message) => !DIRECTOR_HANDLED_TYPES.has(message.type)),
]);

export type DirectorServerMessage = z.infer<typeof directorServerMessageSchema>;

/**
 * Error codes fal classes as fatal to the session, from the model's
 * `x-fal-wma.errors.sessionFailure`. Anything else is a diagnostic: the
 * session survives it, so the viewer must not be told the stream died.
 */
export const DIRECTOR_FATAL_CODES = new Set([
  "configuration_timeout",
  "initialization_timeout",
  "invalid_initial_image",
  "invalid_initial_audio",
  "invalid_initial_script",
  "invalid_input",
  "balance_unavailable",
  "content_policy",
  "generation_timeout",
  "generation_failed",
]);

export function isFatalDirectorError(code: string): boolean {
  return DIRECTOR_FATAL_CODES.has(code);
}

export type DirectorStatus =
  | "idle"
  | "connecting"
  | "configuring"
  | "streaming"
  | "ended"
  | "failed";

export interface DirectorState {
  status: DirectorStatus;
  /** Version of the direction fal has actually applied. */
  appliedPromptVersion: number;
  /** Highest version this client has sent; fal rejects anything stale. */
  sentPromptVersion: number;
  chunksReceived: number;
  /** Seconds of video the session has produced, for the spend readout. */
  generatedSeconds: number;
  endedReason: "stopped" | "session_limit" | null;
  error: string | null;
}

export function initialDirectorState(): DirectorState {
  return {
    status: "idle",
    appliedPromptVersion: 1,
    sentPromptVersion: 1,
    chunksReceived: 0,
    generatedSeconds: 0,
    endedReason: null,
    error: null,
  };
}

/**
 * Folds one server message into the session state.
 *
 * A pure reducer so the sequencing rules — when the stream counts as live,
 * which errors end it, how the applied version advances — are testable without
 * a peer connection.
 */
export function reduceDirectorState(
  state: DirectorState,
  message: DirectorServerMessage,
): DirectorState {
  switch (message.type) {
    case "configured":
      return { ...state, status: "configuring" };
    case "chunk": {
      const chunk = message as Extract<DirectorServerMessage, { type: "chunk" }>;
      return {
        ...state,
        // The stream is only "streaming" once real video has arrived, not when
        // the socket opened: an empty player under a live label is a lie.
        status: "streaming",
        chunksReceived: state.chunksReceived + 1,
        generatedSeconds: state.generatedSeconds + chunk.playback_seconds,
      };
    }
    case "prompt_applied": {
      const applied = message as Extract<
        DirectorServerMessage,
        { type: "prompt_applied" }
      >;
      return {
        ...state,
        appliedPromptVersion: Math.max(
          state.appliedPromptVersion,
          applied.prompt_version,
        ),
      };
    }
    case "prompt_rejected":
      // Direction did not take, but the stream is unaffected.
      return { ...state, error: "That direction was not applied." };
    case "stream_exhausted": {
      const ended = message as Extract<
        DirectorServerMessage,
        { type: "stream_exhausted" }
      >;
      return { ...state, status: "ended", endedReason: ended.reason };
    }
    case "error": {
      const failure = message as Extract<DirectorServerMessage, { type: "error" }>;
      if (!isFatalDirectorError(failure.code)) {
        return { ...state, error: failure.error };
      }
      return { ...state, status: "failed", error: failure.error };
    }
    default:
      return state;
  }
}

/** The next `prompt` message, with the version fal expects. */
export function nextPromptMessage(
  state: DirectorState,
  prompt: string,
): { message: DirectorClientMessage; state: DirectorState } {
  const version = state.sentPromptVersion + 1;
  return {
    message: { type: "prompt", prompt_version: version, prompt, replan: true },
    state: { ...state, sentPromptVersion: version },
  };
}
