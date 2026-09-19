import { beatOffsets, currentBeatIndex } from "./directorBeats";
import type { JamScript } from "./script";

// The outline is an intermediate artifact between the script and the reader:
// one brief phrase per portion, coherent as a sequence, so a participant can
// see what is coming and steer it without reading the whole screenplay.
//
// It is a projection, never a second store. Each beat is the `summary` field of
// the portion it describes, so a beat cannot drift from its portion and it
// versions with the append-only revision snapshots for free. The flat,
// zero-based portion index stays the single address, shared with edits, the
// director's beat window and the lock boundary derived from it.
//
// The timeline arithmetic is NOT redefined here. `./directorBeats` already lays
// portions out at cumulative offsets and answers which beat a stream has
// reached; the outline adds the summary and the scene grouping on top of that
// same timeline, so the room's view and the stream's can never disagree about
// where a beat starts.

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
  const offsets = beatOffsets(script);
  const beats: Beat[] = [];
  let portionIndex = 0;
  script.scenes.forEach((scene, sceneIndex) => {
    for (const portion of scene.portions) {
      beats.push({
        portionIndex,
        summary: portion.summary,
        durationSeconds: portion.durationSeconds,
        startSeconds: offsets[portionIndex],
        sceneIndex,
        sceneHeading: scene.heading,
      });
      portionIndex += 1;
    }
  });
  return beats;
}

/**
 * The beat a stream at `offsetSeconds` is rendering, or `null` when the stream
 * has not reported a position yet.
 *
 * `null` is not the opening beat. "Nothing is playing" and "the first beat is
 * playing" are different claims, and a stream that has not yet sent a chunk has
 * made neither — collapsing them would send direction against a beat nobody is
 * watching. The distinction is `./directorBeats`'s, and is deferred to here
 * rather than restated.
 */
export function beatAt(beats: Beat[], offsetSeconds: number | null): Beat | null {
  const index = currentBeatIndex(
    beats.map((beat) => beat.startSeconds),
    offsetSeconds,
  );
  return index === null ? null : beats[index];
}
