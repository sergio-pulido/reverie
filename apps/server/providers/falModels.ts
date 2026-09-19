/**
 * Server-owned catalogue of the fal video models this build may call.
 *
 * Two things live here rather than in the transport adapter, because they are
 * facts about a model and not about HTTP: the duration band a model accepts,
 * and the request body it expects. Models disagree on both, so a single
 * hard-coded payload would silently mean "whatever the first allowlisted model
 * wanted".
 *
 * Duration bands are the vendor's own limits, read from each model's published
 * schema. `minimax/h3-max/text-to-video` declares `duration` as an integer in
 * [5, 15]; the Director realtime model declares the same band as
 * `min_chunk_duration`/`max_chunk_duration`. `src/core/script.ts` clamps
 * portions to the same numbers so a script can never ask for a clip no model
 * here can produce.
 */

export interface FalVideoJobInput {
  prompt: string;
  durationSeconds: number;
}

export interface FalModelSpec {
  /** Queue path segment, exactly as fal publishes it. */
  readonly slug: string;
  /**
   * The application a queued request belongs to: the first two slug segments.
   * fal submits to the full slug but addresses an in-flight request by its
   * application, so `minimax/h3-max/text-to-video` is polled at
   * `minimax/h3-max/requests/<id>`. Getting this wrong 404s every poll.
   */
  readonly queueAppId: string;
  /** Shortest clip the vendor accepts, in whole seconds. */
  readonly minDurationSeconds: number;
  /** Longest clip the vendor accepts, in whole seconds. */
  readonly maxDurationSeconds: number;
  /** Builds the model's own request body from a portion job. */
  buildInput(job: FalVideoJobInput, durationSeconds: number): Record<string, unknown>;
}

/** Clamps a portion's duration into what this model will actually accept. */
export function clampDuration(spec: FalModelSpec, durationSeconds: number): number {
  const whole = Math.round(durationSeconds);
  if (whole < spec.minDurationSeconds) return spec.minDurationSeconds;
  if (whole > spec.maxDurationSeconds) return spec.maxDurationSeconds;
  return whole;
}

// MiniMax H3 Max. The default, and the fallback whenever a switch is not
// configured: it is the queue model the project standardises on.
const h3Max: FalModelSpec = {
  slug: "minimax/h3-max/text-to-video",
  queueAppId: "minimax/h3-max",
  minDurationSeconds: 5,
  maxDurationSeconds: 15,
  buildInput: (job, durationSeconds) => ({
    prompt: job.prompt,
    duration: durationSeconds,
    // 768P is the vendor default and the mid price tier. Aspect ratio is
    // pinned so portions of one jam cut together.
    resolution: "768P",
    aspect_ratio: "16:9",
  }),
};

// Same family, same request shape, roughly half the price per second. Kept as
// a switch target so a long soak can run without the premium tier.
const h3MaxTurbo: FalModelSpec = {
  ...h3Max,
  slug: "minimax/h3-max-turbo/text-to-video",
  queueAppId: "minimax/h3-max-turbo",
};

/**
 * The allowlist. `FAL_MODEL` may select one of these by slug and nothing else;
 * entry [0] is the default and the failure fallback.
 */
export const FAL_MODEL_SPECS: readonly FalModelSpec[] = [h3Max, h3MaxTurbo];

export const DEFAULT_FAL_MODEL_SLUG = FAL_MODEL_SPECS[0].slug;

export const FAL_MODEL_ALLOWLIST: readonly string[] = FAL_MODEL_SPECS.map(
  (spec) => spec.slug,
);

export function findFalModelSpec(slug: string): FalModelSpec | undefined {
  return FAL_MODEL_SPECS.find((spec) => spec.slug === slug);
}
