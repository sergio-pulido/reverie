import { applyOutcome, resolveAction } from "../src/core/escape/rules";
import type { Scenario } from "../src/core/escape/scenario";
import { goalReached, openScenario, type EscapeState } from "../src/core/escape/state";

/**
 * Exhaustive search over a scenario, used by the data tests.
 *
 * It expands only `advanced` transitions, which is the point: every state it
 * reaches is one the rules actually produced, so a property proved over this
 * graph is a property of what a room can really play into.
 */

/** The world, without the path taken to it: two logs can reach one world. */
export function worldKey(state: EscapeState): string {
  return JSON.stringify([state.at, state.things]);
}

export interface Exploration {
  /** Shortest-log state for every reachable world. */
  readonly worlds: Map<string, EscapeState>;
  /** Every reachable world in which the goal holds, shortest log first. */
  readonly goals: EscapeState[];
}

export function explore(scenario: Scenario, maxWorlds = 200_000): Exploration {
  const start = openScenario(scenario);
  const worlds = new Map<string, EscapeState>([[worldKey(start), start]]);
  const goals: EscapeState[] = [];
  const queue: EscapeState[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const state = queue[head];
    // A goal world is an ending: expanding past it would describe play that
    // the session would already have stopped.
    if (goalReached(scenario, state)) {
      goals.push(state);
      continue;
    }
    for (const action of scenario.actions) {
      const outcome = resolveAction(scenario, state, action);
      if (outcome.kind !== "advanced") continue;
      const next = applyOutcome(scenario, state, outcome);
      const key = worldKey(next);
      if (worlds.has(key)) continue;
      if (worlds.size >= maxWorlds) {
        throw new RangeError(`${scenario.id} reaches more than ${maxWorlds} worlds.`);
      }
      worlds.set(key, next);
      queue.push(next);
    }
  }
  return { worlds, goals };
}

/** Replays action ids from the opening state, skipping any that will not apply. */
export function replay(scenario: Scenario, actionIds: readonly string[]): EscapeState {
  let state = openScenario(scenario);
  for (const actionId of actionIds) {
    const action = scenario.actions.find((candidate) => candidate.id === actionId);
    if (!action) continue;
    state = applyOutcome(scenario, state, resolveAction(scenario, state, action));
  }
  return state;
}
