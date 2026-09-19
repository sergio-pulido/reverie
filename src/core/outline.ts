import { z } from "zod";
import { BEAT_MAX_CHARS, type JamScript } from "./script";

// The outline is an intermediate artifact between the script and the reader:
// one brief phrase per portion, coherent as a sequence, so a participant can
// see what is coming and steer it without reading the whole screenplay.
//
// It is a projection, never a second store. Each beat is the `summary` field of
// the portion it describes, so a beat cannot drift from its portion and it
// versions with the append-only revision snapshots for free. The flat,
// zero-based portion index stays the single address, shared with edits,
// playback, the lock window and generation job keys.

export interface Beat {
  /** Flat, zero-based portion index — the address shared with every other surface. */
  portionIndex: number;
  /** The one-phrase summary, or undefined for a revision written before outlines existed. */
  summary?: string;
  durationSeconds: number;
  /** Cumulative seconds before this portion; the stream timeline offset. */
  startSeconds: number;
  /** Scene this portion belongs to, for grouping the outline under its headings. */
  sceneIndex: number;
  sceneHeading: string;
}

/** Projects a script into its ordered beat list. Pure: no store, no provider. */
export function buildOutline(script: JamScript): Beat[] {
  const beats: Beat[] = [];
  let portionIndex = 0;
  let startSeconds = 0;
  script.scenes.forEach((scene, sceneIndex) => {
    for (const portion of scene.portions) {
      beats.push({
        portionIndex,
        summary: portion.summary,
        durationSeconds: portion.durationSeconds,
        startSeconds,
        sceneIndex,
        sceneHeading: scene.heading,
      });
      portionIndex += 1;
      startSeconds += portion.durationSeconds;
    }
  });
  return beats;
}

/**
 * The beat a stream at `offsetSeconds` is currently rendering, or the first beat
 * when the offset is not yet known. Used to decide which beat is worth sending
 * as live direction; a cascade rewrites many beats, but only the one in play can
 * still affect what the viewer sees.
 */
export function beatAtOffset(
  beats: Beat[],
  offsetSeconds: number | null,
): Beat | undefined {
  if (beats.length === 0) return undefined;
  if (offsetSeconds === null) return beats[0];
  for (let index = beats.length - 1; index >= 0; index -= 1) {
    if (offsetSeconds >= beats[index].startSeconds) return beats[index];
  }
  return beats[0];
}
