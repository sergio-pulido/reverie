import { isEligible } from "../preferences/eligibility";
import { acceptFullRanking, acceptRanking } from "../preferences/ranking";
import { SHORTLIST_SIZE, type PreferenceState, type RankingEntry } from "../preferences/schema";
import type { CatalogueCandidate } from "./candidates";

/**
 * How much of a title's utility comes from the viewer's genres versus its place in the
 * shortlist. The shortlist arrives ordered by genre overlap, search relevance and popularity,
 * so position is a sensible tie-breaker, but genre affinity dominates. This applies only to the
 * deterministic scorer: a model's ranking replaces it whole (see `orderByAssistant`).
 */
export const AFFINITY_WEIGHT = 0.9;
export const POSITION_WEIGHT = 1 - AFFINITY_WEIGHT;

type Weight = { dimension: string; weight: number };

/**
 * Signed weight per stated dimension: confidence times direction, where value 1 means "want",
 * 0 means "do not want" and 0.5 or null says nothing. Dimensions the viewer never mentioned
 * have no weight at all.
 */
function preferenceWeights(state: PreferenceState): Weight[] {
  return Object.entries(state.dimensions).flatMap(([dimension, evidence]) => {
    if (evidence.value === null) return [];
    const weight = evidence.confidence * (2 * evidence.value - 1);
    return weight === 0 ? [] : [{ dimension, weight }];
  });
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Deterministic utility for every eligible candidate, in 0..1. The more of the viewer's wanted
 * genres a title carries, and the fewer of the unwanted, the higher it scores, each genre
 * weighted by the confidence it was stated with. Ineligible candidates are not scored.
 */
export function scoreCandidates(candidates: readonly CatalogueCandidate[], state: PreferenceState): RankingEntry[] {
  const weights = preferenceWeights(state);
  const best = weights.reduce((sum, { weight }) => sum + Math.max(0, weight), 0);
  const worst = weights.reduce((sum, { weight }) => sum + Math.min(0, weight), 0);
  const span = best - worst;
  const eligible = candidates.filter((candidate) => isEligible(candidate, state));
  const last = Math.max(1, eligible.length - 1);

  return eligible.map((candidate, position) => {
    const raw = weights.reduce(
      (sum, { dimension, weight }) => sum + weight * clampUnit(candidate.dimensions[dimension] ?? 0),
      0,
    );
    const affinity = span === 0 ? 0 : (raw - worst) / span;
    const standing = eligible.length === 1 ? 1 : 1 - position / last;
    return { candidateId: candidate.id, utility: clampUnit(AFFINITY_WEIGHT * affinity + POSITION_WEIGHT * standing) };
  });
}

export type RankedShortlist = {
  /** The top titles, as accepted by the engine's ranking boundary. */
  picks: CatalogueCandidate[];
  /** Every eligible title: the picks first, then the rest by utility. */
  ordered: CatalogueCandidate[];
};

/**
 * Scores the shortlist and passes that ranking through `acceptRanking`, the same validation
 * boundary a model's ranking must cross, so the scorer can never place a title the state rules
 * out. The remaining eligible titles follow in utility order.
 */
export function rankShortlist(candidates: readonly CatalogueCandidate[], state: PreferenceState): RankedShortlist {
  const ranking = scoreCandidates(candidates, state);
  const picks = acceptRanking(candidates, state, state.stateVersion, ranking);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const pickIds = new Set(picks.map(({ id }) => id));
  const rest = ranking
    .map((entry, position) => ({ ...entry, position }))
    .filter(({ candidateId }) => !pickIds.has(candidateId))
    .sort((a, b) => b.utility - a.utility || a.position - b.position)
    .flatMap(({ candidateId }) => byId.get(candidateId) ?? []);
  return { picks, ordered: [...picks, ...rest] };
}

/**
 * Orders the shortlist by a model's ranking alone. The ranking is untrusted and crosses the
 * same boundary as the scorer's, so it can only reorder candidates this shortlist holds and the
 * state allows; one bad id refuses it whole. No position term is blended in: the order on screen
 * is the model's order, and eligible titles it did not rank follow, unmarked, in shortlist order.
 */
export function orderByAssistant(
  candidates: readonly CatalogueCandidate[],
  state: PreferenceState,
  stateVersion: number,
  ranking: unknown,
): RankedShortlist {
  const ranked = acceptFullRanking(candidates, state, stateVersion, ranking);
  const rankedIds = new Set(ranked.map(({ id }) => id));
  const unranked = candidates.filter((candidate) => !rankedIds.has(candidate.id) && isEligible(candidate, state));
  return { picks: ranked.slice(0, SHORTLIST_SIZE), ordered: [...ranked, ...unranked] };
}
