/**
 * The fal video models this build may generate an escape-room segment with.
 *
 * A model is more than a slug: it differs from its neighbours in the duration
 * band it accepts and in the request body it wants, so the allowlist holds
 * typed specs and the transport asks the spec how to build a request. A single
 * hard-coded payload would silently mean "whatever the first entry wanted".
 *
 * Every number here is the vendor's own, read from the model's published
 * schema. `minimax/h3-max/text-to-video` declares `duration` as an integer in
 * [5, 15]; the realtime Director model in ./falDirector publishes the same
 * band as `min_chunk_duration`/`max_chunk_duration`, and `src/core/script.ts`
 * clamps script portions to it. What the model actually returns is measured,
 * not assumed — see `readMp4DurationSeconds` and the probe receipt in
 * docs/DECISIONS.md.
 */

export interface SegmentJob {
  prompt: string;
  durationSeconds: number;
}

export interface FalSegmentModel {
  /** Queue path segment, exactly as fal publishes it. */
  readonly slug: string;
  /**
   * The application a queued request belongs to: the first two slug segments.
   * fal submits to the full slug but addresses an in-flight request by its
   * application, so `minimax/h3-max/text-to-video` is polled at
   * `minimax/h3-max/requests/<id>`. Getting this wrong 404s every poll.
   */
  readonly queueAppId: string;
  readonly minDurationSeconds: number;
  readonly maxDurationSeconds: number;
  buildInput(job: SegmentJob, durationSeconds: number): Record<string, unknown>;
}

const h3Max: FalSegmentModel = {
  slug: "minimax/h3-max/text-to-video",
  queueAppId: "minimax/h3-max",
  minDurationSeconds: 5,
  maxDurationSeconds: 15,
  buildInput: (job, durationSeconds) => ({
    prompt: job.prompt,
    duration: durationSeconds,
    // 768P is the vendor default and the middle price tier. The aspect ratio
    // is pinned so a room's loop and its beats cut together.
    resolution: "768P",
    aspect_ratio: "16:9",
  }),
};

/** Same family, same request shape, roughly half the price per second. */
const h3MaxTurbo: FalSegmentModel = {
  ...h3Max,
  slug: "minimax/h3-max-turbo/text-to-video",
  queueAppId: "minimax/h3-max-turbo",
};

/**
 * The allowlist. `FAL_MODEL` may select one of these by slug and nothing
 * else; entry [0] is the default.
 */
export const FAL_SEGMENT_MODELS: readonly FalSegmentModel[] = [h3Max, h3MaxTurbo];

export const FAL_SEGMENT_MODEL_ALLOWLIST: readonly string[] = FAL_SEGMENT_MODELS.map(
  (model) => model.slug,
);

export function findSegmentModel(slug: string): FalSegmentModel | undefined {
  return FAL_SEGMENT_MODELS.find((model) => model.slug === slug);
}

/** Clamps a requested duration into what this model will actually accept. */
export function clampDuration(model: FalSegmentModel, durationSeconds: number): number {
  const whole = Math.round(durationSeconds);
  if (whole < model.minDurationSeconds) return model.minDurationSeconds;
  if (whole > model.maxDurationSeconds) return model.maxDurationSeconds;
  return whole;
}
