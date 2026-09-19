import { z } from "zod";
import { catalogueTitleSchema } from "../catalogue/contract";
import { turnInputSchema } from "../preferences/schema";
import { MAX_ASSISTANT_LINE_CHARS, MAX_MESSAGE_CHARS } from "./decision";

/**
 * Wire shapes of the two conversational endpoints. The browser holds the preference state and
 * sends it; the server never trusts it, and the engine re-validates every field it reads.
 */

export const CONVERSATION_LIMITS = {
  /** Candidates one ranking call may carry: the whole refined shortlist, never more. */
  maxRankCandidates: 48,
  /** Synopses are cut before they leave the browser; the model needs a gist, not the record. */
  rankSynopsisChars: 280,
  maxReasonChars: 160,
} as const;

export const turnRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  /** Validated by the engine, which owns the state's shape. */
  state: z.unknown(),
  /** What the assistant last asked, so an answer like "yes, a comedy" can be read in context. */
  previousQuestion: z.string().max(MAX_ASSISTANT_LINE_CHARS).nullable().default(null),
});

export const rankCandidateSchema = catalogueTitleSchema
  .pick({ id: true, title: true, year: true, genres: true, runtimeMinutes: true, originalLanguage: true, rating: true })
  .extend({ synopsis: z.string().trim().max(CONVERSATION_LIMITS.rankSynopsisChars).optional() });

export const rankRequestSchema = z.strictObject({
  state: z.unknown(),
  candidates: z.array(rankCandidateSchema).min(1).max(CONVERSATION_LIMITS.maxRankCandidates),
});

/** Why the assistant could not help. The browser says so and falls back to chips and the scorer. */
export const unavailableCodes = [
  "ASSISTANT_DISABLED",
  "ASSISTANT_MISCONFIGURED",
  "ASSISTANT_BUSY",
  "ASSISTANT_TIMEOUT",
  "ASSISTANT_UNUSABLE",
  "ASSISTANT_UNGROUNDED",
] as const;

export const unavailableSchema = z.object({
  status: z.literal("unavailable"),
  code: z.enum(unavailableCodes),
  safeMessage: z.string().max(240),
});

export const conversationErrorSchema = z.object({
  status: z.literal("error"),
  code: z.string().max(64),
  safeMessage: z.string().max(240),
  retryable: z.boolean(),
});

export const turnOkSchema = z.object({
  status: z.literal("ok"),
  source: z.literal("nebius"),
  model: z.string().max(120),
  turn: turnInputSchema,
  acknowledgement: z.string().max(MAX_ASSISTANT_LINE_CHARS),
  question: z.string().max(MAX_ASSISTANT_LINE_CHARS).nullable(),
});

export const rankOkSchema = z.object({
  status: z.literal("ok"),
  source: z.literal("nebius"),
  model: z.string().max(120),
  stateVersion: z.number().int().min(0),
  /** Untrusted until the browser passes it through the engine's ranking boundary again. */
  ranking: z.array(z.object({ candidateId: z.string(), utility: z.number() })).max(CONVERSATION_LIMITS.maxRankCandidates),
  reasons: z
    .array(z.object({ candidateId: z.string(), reason: z.string().max(CONVERSATION_LIMITS.maxReasonChars) }))
    .max(3),
});

export const turnResponseSchema = z.discriminatedUnion("status", [turnOkSchema, unavailableSchema, conversationErrorSchema]);
export const rankResponseSchema = z.discriminatedUnion("status", [rankOkSchema, unavailableSchema, conversationErrorSchema]);

export type TurnRequest = z.infer<typeof turnRequestSchema>;
export type RankCandidate = z.infer<typeof rankCandidateSchema>;
export type RankRequest = z.infer<typeof rankRequestSchema>;
export type UnavailableCode = (typeof unavailableCodes)[number];
export type Unavailable = z.infer<typeof unavailableSchema>;
export type TurnOk = z.infer<typeof turnOkSchema>;
export type RankOk = z.infer<typeof rankOkSchema>;
export type TurnResponse = z.infer<typeof turnResponseSchema>;
export type RankResponse = z.infer<typeof rankResponseSchema>;
