import type { JamScript } from "./script";

/**
 * Which beat of the outline a live stream is on, and which ones are closed.
 *
 * A beat is closed because **it has been handed to the provider**, and for no
 * other reason. The script is not given to fal all at once: `configure` takes
 * the opening chunk and each later chunk is handed the next beats, so at any
 * moment there is an exact number of seconds fal has been told about, and the
 * first beat past it is the first one an edit may still touch. That number is
 * `committedThroughSeconds` below.
 *
 * Where there is no stream to ask — a preview, a fixture — the old prediction
 * stands in: the beat being generated and the one after it are closed, and
 * editing resumes two beats ahead. It is a guess about what fal was given,
 * which is precisely why the stream no longer uses it.
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
  /**
   * Seconds of script that have actually been handed to the provider.
   *
   * This is the honest answer to "which beats can still change", and it is a
   * RECORD rather than a prediction: a beat is closed because it was sent, not
   * because of where the stream has got to. Null for a caller with no stream
   * to ask — a preview, a fixture — which falls back to the rule below.
   */
  committedThroughSeconds: number | null = null,
): DirectorBeatWindow {
  const count = offsets.length;
  const current = currentBeatIndex(offsets, scriptOffsetSeconds);
  if (committedThroughSeconds !== null) {
    // The first beat that has NOT been sent is the first one an edit may still
    // touch. Everything below it is with the provider.
    let minEditable = count;
    for (let index = 0; index < count; index += 1) {
      if (offsets[index] >= committedThroughSeconds) {
        minEditable = index;
        break;
      }
    }
    const committed = minEditable - 1;
    return {
      currentBeatIndex: current,
      // The beat behind the boundary, when it is not the one being generated:
      // "locked" names a beat that is spoken for but not yet on screen.
      lockedBeatIndex: committed >= 0 && committed > (current ?? -1) ? committed : null,
      minEditableBeatIndex: minEditable,
    };
  }
  if (current === null) {
    // Configured but not yet playing. The opening beat went to the provider
    // with the configure message, so it is already committed — the same shape
    // as the player's "priming" state.
    return {
      currentBeatIndex: null,
      lockedBeatIndex: count > 0 ? 0 : null,
      minEditableBeatIndex: Math.min(1, count),
    };
  }
  const locked = current + 1;
  return {
    currentBeatIndex: current,
    lockedBeatIndex: locked < count ? locked : null,
    minEditableBeatIndex: Math.min(current + 2, count),
  };
}

/**
 * Seconds of script that must be in the provider's hands for the beat being
 * generated AND the one after it to be closed.
 *
 * The room's own rule, and the one the screen states: you cannot change what
 * is being made, nor the thing straight after it, because by the time you saw
 * the one you are watching the next was already being planned. Under the
 * hand-over that rule has to be *made* true rather than asserted — a beat is
 * closed only because it was sent — so this is what the stream hands over at
 * a minimum, whatever the chunk length happens to be.
 *
 * `Infinity` when the film has no such beat left: within two beats of the end
 * there is nothing further to protect, and the caller caps it at the runtime.
 */
export function twoBeatsAhead(
  offsets: readonly number[],
  scriptOffsetSeconds: number | null,
): number {
  // Before the first chunk the provider is on the opening beat.
  const next = (currentBeatIndex(offsets, scriptOffsetSeconds) ?? 0) + 2;
  return next < offsets.length ? offsets[next] : Number.POSITIVE_INFINITY;
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
  committedThroughSeconds: number | null = null,
): DirectorBeatWindow {
  return beatWindow(beatOffsets(script), scriptOffsetSeconds, committedThroughSeconds);
}
