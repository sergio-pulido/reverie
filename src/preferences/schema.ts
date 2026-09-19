import { z } from "zod";

// A domain-agnostic preference engine. It accumulates what a viewer has said across a
// conversation as evidence on named dimensions plus hard constraints, and knows nothing about
// what the candidates are: only their dimensions, numeric attributes, tags and flags.

export const PREFERENCE_SCHEMA_VERSION = 1;
export const MAX_TURNS_PER_SESSION = 12;
export const MAX_TRANSCRIPT_CHARS = 4_000;
export const MAX_QUOTE_CHARS = 500;
export const MAX_CHANGES_PER_TURN = 32;
export const MAX_RANKING_ENTRIES = 100;
export const SHORTLIST_SIZE = 3;
export const MAX_REJECTED_CANDIDATES = 100;

// Ids and vocabulary names start with a letter or digit, which also keeps prototype keys such
// as `__proto__` out of the records below.
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "Invalid identifier");
const unitSchema = z.number().min(0).max(1);

// A blank quote is a substring of every transcript, so it could never prove grounding.
const quoteSchema = z
  .string()
  .max(MAX_QUOTE_CHARS)
  .refine((quote) => quote.trim().length > 0, "Quote must not be blank");

function boundedRecord<V extends z.ZodType>(key: z.ZodString, value: V, max: number) {
  return z
    .record(key, value)
    .refine((record) => Object.keys(record).length <= max, `At most ${max} entries`);
}

/** The vocabulary a turn may use. Anything outside it is an error, never silently created. */
export const configurationSchema = z.strictObject({
  dimensions: z.array(identifierSchema),
  attributes: z.array(identifierSchema),
  tags: z.array(identifierSchema),
  flags: z.array(identifierSchema),
});

export const evidenceSchema = z.strictObject({
  /** Null when the viewer spoke to the dimension without giving it a direction. */
  value: unitSchema.nullable(),
  confidence: unitSchema,
  sourceTurnId: identifierSchema,
  quote: quoteSchema,
  /** True when the viewer said it outright; false when it was inferred from what they said. */
  explicit: z.boolean(),
});

export const predicateSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("number"),
    field: identifierSchema,
    operator: z.enum(["lt", "lte", "gt", "gte"]),
    value: z.number(),
  }),
  z.strictObject({ kind: z.literal("excludeTag"), tag: identifierSchema }),
  z.strictObject({ kind: z.literal("excludeFlag"), flag: identifierSchema }),
]);

export const constraintSchema = z.strictObject({
  id: identifierSchema,
  predicate: predicateSchema,
  sourceTurnId: identifierSchema,
  quote: quoteSchema,
});

export const preferenceStateSchema = z.strictObject({
  schemaVersion: z.literal(PREFERENCE_SCHEMA_VERSION),
  sessionId: identifierSchema,
  stateVersion: z.number().int().min(0),
  dimensions: z.record(identifierSchema, evidenceSchema),
  constraints: z.record(identifierSchema, constraintSchema),
  rejectedCandidateIds: z.array(identifierSchema),
  /** turnId -> the transcript it was accepted with. */
  processedTurns: z.record(identifierSchema, z.string()),
});

export const turnInputSchema = z.strictObject({
  sessionId: identifierSchema,
  turnId: identifierSchema,
  expectedStateVersion: z.number().int().min(0),
  transcript: z.string().min(1).max(MAX_TRANSCRIPT_CHARS),
  dimensions: boundedRecord(identifierSchema, evidenceSchema, MAX_CHANGES_PER_TURN),
  setConstraints: z.array(constraintSchema).max(MAX_CHANGES_PER_TURN),
  removeConstraints: z.array(identifierSchema).max(MAX_CHANGES_PER_TURN),
});

/** A proposed ranking. It comes from a model, so every field is untrusted until parsed. */
export const rankingSchema = z
  .array(z.strictObject({ candidateId: identifierSchema, utility: unitSchema }))
  .max(MAX_RANKING_ENTRIES);

export type Configuration = z.infer<typeof configurationSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Predicate = z.infer<typeof predicateSchema>;
export type Constraint = z.infer<typeof constraintSchema>;
export type PreferenceState = z.infer<typeof preferenceStateSchema>;
export type TurnInput = z.infer<typeof turnInputSchema>;
export type RankingEntry = z.infer<typeof rankingSchema>[number];

/**
 * Something that can be shortlisted. Callers may carry any extra fields; the engine reads only
 * these. A missing or null attribute means the value is unknown, never that it is 0.
 */
export interface Candidate {
  readonly id: string;
  readonly dimensions: Readonly<Record<string, number>>;
  readonly attributes: Readonly<Record<string, number | null | undefined>>;
  readonly tags: readonly string[];
  readonly flags: readonly string[];
}
