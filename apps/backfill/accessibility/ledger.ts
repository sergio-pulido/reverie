import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { subtitleLanguageCode } from "../../../src/catalogue/contract";

/**
 * Append-only JSONL ledgers that make the backfill resumable. Each finished check is one line,
 * written as soon as it is known, so an interrupted run loses at most the request in flight.
 * A rerun reads the ledger and asks only about what has no answer yet. Skips are recorded with
 * their reason and retried on the next run.
 */

export const subtitleLineSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("checked"),
    titleId: z.number().int().positive(),
    imdbId: z.string(),
    languages: z.array(subtitleLanguageCode),
    count: z.number().int().min(0),
    checkedAt: z.string(),
  }),
  z.object({
    outcome: z.literal("skipped"),
    titleId: z.number().int().positive(),
    imdbId: z.string().nullable(),
    reason: z.string(),
    at: z.string(),
  }),
]);
export type SubtitleLine = z.infer<typeof subtitleLineSchema>;

export const adpPageLineSchema = z.object({
  page: z.number().int().min(0),
  fetchedAt: z.string(),
  lastPage: z.number().int().min(0).nullable(),
  entries: z.array(z.object({ imdbId: z.string().regex(/^tt\d{5,10}$/), providers: z.array(z.string()) })),
});
export type AdpPageLine = z.infer<typeof adpPageLineSchema>;

/** Reads every valid line; a torn last line from an interrupted write is ignored, not fatal. */
export function readLedger<T>(path: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed = schema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

export function appendLedger(path: string, line: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
}

/** The latest answer per title: a later check supersedes an earlier one; skips never override a check. */
export function latestSubtitleAnswers(lines: SubtitleLine[]) {
  const answers = new Map<number, Extract<SubtitleLine, { outcome: "checked" }>>();
  for (const line of lines) if (line.outcome === "checked") answers.set(line.titleId, line);
  return answers;
}
