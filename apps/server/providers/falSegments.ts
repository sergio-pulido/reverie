import { z } from "zod";
import {
  clampDuration,
  FAL_SEGMENT_MODEL_ALLOWLIST,
  findSegmentModel,
  type FalSegmentModel,
  type SegmentJob,
} from "./falSegmentModels";

/**
 * The queue half of the fal adapter: one prompt in, one finished clip out.
 *
 * This is the same provider as ./falDirector and a different surface of it. A
 * Director session is a WebRTC peer that produces frames and no file, which is
 * right for a film the room directs continuously and useless for an escape
 * room, where a location's idle loop has to be generated once and played
 * again for the rest of the session. A reusable segment needs a file, so it
 * needs the queue.
 *
 * Nothing here is a new provider and nothing here is a fallback. If the key,
 * the flag or the model is missing, callers are told the segment could not be
 * generated; they are never handed something that only looks generated.
 */

const FAL_QUEUE_BASE_URL = "https://queue.fal.run";
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
/** A 15-second 768p clip is a few megabytes; this is generous, not tight. */
export const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

export class FalSegmentError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "FalSegmentError";
  }
}

export interface FalSegmentConfig {
  apiKey: string;
  model: FalSegmentModel;
}

/**
 * Reads the configured model, or the allowlist default.
 *
 * An unrecognised `FAL_MODEL` is refused rather than ignored: serving a
 * different model than the operator asked for is exactly the kind of
 * unverified provider claim AGENTS.md forbids.
 */
export function resolveFalSegmentConfig(
  env: NodeJS.ProcessEnv,
): FalSegmentConfig | null {
  if (env.REVERIE_LIVE_ENABLED !== "true") return null;
  const apiKey = env.FAL_KEY?.trim();
  if (!apiKey) return null;
  const requested = env.FAL_MODEL?.trim();
  if (!requested) {
    return { apiKey, model: findSegmentModel(FAL_SEGMENT_MODEL_ALLOWLIST[0])! };
  }
  const model = findSegmentModel(requested);
  if (!model) {
    throw new FalSegmentError(
      `FAL_MODEL is not on the server allowlist (${FAL_SEGMENT_MODEL_ALLOWLIST.join(", ")}).`,
      false,
    );
  }
  return { apiKey, model };
}

const submitResponseSchema = z.object({ request_id: z.string().min(1) });

const statusResponseSchema = z.object({
  status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]),
});

/** Result shapes differ per model; accept the common video payloads. */
const resultResponseSchema = z.object({
  video: z
    .union([
      z.object({ url: z.url() }),
      z.array(z.object({ url: z.url() })).min(1),
    ])
    .optional(),
  videos: z.array(z.object({ url: z.url() })).min(1).optional(),
});

export type FalSegmentStatus = "queued" | "generating" | "completed";

async function falFetch(
  config: FalSegmentConfig,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${FAL_QUEUE_BASE_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Key ${config.apiKey}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network and timeout detail stays out of logs; no payload is recorded.
    throw new FalSegmentError("The video provider did not respond.", true);
  }
  if (!response.ok) {
    // The provider body can carry request detail that does not belong in a
    // client response or a log line, so the status is all that travels.
    throw new FalSegmentError(
      `The video provider rejected the request (status ${response.status}).`,
      response.status === 429 || response.status >= 500,
    );
  }
  return response;
}

/** Submits one segment to the fal queue. Returns the request id. */
export async function submitSegment(
  config: FalSegmentConfig,
  job: SegmentJob,
): Promise<string> {
  // The scenario's beat durations and the model's band are kept aligned, so
  // this clamp should be a no-op. It stays because an added model or an
  // edited scenario can drift, and fal refuses an out-of-band duration.
  const durationSeconds = clampDuration(config.model, job.durationSeconds);
  const response = await falFetch(
    config,
    `/${config.model.slug}`,
    { method: "POST", body: JSON.stringify(config.model.buildInput(job, durationSeconds)) },
    REQUEST_TIMEOUT_MS,
  );
  const parsed = submitResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new FalSegmentError("The video provider returned an unexpected shape.", true);
  }
  return parsed.data.request_id;
}

export async function getSegmentStatus(
  config: FalSegmentConfig,
  requestId: string,
): Promise<FalSegmentStatus> {
  const response = await falFetch(
    config,
    `/${config.model.queueAppId}/requests/${requestId}/status`,
    { method: "GET" },
    REQUEST_TIMEOUT_MS,
  );
  const parsed = statusResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new FalSegmentError("The video provider returned an unexpected shape.", true);
  }
  if (parsed.data.status === "IN_QUEUE") return "queued";
  if (parsed.data.status === "IN_PROGRESS") return "generating";
  return "completed";
}

/** The finished job's video URL. Provider-hosted, and never sent to a client. */
export async function getSegmentUrl(
  config: FalSegmentConfig,
  requestId: string,
): Promise<string> {
  const response = await falFetch(
    config,
    `/${config.model.queueAppId}/requests/${requestId}`,
    { method: "GET" },
    REQUEST_TIMEOUT_MS,
  );
  const parsed = resultResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new FalSegmentError("The video provider returned an unexpected shape.", true);
  }
  const video = parsed.data.video ?? parsed.data.videos;
  const url = Array.isArray(video) ? video[0]?.url : video?.url;
  if (!url) throw new FalSegmentError("The video provider result held no video.", false);
  return url;
}

/** Downloads the clip, capped at MAX_SEGMENT_BYTES. */
export async function downloadSegment(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Buffer; contentType: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch {
    throw new FalSegmentError("The generated segment could not be downloaded.", true);
  }
  if (!response.ok) {
    throw new FalSegmentError(
      `The generated segment could not be downloaded (status ${response.status}).`,
      response.status === 429 || response.status >= 500,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SEGMENT_BYTES) {
    throw new FalSegmentError("The generated segment exceeds the size cap.", false);
  }
  return { bytes, contentType: response.headers.get("content-type") ?? "video/mp4" };
}
