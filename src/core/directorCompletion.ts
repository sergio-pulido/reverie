import type { DirectorState } from "./directorProtocol";
import { totalDurationSeconds } from "./script";

/**
 * The two different ends of a take, which are not the same moment.
 *
 * GENERATION ends first, and by a long way. The provider is told the script
 * once and then runs ahead of everybody: four measured takes on 2026-09-20
 * generated a whole 20-second film in 17 seconds of wall clock, the second and
 * final chunk landing before hls.js had a playable segment. So "the film has
 * been generated" is a fact about the provider, recorded because it is worth
 * knowing, and it is NOT a reason to end anything.
 *
 * PLAYBACK ends when the viewer has actually watched to the end of the film,
 * and that is what stops a take. It is the only reading that cannot cut a film
 * off before it has been seen, because it is a measurement of the seeing —
 * time since Play says nothing, and neither does the provider's progress.
 *
 * The cost of waiting is real and bounded elsewhere: the provider keeps
 * generating past the last beat while the viewer catches up, and the session
 * ceiling (`maxSessionSeconds`) is what caps that.
 */

/** Which reading said the whole film had been generated. */
export type CompletionSignal = "generated" | "frontier";

export interface CompletionReading {
  /** The film's selected length: the script's own total runtime. */
  runtimeSeconds: number;
  /** Seconds of film the provider has produced so far. */
  generatedSeconds: number;
  /** The provider's frontier, when it reports one. */
  scriptOffsetSeconds: number | null;
}

/**
 * The signal that says the whole film has been generated, or null while it
 * has not.
 *
 * A runtime of zero is not a film of no length; it is a script this server
 * cannot time, and stopping a take the instant it opens would be the worst
 * possible reading of that. Such a take runs to the session ceiling instead.
 */
export function completionSignal(reading: CompletionReading): CompletionSignal | null {
  if (!(reading.runtimeSeconds > 0)) return null;
  if (reading.generatedSeconds >= reading.runtimeSeconds) return "generated";
  const frontier = reading.scriptOffsetSeconds;
  if (frontier !== null && frontier >= reading.runtimeSeconds) return "frontier";
  return null;
}

/** The same question asked of a stream's state and the script it is generating. */
export function completionOf(
  state: DirectorState,
  script: { scenes: { portions: { durationSeconds: number }[] }[] },
): CompletionSignal | null {
  return completionSignal({
    runtimeSeconds: totalDurationSeconds(script),
    generatedSeconds: state.generatedSeconds,
    scriptOffsetSeconds: state.scriptOffsetSeconds,
  });
}

/**
 * How the trail describes the moment the whole film existed.
 *
 * Which of the two readings crossed first is a fact about the provider's
 * reporting, and belongs in the audit detail rather than in what a room is
 * told.
 */
export function completionDetail(
  signal: CompletionSignal,
  reading: CompletionReading,
): string {
  const measured =
    signal === "generated"
      ? `${round(reading.generatedSeconds)}s generated`
      : `frontier at ${round(reading.scriptOffsetSeconds ?? 0)}s`;
  return `${measured} of a ${round(reading.runtimeSeconds)}s film`;
}

function round(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}

/**
 * A media element can stall a hair short of a film's last frame, and the
 * playhead is sampled four times a second, so "reached the end" has to carry
 * a tolerance or a take would run to the session ceiling over a rounding
 * error. A quarter of a second is the sampling interval: shorter cannot be
 * observed, longer would visibly clip the last frame.
 */
export const PLAYED_TO_END_TOLERANCE_SECONDS = 0.25;

/**
 * Has the viewer actually watched to the end of the film?
 *
 * This is the whole stop rule, and the reason it takes a PLAYED position
 * rather than an elapsed time: a take that ends on the clock ends while the
 * provider is still ahead of the viewer, which is how four takes were torn
 * down 1ms after their last chunk and showed nothing at all. Time since Play
 * is not evidence that anything was seen. Neither is the provider's progress.
 *
 * A null playhead is a film that is not playing here — paused, nothing
 * decoded, or no element at all — and never an end. A film of unknown length
 * has no end to reach.
 */
export function playedToEnd(
  playheadSeconds: number | null,
  filmSeconds: number | null,
): boolean {
  if (playheadSeconds === null || filmSeconds === null) return false;
  if (!(filmSeconds > 0)) return false;
  return playheadSeconds >= filmSeconds - PLAYED_TO_END_TOLERANCE_SECONDS;
}
