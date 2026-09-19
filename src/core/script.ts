import { z } from "zod";

// A finished jam script runs ~4 minutes, told in scene portions of ~10–20s.
// Soft bounds are what we ask the writer for; hard bounds are what we accept,
// leaving a little slack so a beat can breathe without breaking validation.
export const SCRIPT_TARGET_SECONDS = 240;
export const PORTION_SOFT_MIN_SECONDS = 10;
export const PORTION_SOFT_MAX_SECONDS = 20;
export const PORTION_HARD_MIN_SECONDS = 8;
export const PORTION_HARD_MAX_SECONDS = 22;
export const TOTAL_TOLERANCE_SECONDS = 15;

export const scenePortionSchema = z.object({
  durationSeconds: z
    .number()
    .int()
    .min(PORTION_HARD_MIN_SECONDS)
    .max(PORTION_HARD_MAX_SECONDS),
  action: z.string().trim().min(1).max(600),
  dialogue: z.string().trim().max(600).optional(),
  visualDirection: z.string().trim().max(400).optional(),
});

export const sceneSchema = z.object({
  heading: z.string().trim().min(1).max(160),
  portions: z.array(scenePortionSchema).min(1).max(24),
});

export const jamScriptSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    logline: z.string().trim().min(1).max(400),
    scenes: z.array(sceneSchema).min(1).max(24),
  })
  .superRefine((script, context) => {
    const total = totalDurationSeconds(script);
    if (Math.abs(total - SCRIPT_TARGET_SECONDS) > TOTAL_TOLERANCE_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["scenes"],
        message: `Script runs ${total}s; it must stay within ${TOTAL_TOLERANCE_SECONDS}s of ${SCRIPT_TARGET_SECONDS}s.`,
      });
    }
  });

export type ScenePortion = z.infer<typeof scenePortionSchema>;
export type Scene = z.infer<typeof sceneSchema>;
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
