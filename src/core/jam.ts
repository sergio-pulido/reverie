import { z } from "zod";
import { jamScriptSchema, scriptFormatSchema } from "./script";
import { MAX_SCRIPT_MARKDOWN_CHARS } from "./scriptHistory";

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
  // The Supabase room row is created client-side with its own id today; a
  // caller that already has a room passes its id so the generated script and
  // its revisions land under that room instead of a second server-minted id.
  jamId: z.uuid().optional(),
});

export const updateJamScriptCommandSchema = z.object({
  markdown: z.string().min(1).max(MAX_SCRIPT_MARKDOWN_CHARS),
});

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
export type CreateJamCommand = z.infer<typeof createJamCommandSchema>;
export type UpdateJamScriptCommand = z.infer<typeof updateJamScriptCommandSchema>;
export type RevertJamScriptCommand = z.infer<typeof revertJamScriptCommandSchema>;
export type Jam = z.infer<typeof jamSchema>;
