import { z } from "zod";
import { jamScriptSchema, scriptFormatSchema } from "./script";

// A jam starts either from scratch (a short prompt seeds the script) or from
// an existing movie the room wants to riff on. Catalogue titles are source
// inspiration only — the resulting script is always an original generated work.
export const jamSourceSchema = z.discriminatedUnion("kind", [
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

export const createJamCommandSchema = z.object({
  source: jamSourceSchema,
  // Optional timing overrides; omitted fields fall back to the 4-minute,
  // 10–20s-portion default.
  format: scriptFormatSchema.prefault({}),
});

export const jamSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  source: jamSourceSchema,
  format: scriptFormatSchema,
  script: jamScriptSchema,
});

export type JamSource = z.infer<typeof jamSourceSchema>;
export type CreateJamCommand = z.infer<typeof createJamCommandSchema>;
export type Jam = z.infer<typeof jamSchema>;
