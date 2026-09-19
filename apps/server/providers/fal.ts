import { z } from "zod";

// Server-owned allowlist. FAL_MODEL may pick one of these; nothing else.
// NOT yet probed: no entry may be claimed working until a dated probe
// receipt is recorded in docs/DECISIONS.md (AGENTS.md provider rule).
export const FAL_MODEL_ALLOWLIST = [
  "fal-ai/ltx-video",
  "fal-ai/wan/v2.2-5b/text-to-video",
] as const;

const FAL_QUEUE_BASE_URL = "https://queue.fal.run";
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
// Per-clip download cap; portions are short (4–60s), so this is generous.
export const MAX_CLIP_BYTES = 64 * 1024 * 1024;

export class FalError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "FalError";
  }
}

export interface FalConfig {
  apiKey: string;
  model: string;
}

export function resolveFalConfig(env: NodeJS.ProcessEnv): FalConfig | null {
  if (env.REVERIE_LIVE_ENABLED !== "true") return null;
  const apiKey = env.FAL_KEY?.trim();
  if (!apiKey) return null;
  const requested = env.FAL_MODEL?.trim();
  if (requested && !FAL_MODEL_ALLOWLIST.includes(requested as never)) {
    throw new FalError("FAL_MODEL is not on the server allowlist.", false);
  }
  return { apiKey, model: requested || FAL_MODEL_ALLOWLIST[0] };
}

const submitResponseSchema = z.object({ request_id: z.string().min(1) });

const statusResponseSchema = z.object({
  status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]),
});

// Result shapes differ per model; accept the common video-payload layouts.
const resultResponseSchema = z.object({
  video: z
    .union([
      z.object({ url: z.string().url() }),
      z.array(z.object({ url: z.string().url() })).min(1),
    ])
    .optional(),
  videos: z.array(z.object({ url: z.string().url() })).min(1).optional(),
});

export interface VideoJobRequest {
  prompt: string;
  durationSeconds: number;
}

async function falFetch(
  config: FalConfig,
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
    // Network/timeout details stay out of logs; no payloads are recorded.
    throw new FalError("The video provider did not respond.", true);
  }
  if (!response.ok) {
    throw new FalError(
      `The video provider rejected the request (status ${response.status}).`,
      response.status === 429 || response.status >= 500,
    );
  }
  return response;
}

/** Submit one clip generation to the fal queue. Returns the request id. */
export async function submitVideoJob(
  config: FalConfig,
  job: VideoJobRequest,
): Promise<string> {
  const response = await falFetch(
    config,
    `/${config.model}`,
    {
      method: "POST",
      body: JSON.stringify({
        prompt: job.prompt,
        duration: job.durationSeconds,
      }),
    },
    REQUEST_TIMEOUT_MS,
  );
  const parsed = submitResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    throw new FalError("The video provider returned an unexpected shape.", true);
  }
  return parsed.data.request_id;
}

export type FalJobStatus = "queued" | "generating" | "completed";

export async function getJobStatus(
  config: FalConfig,
  requestId: string,
): Promise<FalJobStatus> {
  const response = await falFetch(
    config,
    `/${config.model}/requests/${requestId}/status`,
    { method: "GET" },
    REQUEST_TIMEOUT_MS,
  );
  const parsed = statusResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    throw new FalError("The video provider returned an unexpected shape.", true);
  }
  if (parsed.data.status === "IN_QUEUE") return "queued";
  if (parsed.data.status === "IN_PROGRESS") return "generating";
  return "completed";
}

/** Read the finished job's video URL (provider-hosted, server-side only). */
export async function getResultVideoUrl(
  config: FalConfig,
  requestId: string,
): Promise<string> {
  const response = await falFetch(
    config,
    `/${config.model}/requests/${requestId}`,
    { method: "GET" },
    REQUEST_TIMEOUT_MS,
  );
  const parsed = resultResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    throw new FalError("The video provider returned an unexpected shape.", true);
  }
  const video = parsed.data.video ?? parsed.data.videos;
  const url = Array.isArray(video) ? video[0]?.url : video?.url;
  if (!url) {
    throw new FalError("The video provider result held no video.", false);
  }
  return url;
}

/** Download the clip bytes, capped at MAX_CLIP_BYTES. */
export async function downloadVideo(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new FalError("The generated clip could not be downloaded.", true);
  }
  if (!response.ok) {
    throw new FalError(
      `The generated clip could not be downloaded (status ${response.status}).`,
      response.status === 429 || response.status >= 500,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_CLIP_BYTES) {
    throw new FalError("The generated clip exceeds the size cap.", false);
  }
  return bytes;
}
