import { z } from "zod";

/**
 * SLNG speech-to-text over HTTP: one recording in, one final transcript out.
 *
 * Audio handed to this adapter is the viewer's spoken request, contributed for one purpose:
 * producing the transcript of that request. It is forwarded to SLNG in memory and never
 * written, logged or kept once the call returns.
 */

// Server-owned allowlist. SLNG_STT_MODEL may pick one of these; nothing else.
// Verified against SLNG's live model catalogue and by the dated receipt in docs/PROJECT_STATE.md.
export const SLNG_STT_MODEL_ALLOWLIST = ["slng/deepgram/nova:3-en"] as const;
export type SlngSttModel = (typeof SLNG_STT_MODEL_ALLOWLIST)[number];

// SLNG hosts Nova 3 English in these regions only; there is no EU host for it.
export const SLNG_REGION_HOSTS = {
  "us-east": "us-east.api.slng.ai",
  "us-west": "us-west.api.slng.ai",
} as const;
export type SlngRegion = keyof typeof SLNG_REGION_HOSTS;
const DEFAULT_REGION: SlngRegion = "us-east";

/**
 * Upstream options sent with every request. When any option is present the upstream model
 * defaults to a name it does not serve ("latest"), so the model is always named explicitly.
 */
const UPSTREAM_OPTIONS = { model: "nova-3-general", punctuate: "true" } as const;

export type SlngFailure = "no_response" | "rejected" | "bad_shape" | "config" | "timeout";

export class SlngError extends Error {
  constructor(
    message: string,
    readonly kind: SlngFailure,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "SlngError";
  }
}

export interface SlngConfig {
  apiKey: string;
  model: SlngSttModel;
  region: SlngRegion;
}

export function resolveSlngConfig(env: NodeJS.ProcessEnv): SlngConfig | null {
  if (env.REVERIE_LIVE_ENABLED !== "true") return null;
  const apiKey = env.SLNG_API_KEY?.trim();
  if (!apiKey) return null;
  const requested = env.SLNG_STT_MODEL?.trim();
  if (requested && !SLNG_STT_MODEL_ALLOWLIST.includes(requested as SlngSttModel)) {
    throw new SlngError("SLNG_STT_MODEL is not on the server allowlist.", "config");
  }
  const region = env.SLNG_REGION?.trim();
  if (region && !(region in SLNG_REGION_HOSTS)) {
    throw new SlngError("SLNG_REGION is not a region that hosts the speech model.", "config");
  }
  return {
    apiKey,
    model: (requested as SlngSttModel | undefined) || SLNG_STT_MODEL_ALLOWLIST[0],
    region: (region as SlngRegion | undefined) || DEFAULT_REGION,
  };
}

export function sttUrl(config: SlngConfig, protocol: "https" | "wss" = "https"): string {
  return `${protocol}://${SLNG_REGION_HOSTS[config.region]}/v1/stt/${config.model}`;
}

const transcriptionSchema = z.object({
  results: z.object({
    channels: z
      .array(z.object({ alternatives: z.array(z.object({ transcript: z.string() })).min(1) }))
      .min(1),
  }),
  metadata: z.object({ duration: z.number().nonnegative().optional() }).optional(),
});

export type Transcription = {
  /** Trimmed; empty when the model heard no words. */
  transcript: string;
  audioSeconds: number | null;
};

export type TranscribeInput = {
  audio: Uint8Array;
  contentType: string;
  timeoutMs: number;
  /** Aborts early, for a caller whose client has gone away. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

/** Sends one recording to SLNG and returns the final transcript, or throws a typed SlngError. */
export async function transcribe(config: SlngConfig, input: TranscribeInput): Promise<Transcription> {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(input.audio)], { type: input.contentType }), "speech");
  for (const [name, value] of Object.entries(UPSTREAM_OPTIONS)) form.append(name, value);

  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(sttUrl(config), {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal,
    });
  } catch {
    // Neither the audio nor the provider's error body is recorded.
    if (timeout.aborted) throw new SlngError("The speech provider did not answer in time.", "timeout");
    throw new SlngError("The speech provider did not respond.", "no_response");
  }

  if (!response.ok) {
    throw new SlngError(`The speech provider rejected the audio (status ${response.status}).`, "rejected", response.status);
  }

  const parsed = transcriptionSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new SlngError("The speech provider returned an unexpected shape.", "bad_shape");
  }
  return {
    transcript: parsed.data.results.channels[0].alternatives[0].transcript.trim(),
    audioSeconds: parsed.data.metadata?.duration ?? null,
  };
}
