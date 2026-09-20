import { outcomeOf, type DirectionOutcome, type DirectorAuditEntry } from "./directorAudit";
import {
  beatOffsets,
  currentBeatIndex,
  isBeatLocked,
  type DirectorBeatWindow,
} from "./directorBeats";
import { canAfford, type DirectorSpend } from "./directorSpend";
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
 * - `generating` — it is with the provider right now.
 * - `playing` — the viewer is inside it. A different question from
 *   `generating`, and the two are usually different beats: see below.
 * - `ready` — the stream has produced it, so it is in this session's video.
 * - `locked` — closed to direction but not yet produced: the beat committed
 *   ahead of playback, which is exactly the gap the closing rule creates.
 * - `blocked` — the budget left cannot pay for its seconds.
 * - `written` — in the script, not generated, still open to direction.
 */
export type BeatState =
  | "written"
  | "blocked"
  | "locked"
  | "generating"
  | "playing"
  | "ready";

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
  /**
   * Where the viewer is, in seconds from the top of the film. Null when
   * nothing is playing.
   *
   * Deliberately NOT the same number as the window's position, and this is
   * the distinction the screen was missing. The window comes from
   * `chunk.script_offset_seconds`, which a paid probe (2026-09-20) showed
   * arrives once per ten-second chunk and reports the GENERATION FRONTIER —
   * how far ahead of the viewer the provider has run. Driving "what is on
   * screen" from it named the wrong beat and moved it in ten-second lurches.
   * The playhead is continuous and is the viewer's own position.
   */
  playheadSeconds: number | null;
  spend: DirectorSpend;
}

/**
 * One beat's state, from the stream's frontier, the viewer's playhead and
 * what the budget can pay for.
 *
 * `generating` is resolved before `playing` on purpose. At the live edge the
 * viewer is inside the very beat the provider is making, and both are true;
 * saying it is being generated is the stronger claim, and the continuous
 * playhead marker still shows where inside it the viewer is. Behind the edge
 * the two are different beats and each gets its own treatment.
 */
export function beatStateOf(
  beat: Beat,
  { window, producedThrough, playheadSeconds, spend }: TimelineInput,
): BeatState {
  const playing =
    playheadSeconds !== null &&
    playheadSeconds >= beat.startSeconds &&
    playheadSeconds < beat.startSeconds + beat.durationSeconds;
  if (window) {
    if (window.currentBeatIndex === null) {
      // Nothing generated yet: the provider starts at the top of the film, so
      // the opening beat is the one being made. NOT `lockedBeatIndex` — that
      // is the last beat handed over, which is several ahead of where the
      // provider has actually started.
      if (beat.portionIndex === 0) return "generating";
    } else {
      if (beat.portionIndex === window.currentBeatIndex) return "generating";
      if (playing) return "playing";
      if (beat.portionIndex < window.currentBeatIndex) return "ready";
    }
    if (playing) return "playing";
    if (isBeatLocked(window, beat.portionIndex)) return "locked";
  } else if (producedThrough !== null && beat.portionIndex <= producedThrough) {
    return playing ? "playing" : "ready";
  }
  return canAfford(spend, beat.durationSeconds) ? "written" : "blocked";
}

/**
 * True when a beat has gone to the provider, so direction aimed at it is
 * refused.
 *
 * One answer to that question, for every part of the screen that asks it. A
 * beat on screen counts: the viewer is watching it, so it was generated, and
 * "on screen" being a separate state from "ready" must not quietly reopen it.
 */
export function isBeatClosed(state: BeatState): boolean {
  return (
    state === "locked" || state === "generating" || state === "playing" || state === "ready"
  );
}

/** The film's beats in order, each carrying its state. */
export function buildTimeline(script: JamScript, input: TimelineInput): TimelineBeat[] {
  return buildOutline(script).map((beat) => ({
    ...beat,
    number: beat.portionIndex + 1,
    state: beatStateOf(beat, input),
  }));
}

/** The first beat the budget cannot pay for, or null when it can pay for all of them. */
export function firstBlockedBeat(beats: readonly TimelineBeat[]): TimelineBeat | null {
  return beats.find((beat) => beat.state === "blocked") ?? null;
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
