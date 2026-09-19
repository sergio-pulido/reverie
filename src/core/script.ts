import { z } from "zod";

// Script timing is configurable per jam: the host picks the total runtime and
// the portion length band. Soft bounds are what we ask the writer for; hard
// bounds add a little slack so a beat can breathe without breaking validation.
export const DEFAULT_TOTAL_SECONDS = 240;
export const DEFAULT_PORTION_MIN_SECONDS = 10;
export const DEFAULT_PORTION_MAX_SECONDS = 20;

export const TOTAL_MIN_SECONDS = 60;
export const TOTAL_MAX_SECONDS = 900;
export const PORTION_ABSOLUTE_MIN_SECONDS = 4;
export const PORTION_ABSOLUTE_MAX_SECONDS = 60;
export const PORTION_SLACK_SECONDS = 2;

export const scriptFormatSchema = z
  .object({
    totalSeconds: z
      .number()
      .int()
      .min(TOTAL_MIN_SECONDS)
      .max(TOTAL_MAX_SECONDS)
      .default(DEFAULT_TOTAL_SECONDS),
    portionMinSeconds: z
      .number()
      .int()
      .min(PORTION_ABSOLUTE_MIN_SECONDS)
      .max(PORTION_ABSOLUTE_MAX_SECONDS)
      .default(DEFAULT_PORTION_MIN_SECONDS),
    portionMaxSeconds: z
      .number()
      .int()
      .min(PORTION_ABSOLUTE_MIN_SECONDS)
      .max(PORTION_ABSOLUTE_MAX_SECONDS)
      .default(DEFAULT_PORTION_MAX_SECONDS),
  })
  .superRefine((format, context) => {
    if (format.portionMinSeconds > format.portionMaxSeconds) {
      context.addIssue({
        code: "custom",
        path: ["portionMinSeconds"],
        message: "The minimum portion length cannot exceed the maximum.",
      });
    }
    if (format.portionMaxSeconds > format.totalSeconds) {
      context.addIssue({
        code: "custom",
        path: ["portionMaxSeconds"],
        message: "A single portion cannot be longer than the whole script.",
      });
    }
  });

export type ScriptFormat = z.infer<typeof scriptFormatSchema>;

export const DEFAULT_SCRIPT_FORMAT: ScriptFormat = scriptFormatSchema.parse({});

export function hardPortionBounds(format: ScriptFormat): {
  min: number;
  max: number;
} {
  return {
    min: Math.max(1, format.portionMinSeconds - PORTION_SLACK_SECONDS),
    max: format.portionMaxSeconds + PORTION_SLACK_SECONDS,
  };
}

// ~6% of the runtime, matching the 15s tolerance the 4-minute default had.
export function totalToleranceSeconds(format: ScriptFormat): number {
  return Math.max(5, Math.round(format.totalSeconds / 16));
}

function buildPortionSchema(minSeconds: number, maxSeconds: number) {
  return z.object({
    durationSeconds: z.number().int().min(minSeconds).max(maxSeconds),
    action: z.string().trim().min(1).max(600),
    dialogue: z.string().trim().max(600).optional(),
    visualDirection: z.string().trim().max(400).optional(),
  });
}

function buildSceneSchema(minSeconds: number, maxSeconds: number) {
  return z.object({
    heading: z.string().trim().min(1).max(160),
    portions: z.array(buildPortionSchema(minSeconds, maxSeconds)).min(1).max(48),
  });
}

/** Strict script schema for a given format: hard portion bounds + total tolerance. */
export function createJamScriptSchema(format: ScriptFormat) {
  const bounds = hardPortionBounds(format);
  const tolerance = totalToleranceSeconds(format);
  return z
    .object({
      title: z.string().trim().min(1).max(120),
      logline: z.string().trim().min(1).max(400),
      scenes: z.array(buildSceneSchema(bounds.min, bounds.max)).min(1).max(24),
    })
    .superRefine((script, context) => {
      const total = totalDurationSeconds(script);
      if (Math.abs(total - format.totalSeconds) > tolerance) {
        context.addIssue({
          code: "custom",
          path: ["scenes"],
          message: `Script runs ${total}s; it must stay within ${tolerance}s of ${format.totalSeconds}s.`,
        });
      }
    });
}

// Structural schema for stored/transported scripts: format-agnostic, so a jam
// with a custom format still validates. Strict timing checks happen at
// generation time through createJamScriptSchema(jam.format).
export const jamScriptSchema = z.object({
  title: z.string().trim().min(1).max(120),
  logline: z.string().trim().min(1).max(400),
  scenes: z
    .array(
      buildSceneSchema(1, PORTION_ABSOLUTE_MAX_SECONDS + PORTION_SLACK_SECONDS),
    )
    .min(1)
    .max(24),
});

export type ScenePortion = z.infer<typeof jamScriptSchema>["scenes"][number]["portions"][number];
export type Scene = z.infer<typeof jamScriptSchema>["scenes"][number];
export type JamScript = z.infer<typeof jamScriptSchema>;

export function totalDurationSeconds(script: {
  scenes: { portions: { durationSeconds: number }[] }[];
}): number {
  return script.scenes.reduce(
    (sceneSum, scene) =>
      sceneSum +
      scene.portions.reduce((sum, portion) => sum + portion.durationSeconds, 0),
    0,
  );
}
