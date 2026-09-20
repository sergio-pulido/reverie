import type { BeatState } from "../core/directorTimeline";

/**
 * What each beat state is called, once, so the timeline and the direction
 * column never describe the same beat two different ways.
 */
export const BEAT_STATE_LABEL: Readonly<Record<BeatState, string>> = {
  written: "Written",
  blocked: "Blocked",
  locked: "Locked",
  generating: "Generating",
  ready: "Ready",
};

/** What the state means, for the row that explains the timeline's treatments. */
export const BEAT_STATE_MEANING: Readonly<Record<BeatState, string>> = {
  written: "in the script, not generated, still open to direction",
  blocked: "the budget left cannot pay for its seconds",
  locked: "already with the provider, too late to change",
  generating: "being generated right now",
  ready: "generated, and in this session's video",
};
