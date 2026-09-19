import { z } from "zod";
import {
  hardPortionBounds,
  jamScriptSchema,
  type JamScript,
  type ScenePortion,
  type ScriptFormat,
} from "./script";

// The structured script (scenes → portions) is the editing source of truth;
// markdown is a deterministic render of a revision, never stored. Every
// accepted edit appends a full structured snapshot. History is append-only:
// undo never rewrites it, it adds a new revision that restores an earlier
// one, so a redo is just another revert — and a portion pinned at revision N
// stays immutable forever. Full snapshots are fine at movie-jam scale and
// keep restore trivial; diffs would buy nothing here.
export const MAX_REVISIONS_PER_JAM = 500;

export const scriptRevisionSchema = z.object({
  revision: z.number().int().min(1),
  script: jamScriptSchema,
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

/** Thrown when an edit or revert would change a played or locked portion. */
export class PortionLockedError extends Error {
  constructor(
    message: string,
    /** Highest locked flat portion index (minEditablePortionIndex - 1). */
    readonly lockedIndex: number,
  ) {
    super(message);
    this.name = "PortionLockedError";
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
  script: JamScript;
  createdAt: string;
  authorId?: string;
  note?: string;
  restoredFromRevision?: number;
}

export function createInitialHistory(
  jamId: string,
  input: NewRevisionInput,
): JamScriptHistory {
  return jamScriptHistorySchema.parse({
    jamId,
    revisions: [buildRevision(1, input)],
  });
}

/**
 * Append a structured snapshot. Appending content identical to the current
 * revision returns the history unchanged, so autosave loops cannot flood the
 * history with no-op revisions.
 */
export function appendRevision(
  history: JamScriptHistory,
  input: NewRevisionInput,
): JamScriptHistory {
  const current = currentRevision(history);
  if (scriptsEqual(current.script, input.script)) {
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
 * Undo/redo: restore an earlier revision's script as a NEW revision that
 * records where it came from. Rejected when the target differs from the
 * current revision in any played or locked portion — no partial reverts,
 * which is what keeps a pinned portion's text immutable by construction.
 */
export function revertToRevision(
  history: JamScriptHistory,
  targetRevision: number,
  minEditablePortionIndex: number,
  input: Omit<NewRevisionInput, "script" | "restoredFromRevision">,
): JamScriptHistory {
  const target = findRevision(history, targetRevision);
  if (!target) {
    throw new ScriptHistoryError(
      `Revision ${targetRevision} does not exist in this jam's history (it may have been truncated).`,
    );
  }
  const current = currentRevision(history);
  if (target.revision === current.revision) {
    throw new ScriptHistoryError(
      `Revision ${targetRevision} is already the current revision.`,
    );
  }
  if (
    portionsDifferBelow(current.script, target.script, minEditablePortionIndex)
  ) {
    throw new PortionLockedError(
      `Reverting to revision ${targetRevision} would change a played or locked portion.`,
      minEditablePortionIndex - 1,
    );
  }
  return appendRevision(history, {
    ...input,
    script: target.script,
    restoredFromRevision: target.revision,
  });
}

function buildRevision(
  revision: number,
  input: NewRevisionInput,
): ScriptRevision {
  return scriptRevisionSchema.parse({
    revision,
    script: input.script,
    createdAt: input.createdAt,
    authorId: input.authorId,
    note: input.note,
    restoredFromRevision: input.restoredFromRevision,
  });
}

function scriptsEqual(a: JamScript, b: JamScript): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Flat portion addressing -----------------------------------------------
// Portions are addressed by a zero-based global index in flattened scene
// order. v1 forbids structural edits (no insert/delete/reorder), so flat
// indices — and the generation job keys built on them — stay stable for the
// lifetime of a jam.

export const portionPatchSchema = z
  .object({
    action: z.string().trim().min(1).max(600).optional(),
    dialogue: z.string().trim().max(600).optional(),
    visualDirection: z.string().trim().max(400).optional(),
    durationSeconds: z.number().int().optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    { message: "A portion patch must change at least one field." },
  );

export type PortionPatch = z.infer<typeof portionPatchSchema>;

export function portionCount(script: JamScript): number {
  return script.scenes.reduce((sum, scene) => sum + scene.portions.length, 0);
}

export function getPortionAt(
  script: JamScript,
  flatIndex: number,
): { sceneIndex: number; portionIndex: number; portion: ScenePortion } | null {
  if (!Number.isInteger(flatIndex) || flatIndex < 0) return null;
  let remaining = flatIndex;
  for (let sceneIndex = 0; sceneIndex < script.scenes.length; sceneIndex += 1) {
    const portions = script.scenes[sceneIndex].portions;
    if (remaining < portions.length) {
      return { sceneIndex, portionIndex: remaining, portion: portions[remaining] };
    }
    remaining -= portions.length;
  }
  return null;
}

/**
 * Apply a content patch to one portion, returning a new script. Duration
 * edits validate against the jam format's hard portion bounds only — the
 * total-runtime tolerance is deliberately NOT re-enforced on live edits, so
 * changing one portion never forces compensating edits elsewhere.
 */
export function applyPortionPatch(
  script: JamScript,
  flatIndex: number,
  patch: PortionPatch,
  format: ScriptFormat,
): JamScript {
  const target = getPortionAt(script, flatIndex);
  if (!target) {
    throw new ScriptHistoryError(
      `Portion ${flatIndex} does not exist; this script has ${portionCount(script)} portions.`,
    );
  }
  if (patch.durationSeconds !== undefined) {
    const bounds = hardPortionBounds(format);
    if (
      patch.durationSeconds < bounds.min ||
      patch.durationSeconds > bounds.max
    ) {
      throw new ScriptHistoryError(
        `Portion duration must stay between ${bounds.min}s and ${bounds.max}s for this jam's format.`,
      );
    }
  }
  const updated: ScenePortion = { ...target.portion };
  if (patch.action !== undefined) updated.action = patch.action;
  if (patch.dialogue !== undefined) updated.dialogue = patch.dialogue;
  if (patch.visualDirection !== undefined) {
    updated.visualDirection = patch.visualDirection;
  }
  if (patch.durationSeconds !== undefined) {
    updated.durationSeconds = patch.durationSeconds;
  }
  return jamScriptSchema.parse({
    ...script,
    scenes: script.scenes.map((scene, sceneIndex) =>
      sceneIndex === target.sceneIndex
        ? {
            ...scene,
            portions: scene.portions.map((portion, portionIndex) =>
              portionIndex === target.portionIndex ? updated : portion,
            ),
          }
        : scene,
    ),
  });
}

/** True when any portion with flat index below the boundary differs. */
export function portionsDifferBelow(
  a: JamScript,
  b: JamScript,
  minEditablePortionIndex: number,
): boolean {
  const limit = Math.min(
    minEditablePortionIndex,
    Math.max(portionCount(a), portionCount(b)),
  );
  for (let index = 0; index < limit; index += 1) {
    const left = getPortionAt(a, index)?.portion;
    const right = getPortionAt(b, index)?.portion;
    if (JSON.stringify(left) !== JSON.stringify(right)) return true;
  }
  return false;
}
