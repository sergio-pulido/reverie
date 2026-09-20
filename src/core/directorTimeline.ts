import { outcomeOf, type DirectionOutcome, type DirectorAuditEntry } from "./directorAudit";
import {
  beatOffsets,
  currentBeatIndex,
  isBeatLocked,
  type DirectorBeatWindow,
} from "./directorBeats";
import { buildOutline, type Beat } from "./outline";
import type { JamScript } from "./script";

/**
 * The film's beats as the Director screen draws them, and the turns that
 * steered them. Pure: the screen renders this, it does not work it out.
 *
 * The closing rule is NOT restated here. `./directorBeats` owns it — the beat
 * on screen and the one behind it are with the provider, and editing resumes
 * two beats ahead — and this module asks it (`isBeatLocked`) rather than
 * deciding for itself. Two answers to "can this beat still change?" would be
 * worse than either alone.
 */

/**
 * What a beat is doing, in the order the screen resolves them.
 *
 * - `ready` — the stream has produced it, so it is in this session's video.
 * - `generating` — it is with the provider right now.
 * - `locked` — closed to direction but not yet produced: the beat committed
 *   ahead of playback, which is exactly the gap the closing rule creates.
 * - `written` — in the script, not generated, still open to direction.
 */
export type BeatState = "written" | "locked" | "generating" | "ready";

export interface TimelineBeat extends Beat {
  /** What the row numbers it: one-based, the way a person counts shots. */
  number: number;
  state: BeatState;
}

export interface TimelineInput {
  /** The stream's window while a session is open; null when none is. */
  window: DirectorBeatWindow | null;
  /**
   * Highest beat this session's stream reached, kept after it stops so a
   * finished film still says which beats exist. Null when none was reached.
   */
  producedThrough: number | null;
}

/** One beat's state, from the stream's window alone. */
export function beatStateOf(
  beat: Beat,
  { window, producedThrough }: TimelineInput,
): BeatState {
  if (window) {
    if (window.currentBeatIndex === null) {
      // Nothing on screen yet: the opening beat went to the provider with the
      // configure message, so it is already being generated.
      if (beat.portionIndex === window.lockedBeatIndex) return "generating";
    } else {
      if (beat.portionIndex === window.currentBeatIndex) return "generating";
      if (beat.portionIndex < window.currentBeatIndex) return "ready";
    }
    if (isBeatLocked(window, beat.portionIndex)) return "locked";
  } else if (producedThrough !== null && beat.portionIndex <= producedThrough) {
    return "ready";
  }
  return "written";
}

/** The film's beats in order, each carrying its state. */
export function buildTimeline(script: JamScript, input: TimelineInput): TimelineBeat[] {
  return buildOutline(script).map((beat) => ({
    ...beat,
    number: beat.portionIndex + 1,
    state: beatStateOf(beat, input),
  }));
}

/** One direction the session sent, and what became of it. */
export interface DirectionTurn {
  /** fal's per-session version for this direction; the identity of the turn. */
  promptVersion: number;
  at: string;
  body: string;
  outcome: DirectionOutcome;
  /**
   * The beat this turn is about: the one it names, or failing that the one
   * that was playing when it was sent. Null when the trail records neither,
   * which is what a direction sent before the first chunk looks like.
   */
  beatIndex: number | null;
}

/**
 * Which beat a trail entry is about.
 *
 * A direction that names a beat is about that beat. One that does not is
 * about whatever was on screen when it was sent, which is why the trail
 * records the script offset at all — it is the question an audit gets asked.
 */
export function beatOfTurn(
  entry: DirectorAuditEntry,
  offsets: readonly number[],
): number | null {
  if (entry.beatIndex !== undefined) return entry.beatIndex;
  if (entry.scriptOffsetSeconds === undefined) return null;
  return currentBeatIndex(offsets, entry.scriptOffsetSeconds);
}

/** The session's directions, newest last, each resolved against the trail. */
export function directionTurns(
  entries: readonly DirectorAuditEntry[],
  script: JamScript | null,
): DirectionTurn[] {
  const offsets = script ? beatOffsets(script) : [];
  return entries
    .filter((entry) => entry.kind === "direction_sent" && entry.promptVersion !== undefined)
    .map((entry) => ({
      promptVersion: entry.promptVersion as number,
      at: entry.at,
      body: entry.body ?? "",
      outcome: outcomeOf(entries, entry.promptVersion as number),
      beatIndex: beatOfTurn(entry, offsets),
    }));
}
