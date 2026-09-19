import { z } from "zod";

// The script markdown is edited live; every accepted edit appends a full
// snapshot revision. History is append-only: undo never rewrites it, it adds
// a new revision that restores an earlier one, so a redo is just another
// revert. Full snapshots are fine at 4-minute-script scale and keep restore
// trivial; diffs would buy nothing here.
// Stays under the router's 32kb JSON body limit so a valid command is never
// rejected at the transport layer instead of by validation.
export const MAX_SCRIPT_MARKDOWN_CHARS = 30_000;
export const MAX_REVISIONS_PER_JAM = 500;

export const scriptRevisionSchema = z.object({
  revision: z.number().int().min(1),
  markdown: z.string().min(1).max(MAX_SCRIPT_MARKDOWN_CHARS),
  createdAt: z.iso.datetime(),
  authorId: z.string().trim().min(1).max(128).optional(),
  note: z.string().trim().min(1).max(280).optional(),
  restoredFromRevision: z.number().int().min(1).optional(),
});

export const jamScriptHistorySchema = z.object({
  jamId: z.uuid(),
  revisions: z.array(scriptRevisionSchema).min(1),
});

export type ScriptRevision = z.infer<typeof scriptRevisionSchema>;
export type JamScriptHistory = z.infer<typeof jamScriptHistorySchema>;

export class ScriptHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptHistoryError";
  }
}

export function currentRevision(history: JamScriptHistory): ScriptRevision {
  return history.revisions[history.revisions.length - 1];
}

export function findRevision(
  history: JamScriptHistory,
  revision: number,
): ScriptRevision | undefined {
  return history.revisions.find((entry) => entry.revision === revision);
}

export interface NewRevisionInput {
  markdown: string;
  createdAt: string;
  authorId?: string;
  note?: string;
  restoredFromRevision?: number;
}

export function createInitialHistory(
  jamId: string,
  input: NewRevisionInput,
): JamScriptHistory {
  const history = {
    jamId,
    revisions: [buildRevision(1, input)],
  };
  return jamScriptHistorySchema.parse(history);
}

/**
 * Append a snapshot of the live markdown. Appending content identical to the
 * current revision returns the history unchanged, so autosave loops cannot
 * flood the history with no-op revisions.
 */
export function appendRevision(
  history: JamScriptHistory,
  input: NewRevisionInput,
): JamScriptHistory {
  const current = currentRevision(history);
  if (current.markdown === input.markdown) {
    return history;
  }
  const next = buildRevision(current.revision + 1, input);
  const revisions = [...history.revisions, next];
  // Keep history bounded; revision numbers stay monotonic after truncation.
  if (revisions.length > MAX_REVISIONS_PER_JAM) {
    revisions.splice(0, revisions.length - MAX_REVISIONS_PER_JAM);
  }
  return { ...history, revisions };
}

/**
 * Undo/redo: restore an earlier revision's markdown as a NEW revision that
 * records where it came from. Restoring the current revision is rejected —
 * it would be a confusing no-op in the history.
 */
export function revertToRevision(
  history: JamScriptHistory,
  targetRevision: number,
  input: Omit<NewRevisionInput, "markdown" | "restoredFromRevision">,
): JamScriptHistory {
  const target = findRevision(history, targetRevision);
  if (!target) {
    throw new ScriptHistoryError(
      `Revision ${targetRevision} does not exist in this jam's history (it may have been truncated).`,
    );
  }
  if (target.revision === currentRevision(history).revision) {
    throw new ScriptHistoryError(
      `Revision ${targetRevision} is already the current revision.`,
    );
  }
  return appendRevision(history, {
    ...input,
    markdown: target.markdown,
    restoredFromRevision: target.revision,
  });
}

function buildRevision(
  revision: number,
  input: NewRevisionInput,
): ScriptRevision {
  return scriptRevisionSchema.parse({
    revision,
    markdown: input.markdown,
    createdAt: input.createdAt,
    authorId: input.authorId,
    note: input.note,
    restoredFromRevision: input.restoredFromRevision,
  });
}
