import type { Critique, RankCandidate, Unavailable } from "../../src/conversation/contract.js";
import type { Interpretation } from "../../src/conversation/decision.js";
import type { CatalogueCandidate } from "../../src/catalogue/candidates.js";
import type { PreferenceState } from "../../src/preferences/schema.js";
import { interpretMessage, rankCandidates, type AssistantResult, type Ranked } from "./discover-assistant.js";
import { writeCritiques } from "./discover-critic.js";
import { withSlot, type Provider } from "./discover-http.js";

/**
 * The three model steps of Discover's funnel, each behind the same in-process concurrency cap.
 * `/api/discover/turn`, `/api/discover/rank` and `/api/discover/critique` are one step apiece for
 * a browser that holds the state between them; `/api/evaluate` runs all three in one request for
 * a harness that holds nothing. Both paths call these functions, so there is one funnel.
 */

export type Step<T> = AssistantResult<T> | Unavailable;

export type StepOptions = { now?: () => number; signal?: AbortSignal };

/** What the viewer said, as a turn the engine has already accepted against `state`. */
export function interpretStep(
  provider: Provider,
  state: PreferenceState,
  message: string,
  previousQuestion: string | null,
  { now, signal }: StepOptions = {},
): Promise<Step<Interpretation>> {
  return withSlot(() => interpretMessage(provider.complete, state, message, previousQuestion, now, signal));
}

/** The model's order over exactly these eligible candidates, with its reasons for the top picks. */
export function rankStep(
  provider: Provider,
  state: PreferenceState,
  candidates: readonly CatalogueCandidate[],
  { now, signal }: StepOptions = {},
): Promise<Step<Ranked>> {
  return withSlot(() => rankCandidates(provider.complete, state, candidates, now, signal));
}

/**
 * The critic's note on the picks. A title sent as both a pick and a withheld one would refuse
 * every critique of it, so the overlap is dropped here rather than at each caller.
 */
export function critiqueStep(
  provider: Provider,
  state: PreferenceState,
  picks: readonly RankCandidate[],
  withheld: readonly string[],
  { now, signal }: StepOptions = {},
): Promise<Step<Critique[]>> {
  const held = withheld.filter((name) => !picks.some((film) => film.title === name));
  return withSlot(() => writeCritiques(provider.complete, state, picks, held, now, signal));
}
