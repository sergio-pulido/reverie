import { useCallback, useEffect, useRef, useState } from "react";
import { buildOutline } from "../core/outline";
import type { OutlineEditRecord } from "../core/outlineEdit";
import type { JamScript } from "../core/script";
import {
  listOutlineEdits,
  OutlineError,
  readOutline,
  submitOutlineDirection,
  type OutlineSnapshot,
} from "../lib/outline";

/**
 * The film's story as the Director screen steers it.
 *
 * The screen's script used to be read once, when the session opened, which was
 * right while direction only ever reached the provider. It no longer is: a
 * direction now lands as a beat and re-derives every beat after it, so the
 * phrases on the timeline change while the screen is open and have to be read
 * again to be seen.
 *
 * Polling, like every other surface in this build, until Realtime events land.
 * It quickens while an edit is in flight, because that is the one stretch
 * where the room is waiting to see what its words did.
 */

const IDLE_POLL_MS = 4_000;
const BUSY_POLL_MS = 1_000;
/** How long a beat wears the mark that it has just been rewritten. */
export const CHANGED_MS = 8_000;

const NOTHING_CHANGED: ReadonlySet<number> = new Set();

export interface DirectorStory {
  /** The current revision's script, or null until one has been read. */
  script: JamScript | null;
  revision: number | null;
  /** Edits queued or being rewritten right now. */
  pending: number;
  /** The ledger, newest first, so the room can see what became of each ask. */
  edits: OutlineEditRecord[];
  /** Beats whose phrase changed in the revision just read, for a moment. */
  changed: ReadonlySet<number>;
  /** False when this server holds no outline for the jam. */
  available: boolean;
  /** True while a direction is being aimed at a beat. */
  aiming: boolean;
  failure: string | null;
  /** Sends one direction. `beatIndex` pins it; otherwise the server aims it. */
  direct: (body: string, beatIndex?: number) => Promise<boolean>;
  dismissFailure: () => void;
}

export function useDirectorStory(jamId: string | null): DirectorStory {
  const [snapshot, setSnapshot] = useState<OutlineSnapshot | null>(null);
  const [edits, setEdits] = useState<OutlineEditRecord[]>([]);
  const [available, setAvailable] = useState(true);
  const [aiming, setAiming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [changed, setChanged] = useState<ReadonlySet<number>>(NOTHING_CHANGED);
  /** The phrases as they last read, so a new revision can say what moved. */
  const phrases = useRef<Map<number, string | undefined> | null>(null);
  const fade = useRef<number | null>(null);

  /** Marks the beats this revision rewrote, and lets the mark fade. */
  const noteChanges = useCallback((script: JamScript) => {
    const next = new Map(buildOutline(script).map((beat) => [beat.portionIndex, beat.summary]));
    const before = phrases.current;
    phrases.current = next;
    // The first read is the baseline, never a change: everything would be new.
    if (!before) return;
    const moved = new Set<number>();
    for (const [index, summary] of next) {
      if (before.get(index) !== summary) moved.add(index);
    }
    if (moved.size === 0) return;
    setChanged(moved);
    if (fade.current !== null) window.clearTimeout(fade.current);
    fade.current = window.setTimeout(() => setChanged(NOTHING_CHANGED), CHANGED_MS);
  }, []);

  useEffect(
    () => () => {
      if (fade.current !== null) window.clearTimeout(fade.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!jamId) return;
    try {
      const [next, ledger] = await Promise.all([readOutline(jamId), listOutlineEdits(jamId)]);
      setSnapshot(next);
      setEdits(ledger);
      setAvailable(true);
      noteChanges(next.script);
    } catch (error) {
      // No outline is a state of the room, and the screen says so. Any other
      // failure is one poll that did not answer: the next one usually does,
      // and a notice per tick would bury the ones that matter.
      if (error instanceof OutlineError && error.code === "not_found") setAvailable(false);
    }
  }, [jamId, noteChanges]);

  const busy = aiming || (snapshot?.pending ?? 0) > 0;

  useEffect(() => {
    if (!jamId) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, jamId, refresh]);

  const direct = useCallback(
    async (body: string, beatIndex?: number) => {
      const said = body.trim();
      if (!jamId || !said) return false;
      setAiming(true);
      setFailure(null);
      try {
        // No `expectedRevision`. The panel sends one because a person there is
        // replacing a phrase they just read; a direction describes a change
        // instead, and stays exactly as meaningful against the revision a beat
        // that landed a second ago produced. Refusing it as stale would only
        // lose the ask.
        await submitOutlineDirection(jamId, {
          requestId: crypto.randomUUID(),
          body: said,
          ...(beatIndex === undefined ? {} : { beatIndex }),
        });
        await refresh();
        return true;
      } catch (error) {
        setFailure(
          error instanceof Error ? error.message : "That direction could not be sent.",
        );
        return false;
      } finally {
        setAiming(false);
      }
    },
    [jamId, refresh],
  );

  return {
    script: snapshot?.script ?? null,
    revision: snapshot?.revision ?? null,
    pending: snapshot?.pending ?? 0,
    edits,
    changed,
    available,
    aiming,
    failure,
    direct,
    dismissFailure: useCallback(() => setFailure(null), []),
  };
}
