import { z } from "zod";
import type { JamScript, Scene, ScenePortion } from "./script";

// Server-owned playback state (docs/API_CONTRACTS.md, "Portion playback,
// locking, and video generation"). The lock window is derived from the
// cursor, never stored per portion.
export const playbackStateSchema = z.object({
  status: z.enum(["idle", "priming", "playing", "finished"]),
  currentPortionIndex: z.number().int().min(0).nullable(),
  stateVersion: z.number().int().min(1),
});

export type PlaybackState = z.infer<typeof playbackStateSchema>;

export class PlaybackError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_transition"
      | "stale_state_version"
      | "media_not_ready",
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PlaybackError";
  }
}

export function initialPlayback(): PlaybackState {
  return { status: "idle", currentPortionIndex: null, stateVersion: 1 };
}

export interface FlatPortion {
  portionIndex: number;
  sceneIndex: number;
  sceneHeading: string;
  portion: ScenePortion;
}

/** Flattened zero-based portion order — the single playback/media address. */
export function flattenPortions(script: JamScript): FlatPortion[] {
  const flat: FlatPortion[] = [];
  script.scenes.forEach((scene: Scene, sceneIndex: number) => {
    scene.portions.forEach((portion) => {
      flat.push({
        portionIndex: flat.length,
        sceneIndex,
        sceneHeading: scene.heading,
        portion,
      });
    });
  });
  return flat;
}

/**
 * Index of the locked generation-buffer portion, or null when nothing is
 * locked (idle, finished, or the last portion is already playing).
 */
export function lockedPortionIndex(
  state: PlaybackState,
  portionCount: number,
): number | null {
  if (state.status === "priming") return 0;
  if (state.status !== "playing" || state.currentPortionIndex === null) {
    return null;
  }
  const next = state.currentPortionIndex + 1;
  return next < portionCount ? next : null;
}

/**
 * First portion index that live edits may still touch. Everything below is
 * played, playing, or locked for generation. `portionCount` when nothing is
 * editable any more.
 */
export function minEditablePortionIndex(
  state: PlaybackState,
  portionCount: number,
): number {
  switch (state.status) {
    case "idle":
      return 0;
    case "priming":
      return 1;
    case "playing":
      return Math.min((state.currentPortionIndex ?? 0) + 2, portionCount);
    case "finished":
      return portionCount;
  }
}

/** idle → priming: portion 0 becomes the locked generation buffer. */
export function startPlayback(state: PlaybackState): PlaybackState {
  if (state.status !== "idle") {
    throw new PlaybackError(
      "Playback has already started.",
      "invalid_transition",
      false,
    );
  }
  return {
    status: "priming",
    currentPortionIndex: null,
    stateVersion: state.stateVersion + 1,
  };
}

/**
 * Move forward by exactly one portion: priming → playing portion 0, or
 * playing N → playing N+1, or playing the last portion → finished. The
 * caller must have verified the target portion's media is ready.
 */
export function advancePlayback(
  state: PlaybackState,
  portionCount: number,
): PlaybackState {
  if (state.status === "priming") {
    return {
      status: "playing",
      currentPortionIndex: 0,
      stateVersion: state.stateVersion + 1,
    };
  }
  if (state.status !== "playing" || state.currentPortionIndex === null) {
    throw new PlaybackError(
      "Playback is not running.",
      "invalid_transition",
      false,
    );
  }
  const next = state.currentPortionIndex + 1;
  if (next >= portionCount) {
    return {
      status: "finished",
      currentPortionIndex: null,
      stateVersion: state.stateVersion + 1,
    };
  }
  return {
    status: "playing",
    currentPortionIndex: next,
    stateVersion: state.stateVersion + 1,
  };
}
