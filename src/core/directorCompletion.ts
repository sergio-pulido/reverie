import type { DirectorState } from "./directorProtocol";
import { totalDurationSeconds } from "./script";

/**
 * When a take has reached the end of the film it was asked for.
 *
 * The provider does not stop at the last beat. It is told the script once, on
 * the control channel, and then it keeps generating until somebody tells it to
 * stop — a twenty-second script was measured running four chunks past its own
 * end. So the film's selected length is a boundary only this side enforces,
 * and every second past it is generated, billed and thrown away.
 *
 * Two independent readings say the end has arrived, and either is enough:
 *
 * - `generatedSeconds`, the sum of each chunk's `playback_seconds`, is how
 *   much film actually exists. It is the exact answer and normally the first
 *   to cross.
 * - `scriptOffsetSeconds` is the provider's frontier, and it is the START
 *   offset of the chunk being generated — measured, not assumed: a session
 *   reading 50 has 60 seconds in hand. So it crosses the runtime a whole chunk
 *   late, which makes it a backstop rather than the trigger: it still ends a
 *   take whose chunks report no playable duration to add up.
 *
 * Both are read from the control channel, so this answers even when the media
 * pipeline is producing nothing.
 */

/** Which reading said the film had reached its end. */
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
 * The signal that says this film is finished, or null while it is not.
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
 * How the trail and the room describe a stop nobody pressed.
 *
 * The two signals stop the same take for the same reason; which one crossed
 * first is a fact about the provider's reporting, and belongs in the audit
 * detail rather than in what the room is told.
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
