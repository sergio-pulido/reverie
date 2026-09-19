import { z } from "zod";

// A session attaches one user to a jam. The jam's script stays shared; the
// session's settings (language, ambientation) skin that user's playback so
// each participant can experience the same story their own way.

// BCP-47-shaped tag: "en", "es", "ca", "pt-BR", "zh-Hant"…
export const languageSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/, "Use a language tag like 'en' or 'pt-BR'.")
  .max(35);

export const DEFAULT_SESSION_LANGUAGE = "en";

export const sessionSettingsSchema = z.object({
  language: languageSchema.default(DEFAULT_SESSION_LANGUAGE),
  // Free-text mood/setting skin, e.g. "neon-noir rainy metropolis".
  // Empty means: play the script as written.
  ambientation: z.string().trim().max(280).default(""),
});

export const createSessionCommandSchema = z.object({
  displayName: z.string().trim().min(1).max(32),
  settings: sessionSettingsSchema.prefault({}),
});

export const updateSessionCommandSchema = z
  .object({
    settings: z
      .object({
        language: languageSchema.optional(),
        ambientation: z.string().trim().max(280).optional(),
      })
      .strict(),
  })
  .refine(
    (command) =>
      command.settings.language !== undefined ||
      command.settings.ambientation !== undefined,
    { message: "Provide at least one setting to change." },
  );

export const jamSessionSchema = z.object({
  id: z.uuid(),
  jamId: z.uuid(),
  owner: z.object({
    id: z.uuid(),
    displayName: z.string().trim().min(1).max(32),
  }),
  settings: sessionSettingsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SessionSettings = z.infer<typeof sessionSettingsSchema>;
export type CreateSessionCommand = z.infer<typeof createSessionCommandSchema>;
export type UpdateSessionCommand = z.infer<typeof updateSessionCommandSchema>;
export type JamSession = z.infer<typeof jamSessionSchema>;
