import { z } from "zod";
import {
  BEAT_MAX_CHARS,
  createJamScriptSchema,
  DEFAULT_SCRIPT_FORMAT,
  hardPortionBounds,
  totalDurationSeconds,
  type JamScript,
  type ScriptFormat,
} from "./script";

// What a writer (human or model) may hand us before validation: same shape as
// a script, but with looser timing that we rescale toward the format's target.
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
              durationSeconds: z.number().min(1).max(120),
              // The beat, written with the prose. Optional so a model that
              // forgets one does not fail a paid script; the fill-in in
              // src/core/outlineSummary.ts covers what is missing.
              summary: z.string().trim().min(1).max(BEAT_MAX_CHARS).optional(),
              action: z.string().trim().min(1).max(600),
              dialogue: z.string().trim().max(600).optional(),
              visualDirection: z.string().trim().max(400).optional(),
            }),
          )
          .min(1)
          .max(48),
      }),
    )
    .min(1)
    .max(24),
});

export type JamScriptDraft = z.infer<typeof jamScriptDraftSchema>;

// Drafts within ~0.8×–1.25× of the target can be rescaled without distortion
// (the ratios the fixed 190–300s window expressed for the 240s default).
const DRAFT_MIN_RATIO = 0.8;
const DRAFT_MAX_RATIO = 1.25;

export class ScriptDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptDraftError";
  }
}

/**
 * Rescale a draft's portion timings to the format's target and validate it as
 * a finished script. Drafts whose total is too far from the target to rescale
 * without distorting the story are rejected instead of silently stretched.
 */
export function finalizeScriptDraft(
  draft: JamScriptDraft,
  format: ScriptFormat = DEFAULT_SCRIPT_FORMAT,
): JamScript {
  const total = totalDurationSeconds(draft);
  const minTotal = Math.round(format.totalSeconds * DRAFT_MIN_RATIO);
  const maxTotal = Math.round(format.totalSeconds * DRAFT_MAX_RATIO);
  if (total < minTotal || total > maxTotal) {
    throw new ScriptDraftError(
      `Draft runs ${total}s; only drafts between ${minTotal}s and ${maxTotal}s can be rescaled to ${format.totalSeconds}s.`,
    );
  }

  const bounds = hardPortionBounds(format);
  const scale = format.totalSeconds / total;
  const scaled = {
    ...draft,
    scenes: draft.scenes.map((scene) => ({
      ...scene,
      portions: scene.portions.map((portion) => ({
        ...portion,
        durationSeconds: clamp(Math.round(portion.durationSeconds * scale), bounds),
      })),
    })),
  };
  settleOnTarget(scaled, format.totalSeconds, bounds);

  const parsed = createJamScriptSchema(format).safeParse(scaled);
  if (!parsed.success) {
    throw new ScriptDraftError(
      `Draft could not be finalized: ${parsed.error.issues[0]?.message ?? "invalid script"}`,
    );
  }
  return parsed.data;
}

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/**
 * Nudge portion durations one second at a time until the script hits the
 * target exactly, spreading the adjustment across portions with headroom so
 * no single beat absorbs the whole correction.
 */
function settleOnTarget(
  script: { scenes: { portions: { durationSeconds: number }[] }[] },
  targetSeconds: number,
  bounds: { min: number; max: number },
): void {
  const portions = script.scenes.flatMap((scene) => scene.portions);
  let remaining = targetSeconds - totalDurationSeconds(script);
  while (remaining !== 0) {
    const step = remaining > 0 ? 1 : -1;
    const limit = step > 0 ? bounds.max : bounds.min;
    const adjustable = portions.filter((p) => p.durationSeconds !== limit);
    if (adjustable.length === 0) return;
    for (const portion of adjustable) {
      portion.durationSeconds += step;
      remaining -= step;
      if (remaining === 0) break;
    }
  }
}
