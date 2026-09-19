import { interpret, type EscapeIntent } from "./intent";
import type { Effect, EscapeAction, Scenario } from "./scenario";
import { firstUnmet, isPresent, observe, type EscapeState, type ThingState } from "./state";

/**
 * The rules. This module decides what happened; nothing else may.
 *
 * It is pure: no network, no React, no clock, no randomness. Given a scenario,
 * a state and a proposal it answers with exactly one of three outcomes, and
 * only one of them changes the world. The model is handed the outcome
 * afterwards and writes prose and a shot from it — it is never asked whether
 * the key fits the drawer, because that answer has to be the same for every
 * participant, every replay and every retry.
 *
 * Two invariants are enforced here and tested in tests/escapeRules.test.ts:
 * an outcome that is not `advanced` returns the state it was given, by
 * identity; and an advanced outcome appends exactly one action id to the log,
 * so the goal is only ever reached through steps that actually happened.
 */

export interface OutcomeChange {
  readonly thingId?: string;
  readonly locationId?: string;
  readonly summary: string;
}

export interface AdvancedOutcome {
  readonly kind: "advanced";
  readonly actionId: string;
  /** The author's account of what just happened. */
  readonly tell: string;
  /** The camera the model must not contradict. */
  readonly shot: string;
  readonly seconds: number;
  readonly changes: readonly OutcomeChange[];
}

export interface FailedOutcome {
  readonly kind: "failed";
  readonly actionId: string;
  /** Authored: the `unmet` sentence of the condition that stopped it. */
  readonly reason: string;
}

export interface ImpossibleOutcome {
  readonly kind: "impossible";
  readonly reason: string;
}

export type EscapeOutcome = AdvancedOutcome | FailedOutcome | ImpossibleOutcome;

/**
 * Said when the words do not reach the world at all. Unlike a failure, this
 * is a fact about the proposal rather than about the scenario, so it is the
 * one sentence here the author does not write.
 */
export const UNREADABLE_REASON = "Nothing here answers to that.";

export function resolveIntent(
  scenario: Scenario,
  state: EscapeState,
  intent: EscapeIntent,
): EscapeOutcome {
  if (intent.kind === "unreadable") {
    return { kind: "impossible", reason: UNREADABLE_REASON };
  }
  if (intent.kind === "unaddressable") {
    const thing = scenario.things.find((candidate) => candidate.id === intent.thingId);
    return {
      kind: "impossible",
      reason: `${thing?.name ?? "It"} is not here.`,
    };
  }
  const action = scenario.actions.find((candidate) => candidate.id === intent.actionId);
  if (!action) return { kind: "impossible", reason: UNREADABLE_REASON };
  return resolveAction(scenario, state, action);
}

/**
 * One action against the world as it stands.
 *
 * Presence is checked before the authored conditions, and separately from
 * them: whether a thing can be reached at all is derived from where it is, so
 * an author cannot forget it and ship an action that works through a wall.
 */
export function resolveAction(
  scenario: Scenario,
  state: EscapeState,
  action: EscapeAction,
): EscapeOutcome {
  const target = scenario.things.find((candidate) => candidate.id === action.targetId);
  if (!target || !isPresent(scenario, state, action.targetId)) {
    return { kind: "impossible", reason: `${target?.name ?? "It"} is not here.` };
  }
  // Authored requirements are read before the automatic instrument check, so
  // an author who wrote a sentence about the missing tool gets to say it. The
  // check below is the net under an author who did not.
  const unmet = firstUnmet(state, action.requires);
  if (unmet) return { kind: "failed", actionId: action.id, reason: unmet.unmet };
  if (action.instrumentId) {
    const instrument = scenario.things.find((candidate) => candidate.id === action.instrumentId);
    if (!instrument || !isPresent(scenario, state, action.instrumentId)) {
      return {
        kind: "impossible",
        reason: `${instrument?.name ?? "That"} is not here to do it with.`,
      };
    }
  }
  return {
    kind: "advanced",
    actionId: action.id,
    tell: action.tell,
    shot: action.shot,
    seconds: action.seconds,
    changes: describeEffects(scenario, action.effects),
  };
}

/** Interpret and resolve in one step: what a settled proposal goes through. */
export function resolveProposal(
  scenario: Scenario,
  state: EscapeState,
  text: string,
): EscapeOutcome {
  return resolveIntent(scenario, state, interpret(scenario, state, text));
}

/**
 * The state after an outcome.
 *
 * Anything that is not `advanced` returns the very state it was handed, by
 * identity, so "an impossible action changes nothing" is checkable rather
 * than merely intended.
 */
export function applyOutcome(
  scenario: Scenario,
  state: EscapeState,
  outcome: EscapeOutcome,
): EscapeState {
  if (outcome.kind !== "advanced") return state;
  const action = scenario.actions.find((candidate) => candidate.id === outcome.actionId);
  if (!action) return state;

  let at = state.at;
  const things: Record<string, ThingState> = { ...state.things };
  for (const effect of action.effects) {
    if (effect.kind === "go") {
      at = effect.locationId;
      continue;
    }
    const current = things[effect.thingId];
    if (!current) continue;
    if (effect.kind === "set-state") things[effect.thingId] = { ...current, stateId: effect.stateId };
    if (effect.kind === "take") things[effect.thingId] = { ...current, carried: true, known: true, seen: true };
    if (effect.kind === "drop") things[effect.thingId] = { ...current, carried: false };
    if (effect.kind === "reveal") things[effect.thingId] = { ...current, known: true };
  }
  return { ...state, at, things: observe(scenario, at, things), log: [...state.log, action.id] };
}

function describeEffects(scenario: Scenario, effects: readonly Effect[]): OutcomeChange[] {
  return effects.map((effect) => {
    if (effect.kind === "go") {
      const location = scenario.locations.find((candidate) => candidate.id === effect.locationId);
      return { locationId: effect.locationId, summary: `Moves to ${location?.name ?? effect.locationId}.` };
    }
    const thing = scenario.things.find((candidate) => candidate.id === effect.thingId);
    const name = thing?.name ?? effect.thingId;
    if (effect.kind === "take") return { thingId: effect.thingId, summary: `Takes ${name}.` };
    if (effect.kind === "drop") return { thingId: effect.thingId, summary: `Puts down ${name}.` };
    if (effect.kind === "reveal") return { thingId: effect.thingId, summary: `Finds ${name}.` };
    const label = thing?.states.find((candidate) => candidate.id === effect.stateId)?.label ?? effect.stateId;
    return { thingId: effect.thingId, summary: `${name} is now ${label}.` };
  });
}

/** Every action the rules would let through right now, in the author's order. */
export function availableActions(
  scenario: Scenario,
  state: EscapeState,
): readonly EscapeAction[] {
  return scenario.actions.filter(
    (action) => resolveAction(scenario, state, action).kind === "advanced",
  );
}
