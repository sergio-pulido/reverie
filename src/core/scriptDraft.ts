import { z } from "zod";
import {
  jamScriptSchema,
  PORTION_HARD_MAX_SECONDS,
  PORTION_HARD_MIN_SECONDS,
  SCRIPT_TARGET_SECONDS,
  totalDurationSeconds,
  type JamScript,
} from "./script";

// What a writer (human or model) may hand us before validation: same shape as
// a script, but with looser timing that we rescale toward the 4-minute target.
export const jamScriptDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  logline: z.string().trim().min(1).max(400),
  scenes: z
    .array(
      z.object({
        heading: z.string().trim().min(1).max(160),
        portions: z
          .array(
            z.object({
              durationSeconds: z.number().min(4).max(60),
              action: z.string().trim().min(1).max(600),
              dialogue: z.string().trim().max(600).optional(),
              visualDirection: z.string().trim().max(400).optional(),
            }),
          )
          .min(1)
          .max(24),
      }),
    )
    .min(1)
    .max(24),
});

export type JamScriptDraft = z.infer<typeof jamScriptDraftSchema>;

const DRAFT_TOTAL_MIN_SECONDS = 190;
const DRAFT_TOTAL_MAX_SECONDS = 300;

export class ScriptDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptDraftError";
  }
}

/**
 * Rescale a draft's portion timings to the 4-minute target and validate it as
 * a finished script. Drafts whose total is too far from the target to rescale
 * without distorting the story are rejected instead of silently stretched.
 */
export function finalizeScriptDraft(draft: JamScriptDraft): JamScript {
  const total = totalDurationSeconds(draft);
  if (total < DRAFT_TOTAL_MIN_SECONDS || total > DRAFT_TOTAL_MAX_SECONDS) {
    throw new ScriptDraftError(
      `Draft runs ${total}s; only drafts between ${DRAFT_TOTAL_MIN_SECONDS}s and ${DRAFT_TOTAL_MAX_SECONDS}s can be rescaled to ${SCRIPT_TARGET_SECONDS}s.`,
    );
  }

  const scale = SCRIPT_TARGET_SECONDS / total;
  const scaled = {
    ...draft,
    scenes: draft.scenes.map((scene) => ({
      ...scene,
      portions: scene.portions.map((portion) => ({
        ...portion,
        durationSeconds: clampPortionSeconds(portion.durationSeconds * scale),
      })),
    })),
  };
  settleOnTarget(scaled);

  const parsed = jamScriptSchema.safeParse(scaled);
  if (!parsed.success) {
    throw new ScriptDraftError(
      `Draft could not be finalized: ${parsed.error.issues[0]?.message ?? "invalid script"}`,
    );
  }
  return parsed.data;
}

function clampPortionSeconds(value: number): number {
  return Math.min(
    PORTION_HARD_MAX_SECONDS,
    Math.max(PORTION_HARD_MIN_SECONDS, Math.round(value)),
  );
}

/**
 * Nudge portion durations one second at a time until the script hits the
 * target exactly, spreading the adjustment across portions with headroom so
 * no single beat absorbs the whole correction.
 */
function settleOnTarget(script: {
  scenes: { portions: { durationSeconds: number }[] }[];
}): void {
  const portions = script.scenes.flatMap((scene) => scene.portions);
  let remaining = SCRIPT_TARGET_SECONDS - totalDurationSeconds(script);
  while (remaining !== 0) {
    const step = remaining > 0 ? 1 : -1;
    const limit = step > 0 ? PORTION_HARD_MAX_SECONDS : PORTION_HARD_MIN_SECONDS;
    const adjustable = portions.filter((p) => p.durationSeconds !== limit);
    if (adjustable.length === 0) return;
    for (const portion of adjustable) {
      portion.durationSeconds += step;
      remaining -= step;
      if (remaining === 0) break;
    }
  }
}
