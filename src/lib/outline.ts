import type { DirectorBeatWindow } from "../core/directorBeats";
import type { Beat } from "../core/outline";
import type { OutlineEditCommand, OutlineEditRecord } from "../core/outlineEdit";
import type { JamScript } from "../core/script";

/**
 * Client for the outline: the beats of the current revision, the lock window
 * the live director imposes, and the queue every edit goes through. The
 * server decides everything; this only asks and renders.
 */

export interface OutlineBeat extends Beat {
  locked: boolean;
}

export interface OutlineSnapshot {
  revision: number;
  script: JamScript;
  beats: OutlineBeat[];
  window: DirectorBeatWindow;
  pending: number;
}

export class OutlineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** The current revision, when the server attached one to a stale refusal. */
    readonly revision?: number,
  ) {
    super(message);
    this.name = "OutlineError";
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as
    | { error?: { code?: string; safeMessage?: string }; revision?: number }
    | null;
  if (!response.ok) {
    const error = body?.error;
    throw new OutlineError(
      typeof error?.safeMessage === "string" ? error.safeMessage : "The outline is not available.",
      typeof error?.code === "string" ? error.code : "outline_unavailable",
      typeof body?.revision === "number" ? body.revision : undefined,
    );
  }
  return body as T;
}

export function readOutline(jamId: string): Promise<OutlineSnapshot> {
  return call<OutlineSnapshot>(`/api/jams/${jamId}/outline`);
}

export async function submitOutlineEdit(
  jamId: string,
  command: OutlineEditCommand,
): Promise<OutlineEditRecord> {
  const { edit } = await call<{ edit: OutlineEditRecord }>(`/api/jams/${jamId}/outline/edits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  return edit;
}

export async function listOutlineEdits(jamId: string): Promise<OutlineEditRecord[]> {
  const { edits } = await call<{ edits: OutlineEditRecord[] }>(`/api/jams/${jamId}/outline/edits`);
  return edits;
}
