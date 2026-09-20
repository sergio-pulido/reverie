import { z } from "zod";
import { BEAT_MAX_CHARS } from "./script";

// The one command every way of steering the story produces. A mechanism —
// a direct rewrite, a vote, a poll, a chat turn — ends at producing one of
// these against one beat; everything downstream (locking, serialization, the
// cascade, the commit, delivery to the director) happens once behind the
// queue in apps/server/outline.ts, whichever door the change came through.
//
// Two intents, not one, because a down-vote carries no replacement text:
// "not this" is a real request and inventing prose for it would be
// fabrication. `mechanism` and `authorId` are audit, never logic — nothing
// downstream may branch on them.

export const OUTLINE_MECHANISMS = ["direct", "vote", "poll", "chat"] as const;
export type OutlineMechanism = (typeof OUTLINE_MECHANISMS)[number];

const beatIndex = z.number().int().min(0);
const summary = z.string().trim().min(1).max(BEAT_MAX_CHARS);
const reason = z.string().trim().min(1).max(280).optional();

/** What should happen to one beat. */
export const outlineEditIntentSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("set"), beatIndex, summary }),
  z.object({ intent: z.literal("reroll"), beatIndex, reason }),
]);

export type OutlineEditIntent = z.infer<typeof outlineEditIntentSchema>;

// The envelope from docs/specs/transactional-scene-contract.md, as this path
// carries it: `requestId` makes a replay return the first outcome instead of
// acting twice, and `expectedRevision` is the compare-and-swap guard — the
// outline's version is the script revision number, not a second counter,
// because a landed edit *is* a revision.
const envelope = {
  requestId: z.uuid(),
  expectedRevision: z.number().int().min(1).optional(),
  mechanism: z.enum(OUTLINE_MECHANISMS).default("direct"),
  authorId: z.string().trim().min(1).max(128).optional(),
};

export const outlineEditCommandSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("set"), beatIndex, summary, ...envelope }),
  z.object({ intent: z.literal("reroll"), beatIndex, reason, ...envelope }),
]);

export type OutlineEditCommand = z.infer<typeof outlineEditCommandSchema>;

/** Strips the envelope, leaving what the cascade needs. */
export function intentOf(command: OutlineEditCommand): OutlineEditIntent {
  return command.intent === "set"
    ? { intent: "set", beatIndex: command.beatIndex, summary: command.summary }
    : { intent: "reroll", beatIndex: command.beatIndex, reason: command.reason };
}

export type OutlineEditStatus = "queued" | "processing" | "landed" | "failed";

export interface OutlineEditError {
  code: string;
  safeMessage: string;
  retryable: boolean;
}

/** One edit's life, readable at every stage. Never a partial: an edit either lands as a revision or fails with a reason. */
export interface OutlineEditRecord {
  id: string;
  jamId: string;
  requestId: string;
  intent: OutlineEditIntent["intent"];
  beatIndex: number;
  summary?: string;
  reason?: string;
  mechanism: OutlineMechanism;
  authorId?: string;
  status: OutlineEditStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** The revision the cascade was computed from. */
  baseRevision?: number;
  /** The revision the edit landed as. */
  revision?: number;
  error?: OutlineEditError;
  /**
   * How the edited beat fared as a direction to the jam's open streams.
   *
   * `skipped` is a stream the edit was not for: a direction steers what a
   * stream generates next, so only the stream about to render this beat is
   * told about it.
   */
  direction?: { sent: number; refused: number; skipped: number };
}

/** At most this many edits wait per jam; the next is refused with `queue_full`. */
export const MAX_QUEUED_EDITS_PER_JAM = 10;
/** The ledger keeps this many records per jam; it doubles as the requestId register. */
export const MAX_EDIT_RECORDS_PER_JAM = 50;
