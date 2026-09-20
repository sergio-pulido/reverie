import type { JamScript } from "./script";

/**
 * Which beat of the outline a live stream is on, and which ones are closed.
 *
 * The rule is the player's rule, deliberately: the beat being generated and
 * the one after it are closed, and editing resumes two beats ahead. A live
 * stream generates ahead of playback, so by the time a viewer sees beat N the
 * provider is already committed to N+1 — blocking it is what gives the room
 * time to react to a change instead of discovering it on screen.
 *
 * This is about what fal has DISPATCHED, not about what it has been told. It
 * holds the whole script from `configure` (it starves and wraps on anything
 * less), and a change replaces that script for everything it has not yet
 * dispatched — so what a beat can still be is decided by where the stream has
 * got to, which is what this measures.
 *
 * See `lockedPortionIndex` / `minEditablePortionIndex` in ./playback, which
 * express the same window for stored portions.
 */

export interface DirectorBeatWindow {
  /** Beat currently on screen, or null before the first chunk arrives. */
  currentBeatIndex: number | null;
  /** Beat already committed to generation. Closed to edits. */
  lockedBeatIndex: number | null;
  /** First beat an edit may still change. `beatCount` when none may. */
  minEditableBeatIndex: number;
}

/**
 * Beat start offsets, in whole seconds from the top of the stream.
 *
 * A portion becomes a beat at its cumulative start, which is how Director
 * describes a script beat, so the outline's timeline and the stream's agree.
 */
export function beatOffsets(script: JamScript): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const scene of script.scenes) {
    for (const portion of scene.portions) {
      offsets.push(offset);
      offset += portion.durationSeconds;
    }
  }
  return offsets;
}

/** The beat playing at `scriptOffsetSeconds`, or null if nothing is yet. */
export function currentBeatIndex(
  offsets: readonly number[],
  scriptOffsetSeconds: number | null,
): number | null {
  if (scriptOffsetSeconds === null || offsets.length === 0) return null;
  let current: number | null = null;
  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index] <= scriptOffsetSeconds) current = index;
    else break;
  }
  return current;
}

export function beatWindow(
  offsets: readonly number[],
  scriptOffsetSeconds: number | null,
): DirectorBeatWindow {
  const count = offsets.length;
  const current = currentBeatIndex(offsets, scriptOffsetSeconds);
  if (current === null) {
    // Configured but not yet playing. fal starts at the top of the film, so
    // the opening beat is the one being generated and the one after it is the
    // one already spoken for — the same two the rule closes at every other
    // moment, applied at beat zero rather than guessed at.
    return {
      currentBeatIndex: null,
      lockedBeatIndex: count > 1 ? 1 : count > 0 ? 0 : null,
      minEditableBeatIndex: Math.min(2, count),
    };
  }
  const locked = current + 1;
  return {
    currentBeatIndex: current,
    lockedBeatIndex: locked < count ? locked : null,
    minEditableBeatIndex: Math.min(current + 2, count),
  };
}

/** True when an edit to `beatIndex` would land on a closed beat. */
export function isBeatLocked(
  window: DirectorBeatWindow,
  beatIndex: number,
): boolean {
  return beatIndex < window.minEditableBeatIndex;
}

export function beatWindowForScript(
  script: JamScript,
  scriptOffsetSeconds: number | null,
): DirectorBeatWindow {
  return beatWindow(beatOffsets(script), scriptOffsetSeconds);
}
