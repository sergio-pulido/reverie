import type { Scenario } from "./scenario";
import { isPresent, type EscapeState } from "./state";

/**
 * Turning a participant's own words into one of the scenario's actions.
 *
 * This is deliberately a matcher and not a model. Whether "jam the crank with
 * the file" is the action that frees the shutter is a question about this
 * world, and the whole design puts questions about this world in code that is
 * deterministic, offline and testable. A model that guessed here could make
 * the room incoherent one turn and unreproducible the next.
 *
 * The cost is stated plainly: a phrasing nobody anticipated does not match,
 * and the room is told so rather than being given something it did not ask
 * for. Aliases in the scenario are how an author widens that.
 */

export type EscapeIntent =
  | { kind: "action"; actionId: string }
  /** Named something real, addressed from somewhere it cannot be reached. */
  | { kind: "unaddressable"; thingId: string }
  /** Nothing in this world answers to those words. */
  | { kind: "unreadable" };

/** Lowercased words, punctuation dropped. Matching is whole-word only. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** How many tokens of `alias` matched contiguously in `tokens`, or 0. */
export function aliasMatch(tokens: readonly string[], alias: string): number {
  const wanted = tokenize(alias);
  if (wanted.length === 0 || wanted.length > tokens.length) return 0;
  for (let start = 0; start + wanted.length <= tokens.length; start += 1) {
    let all = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (tokens[start + offset] !== wanted[offset]) {
        all = false;
        break;
      }
    }
    if (all) return wanted.length;
  }
  return 0;
}

function bestAlias(tokens: readonly string[], aliases: readonly string[]): number {
  let best = 0;
  for (const alias of aliases) best = Math.max(best, aliasMatch(tokens, alias));
  return best;
}

/**
 * Reads one proposal against the scenario as it stands.
 *
 * A thing the room has not yet seen is not matchable at all, so a lucky guess
 * at its name cannot confirm that it is in the building. Once seen, naming it
 * from another room answers `unaddressable` — which is a true thing to say,
 * and different from "those words mean nothing here".
 */
export function interpret(
  scenario: Scenario,
  state: EscapeState,
  text: string,
): EscapeIntent {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { kind: "unreadable" };
  const thingById = new Map(scenario.things.map((thing) => [thing.id, thing]));

  let chosen: { actionId: string; score: number } | null = null;
  let elsewhere: { thingId: string; score: number } | null = null;

  for (const action of scenario.actions) {
    const verb = bestAlias(tokens, action.verbs);
    if (verb === 0) continue;
    const target = thingById.get(action.targetId);
    const seen = state.things[action.targetId]?.seen ?? false;
    if (!target || !seen) continue;
    const named = bestAlias(tokens, [target.name, ...target.aliases]);
    if (named === 0) continue;

    if (!isPresent(scenario, state, action.targetId)) {
      const score = verb + named;
      // Ties break on the thing's declared order, which is the author's.
      if (!elsewhere || score > elsewhere.score) {
        elsewhere = { thingId: action.targetId, score };
      }
      continue;
    }

    const instrument = action.instrumentId ? thingById.get(action.instrumentId) : undefined;
    const withIt = instrument
      ? bestAlias(tokens, [instrument.name, ...instrument.aliases])
      : 0;
    const score = verb * 2 + named * 2 + withIt;
    // A strict improvement wins; an equal score keeps the earlier action, so
    // the scenario's own order is the tie-break and the result is stable.
    if (!chosen || score > chosen.score) chosen = { actionId: action.id, score };
  }

  if (chosen) return { kind: "action", actionId: chosen.actionId };
  if (elsewhere) return { kind: "unaddressable", thingId: elsewhere.thingId };
  return { kind: "unreadable" };
}
