/**
 * A jam's life: live, playing, ended.
 *
 * A room exists before anything is generated, generates for a while, and then
 * stops — and what remains of a stopped room is its recording. The three
 * states are exactly those three situations, so "what can I do here" and
 * "what am I looking at" have one answer rather than being inferred from
 * whether some session id happens to be open.
 *
 * None of them is terminal. A room is a place, not a single take: anybody in
 * it can play it and anybody can stop it, and playing a stopped room opens a
 * new session rather than resurrecting the old one. Each session archives
 * separately, so a second take adds to the room's archive instead of
 * overwriting the first.
 *
 * Server-owned, like every other room transition. The browser projects this;
 * it never decides it. A client that believes a room is playing cannot make it
 * so, and a client that missed the stop still reads `ended` on its next look.
 */

export type JamLifecycle = "live" | "playing" | "ended";

/** What can happen to a room, as opposed to what a stream reports about itself. */
export type JamLifecycleEvent = "start" | "stop";

export type LifecycleRefusal = "already_playing" | "not_playing" | "already_ended";

export interface LifecycleTransition {
  ok: boolean;
  lifecycle: JamLifecycle;
  refusal?: LifecycleRefusal;
}

/**
 * Applies an event to a lifecycle.
 *
 * A stopped room plays again. The room is the place the story is being made,
 * and the stream is one take inside it; refusing a second take would mean a
 * misplaced Stop — which anybody in the room can now send — silently retires
 * the room for everyone. The takes do not overwrite each other: every session
 * keeps its own archive entry, and the room shows the most recent one.
 */
export function applyLifecycle(
  current: JamLifecycle,
  event: JamLifecycleEvent,
): LifecycleTransition {
  if (event === "start") {
    if (current === "playing") return refuse(current, "already_playing");
    return { ok: true, lifecycle: "playing" };
  }
  if (current === "ended") return refuse(current, "already_ended");
  // Stopping a room that never started is refused rather than quietly ending
  // it: it would archive a jam nobody watched and make the state unreadable.
  if (current !== "playing") return refuse(current, "not_playing");
  return { ok: true, lifecycle: "ended" };
}

function refuse(lifecycle: JamLifecycle, refusal: LifecycleRefusal): LifecycleTransition {
  return { ok: false, lifecycle, refusal };
}

/** Where a new room starts. It is open and joinable before anything generates. */
export const INITIAL_LIFECYCLE: JamLifecycle = "live";

/** A stopped room is the one with something to play back. */
export function hasRecording(lifecycle: JamLifecycle): boolean {
  return lifecycle === "ended";
}

export function lifecycleLabel(lifecycle: JamLifecycle): string {
  if (lifecycle === "playing") return "Playing";
  if (lifecycle === "ended") return "Stopped";
  return "Live";
}
