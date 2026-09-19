import { z } from "zod";
import { jamScriptSchema, scriptFormatSchema } from "./script";
import { portionPatchSchema } from "./scriptHistory";

// A jam starts either from scratch (a short prompt seeds the script) or from
// an existing movie the room wants to riff on. Catalogue titles are source
// inspiration only — the resulting script is always an original generated work.
export const generatedJamSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("from-scratch"),
    prompt: z.string().trim().min(8).max(500),
  }),
  z.object({
    kind: z.literal("from-movie"),
    movieTitle: z.string().trim().min(1).max(120),
    movieSummary: z.string().trim().max(1000).optional(),
  }),
]);

export const jamSourceSchema = z.discriminatedUnion("kind", [
  ...generatedJamSourceSchema.options,
  z.object({
    kind: z.literal("imported-script"),
    scriptTitle: z.string().trim().min(1).max(120),
  }),
]);

const createJamBase = {
  format: scriptFormatSchema.prefault({}),
  // The room is registered first. Its id ties the script artifact to that
  // exact room instead of minting a second, unrelated jam id.
  jamId: z.uuid().optional(),
};

const createJamCommandUnion = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("generate"),
    source: generatedJamSourceSchema,
    ...createJamBase,
  }),
  z.object({
    mode: z.literal("import"),
    source: z.object({
      kind: z.literal("imported-script"),
      scriptTitle: z.string().trim().min(1).max(120),
    }),
    scriptMarkdown: z.string().trim().min(40).max(9000),
    ...createJamBase,
  }),
]);

export const createJamCommandSchema = z.preprocess((value) => {
  if (value && typeof value === "object" && !("mode" in value)) {
    return { ...value, mode: "generate" };
  }
  return value;
}, createJamCommandUnion);

// Live edits are portion-scoped: the structured script is the source of
// truth, and free-form whole-document edits are not expressible.
export const updatePortionCommandSchema = portionPatchSchema;

export const revertJamScriptCommandSchema = z.object({
  revision: z.number().int().min(1),
});

export const jamSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  source: jamSourceSchema,
  format: scriptFormatSchema,
  script: jamScriptSchema,
});

export type JamSource = z.infer<typeof jamSourceSchema>;
export type GeneratedJamSource = z.infer<typeof generatedJamSourceSchema>;
export type CreateJamCommand = z.infer<typeof createJamCommandSchema>;
export type UpdatePortionCommand = z.infer<typeof updatePortionCommandSchema>;
export type RevertJamScriptCommand = z.infer<typeof revertJamScriptCommandSchema>;
export type Jam = z.infer<typeof jamSchema>;
