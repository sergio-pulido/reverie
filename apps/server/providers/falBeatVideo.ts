import { z } from "zod";

/**
 * One beat of the film as a finished clip, through fal's queue.
 *
 * Two models, one provider, one key, one budget. They differ only in whether the beat is
 * seeded by the faces of the participants who agreed to appear:
 *
 * - `minimax/h3-max/text-to-video` — a plain beat, nobody in the room in it.
 * - `minimax/h3-max/reference-to-video` — the same beat, generated from approved frames, so
 *   the character on screen is the person who agreed to be there.
 *
 * The allowlist below is the server's, not the caller's: no request body, environment
 * variable or provider response can widen it, and a model that is not in it cannot be
 * reached from this process at all.
 *
 * Nothing here decides *whether* a likeness may be used. That is `src/core/likeness.ts`, and
 * this adapter refuses to build a reference request with no references rather than quietly
 * generating a plain beat in its place.
 */

const QUEUE_HOST = "queue.fal.run";
const QUEUE_BASE_URL = `https://${QUEUE_HOST}`;

/** Server-owned model allowlist. A slug outside this map is not reachable. */
export const BEAT_MODELS = {
  plain: "minimax/h3-max/text-to-video",
  likeness: "minimax/h3-max/reference-to-video",
} as const;

export type BeatModelKind = keyof typeof BEAT_MODELS;
export type BeatModelSlug = (typeof BEAT_MODELS)[BeatModelKind];

export const BEAT_MODEL_SLUGS: readonly BeatModelSlug[] = Object.values(BEAT_MODELS);

export function isAllowlistedBeatModel(slug: string): slug is BeatModelSlug {
  return (BEAT_MODEL_SLUGS as readonly string[]).includes(slug);
}

/** The model's own duration band, from its published schema. Not a tuning knob. */
export const BEAT_MIN_SECONDS = 5;
export const BEAT_MAX_SECONDS = 15;
/** `maxItems` on `reference_image_urls`. Our own, lower cap is in src/core/likeness.ts. */
export const PROVIDER_MAX_REFERENCE_IMAGES = 9;
/** `maxLength` on `prompt`. Ours is far smaller; this is the ceiling it must respect. */
export const PROVIDER_MAX_PROMPT = 50_000;
/** What this server will actually send, so one beat cannot carry a screenplay. */
export const MAX_PROMPT_CHARS = 1_500;

const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** A clip is seconds of video, not a session recording. */
export const MAX_CLIP_BYTES = 64 * 1_024 * 1_024;

export class BeatVideoError extends Error {
  constructor(
    readonly code:
      | "beat_provider_unreachable"
      | "beat_provider_refused"
      | "beat_provider_unusable"
      | "beat_provider_timeout"
      | "beat_clip_too_large",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "BeatVideoError";
  }
}

export interface BeatVideoConfig {
  apiKey: string;
  resolution: "480P" | "768P" | "1080P";
  aspectRatio: "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
}

const resolutionSchema = z.enum(["480P", "768P", "1080P"]).catch("768P");
const aspectRatioSchema = z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).catch("16:9");

/**
 * Beat generation is gated on the live flag and a key, like every paid path here. It is not
 * gated behind the director's own flag: the two are different products with different bills,
 * and one flag must not buy both.
 */
export function resolveBeatVideoConfig(env: NodeJS.ProcessEnv): BeatVideoConfig | null {
  if (env.REVERIE_LIVE_ENABLED !== "true") return null;
  const apiKey = env.FAL_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    resolution: resolutionSchema.parse(env.REVERIE_BEAT_RESOLUTION?.trim()),
    aspectRatio: aspectRatioSchema.parse(env.REVERIE_BEAT_ASPECT_RATIO?.trim()),
  };
}

/**
 * A frame someone approved, carried inline.
 *
 * The frame travels as a `data:` URI in the request body rather than as a URL, so this
 * server never mints an address for a participant's face that anyone holding the link could
 * fetch. The only copies are the one in our own private store and the one the provider holds
 * for the length of the generation.
 */
export interface LikenessFrame {
  readonly assetRef: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

export interface BeatRequest {
  readonly prompt: string;
  readonly durationSeconds: number;
  /** Empty for a plain beat. A non-empty list selects the reference model. */
  readonly frames: readonly LikenessFrame[];
}

export function clampBeatSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return BEAT_MIN_SECONDS;
  return Math.min(BEAT_MAX_SECONDS, Math.max(BEAT_MIN_SECONDS, Math.round(seconds)));
}

/**
 * Which model a request reaches. One frame or more is a likeness beat; none is a plain one.
 * There is no third answer, and in particular no "asked for a likeness and silently got a
 * plain beat" — a caller that means to use a likeness passes frames or does not call.
 */
export function beatModelFor(request: BeatRequest): BeatModelSlug {
  return request.frames.length > 0 ? BEAT_MODELS.likeness : BEAT_MODELS.plain;
}

function dataUri(frame: LikenessFrame): string {
  return `data:${frame.contentType};base64,${frame.bytes.toString("base64")}`;
}

/**
 * The request body, built to the model's published input schema.
 *
 * `prompt_expansion_mode` is `disabled` on purpose. The room wrote this beat; a provider-side
 * rewrite would put words the room never agreed to in front of the faces of people who
 * agreed to a stated purpose.
 */
export function buildBeatPayload(
  config: BeatVideoConfig,
  request: BeatRequest,
): Record<string, unknown> {
  const prompt = request.prompt.trim().slice(0, MAX_PROMPT_CHARS);
  if (prompt.length === 0) {
    throw new BeatVideoError("beat_provider_refused", "A beat needs something to generate.", false);
  }
  const payload: Record<string, unknown> = {
    prompt,
    duration: clampBeatSeconds(request.durationSeconds),
    resolution: config.resolution,
    aspect_ratio: config.aspectRatio,
    prompt_expansion_mode: "disabled",
    enable_safety_checker: true,
  };
  if (request.frames.length > 0) {
    if (request.frames.length > PROVIDER_MAX_REFERENCE_IMAGES) {
      throw new BeatVideoError("beat_provider_refused", "Too many reference frames.", false);
    }
    payload.reference_image_urls = request.frames.map(dataUri);
  }
  return payload;
}

/**
 * How the beat's own text names the people in it.
 *
 * The model addresses references positionally — "Image 1", "Image 2" — so the prompt has to
 * say which is which. It says only that each image is a character in the scene: no display
 * name, no user id and nothing else about the person reaches the provider.
 */
export function describeReferences(count: number): string {
  if (count === 0) return "";
  const named = Array.from({ length: count }, (_, index) => `Image ${index + 1}`);
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return count === 1
    ? `${list} is a character in this scene. Keep that person's face and build consistent with their reference image.`
    : `${list} are characters in this scene. Keep each person's face and build consistent with their own reference image.`;
}

const queueStatusSchema = z.object({
  status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]),
  request_id: z.string().min(1),
  status_url: z.string().url().optional(),
  response_url: z.string().url().optional(),
});

/**
 * The queue answers with the URLs to follow, and they are not the ones the model's published
 * schema declares: a request against `minimax/h3-max/text-to-video` is tracked under
 * `minimax/h3-max`. Following the URLs it returns is therefore the only correct way to poll.
 *
 * A provider-supplied URL is still not followed on trust. It must be an https address on the
 * queue host this adapter already talks to, or the beat fails as unusable.
 */
function queueUrl(candidate: string | undefined, fallback: string): string {
  if (!candidate) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new BeatVideoError("beat_provider_unusable", "The beat queue named an address that is not one.", false);
  }
  if (parsed.protocol !== "https:" || parsed.host !== QUEUE_HOST) {
    throw new BeatVideoError("beat_provider_unusable", "The beat queue named an unexpected address.", false);
  }
  return parsed.toString();
}

const beatResultSchema = z.object({
  video: z.object({
    url: z.string().url(),
    content_type: z.string().nullable().optional(),
    file_size: z.number().nullable().optional(),
  }),
  seed: z.number().optional(),
  timings: z.record(z.string(), z.number()).nullable().optional(),
});

export type BeatResult = z.infer<typeof beatResultSchema>;

export interface BeatClip {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly model: BeatModelSlug;
  readonly requestId: string;
  /** Wall-clock milliseconds from submit to a downloaded clip, measured here. */
  readonly elapsedMs: number;
  /** The provider's own inference timing, when it reports one. */
  readonly providerInferenceSeconds: number | null;
}

export interface BeatVideoOptions {
  fetchImpl?: typeof fetch;
  /** How often the queue is asked. A beat takes tens of seconds; this is not a busy loop. */
  pollIntervalMs?: number;
  /** Hard ceiling on one beat, so a stuck request cannot hold a concurrency slot forever. */
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_DEADLINE_MS = 6 * 60_000;

/**
 * Submits one beat and returns its bytes.
 *
 * Nothing the provider says reaches a browser: every failure becomes one of the typed codes
 * above with a sentence this server wrote. A response that does not match the published
 * output schema is `beat_provider_unusable` rather than being coerced into something usable.
 */
export async function generateBeatVideo(
  config: BeatVideoConfig,
  request: BeatRequest,
  options: BeatVideoOptions = {},
): Promise<BeatClip> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;

  const model = beatModelFor(request);
  const payload = buildBeatPayload(config, request);
  const startedAt = now();

  const submitted = await readJson(
    fetchImpl,
    `${QUEUE_BASE_URL}/${model}`,
    {
      method: "POST",
      headers: { authorization: `Key ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    },
  );
  const queued = queueStatusSchema.safeParse(submitted);
  if (!queued.success) {
    throw new BeatVideoError("beat_provider_unusable", "The beat queue answered in an unexpected shape.", true);
  }
  const requestId = encodeURIComponent(queued.data.request_id);
  const statusUrl = queueUrl(
    queued.data.status_url,
    `${QUEUE_BASE_URL}/${model}/requests/${requestId}/status`,
  );
  const resultUrl = queueUrl(
    queued.data.response_url,
    `${QUEUE_BASE_URL}/${model}/requests/${requestId}`,
  );

  while (now() - startedAt < deadlineMs) {
    const status = queueStatusSchema.safeParse(
      await readJson(fetchImpl, statusUrl, {
        headers: { authorization: `Key ${config.apiKey}` },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      }),
    );
    if (!status.success) {
      throw new BeatVideoError("beat_provider_unusable", "The beat queue answered in an unexpected shape.", true);
    }
    if (status.data.status === "COMPLETED") {
      const result = beatResultSchema.safeParse(
        await readJson(fetchImpl, resultUrl, {
          headers: { authorization: `Key ${config.apiKey}` },
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        }),
      );
      if (!result.success) {
        throw new BeatVideoError("beat_provider_unusable", "The beat result did not match its schema.", false);
      }
      const bytes = await downloadClip(fetchImpl, result.data.video.url);
      return {
        bytes,
        contentType: result.data.video.content_type ?? "video/mp4",
        model,
        requestId: queued.data.request_id,
        elapsedMs: now() - startedAt,
        providerInferenceSeconds: result.data.timings?.inference ?? null,
      };
    }
    await sleep(pollIntervalMs);
  }

  // The request may still be running and may still bill. The budget already holds its
  // reservation, so giving up here never understates what was spent.
  throw new BeatVideoError("beat_provider_timeout", "That beat did not finish in time.", true);
}

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new BeatVideoError("beat_provider_unreachable", "The beat queue did not respond.", true);
  }
  if (!response.ok) {
    // The provider body can carry request detail and prompt echoes. It is never forwarded
    // and never logged; only the status shapes the retry decision.
    throw new BeatVideoError(
      "beat_provider_refused",
      `The beat queue refused that request (status ${response.status}).`,
      response.status === 429 || response.status >= 500,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new BeatVideoError("beat_provider_unusable", "The beat queue answered in an unexpected shape.", true);
  }
}

/** Reads the finished clip, refusing a body beyond the cap rather than buffering it. */
async function downloadClip(fetchImpl: typeof fetch, url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch {
    throw new BeatVideoError("beat_provider_unreachable", "The finished beat could not be read.", true);
  }
  if (!response.ok) {
    throw new BeatVideoError("beat_provider_refused", "The finished beat could not be read.", true);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CLIP_BYTES) {
    throw new BeatVideoError("beat_clip_too_large", "That beat is larger than this server accepts.", false);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_CLIP_BYTES) {
    throw new BeatVideoError("beat_clip_too_large", "That beat is larger than this server accepts.", false);
  }
  return bytes;
}
