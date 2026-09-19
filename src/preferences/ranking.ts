import { isEligible } from "./eligibility.js";
import { PreferenceError, parseOrThrow } from "./errors.js";
import { SHORTLIST_SIZE, rankingSchema, type Candidate, type PreferenceState } from "./schema.js";

/**
 * The validation boundary for a proposed ranking, not a sort. `input` is untrusted: every id it
 * names must be one of `candidates` and eligible under `state`, so a ranking can never put a
 * candidate on screen that the caller did not supply. Returns up to SHORTLIST_SIZE of the
 * caller's own candidate objects, by utility descending with ties broken by id.
 */
export function acceptRanking<C extends Candidate>(
  candidates: readonly C[],
  state: PreferenceState,
  stateVersion: number,
  input: unknown,
): C[] {
  return acceptFullRanking(candidates, state, stateVersion, input).slice(0, SHORTLIST_SIZE);
}

/**
 * The same boundary as `acceptRanking`, returning every candidate the ranking names in its
 * order rather than only the shortlist. Candidates it does not name are not returned.
 */
export function acceptFullRanking<C extends Candidate>(
  candidates: readonly C[],
  state: PreferenceState,
  stateVersion: number,
  input: unknown,
): C[] {
  if (stateVersion !== state.stateVersion) {
    throw new PreferenceError(
      "stale_ranking",
      `The ranking was made against state version ${stateVersion}, but it is ${state.stateVersion}.`,
    );
  }
  const ranking = parseOrThrow(rankingSchema, input, "invalid_ranking", "ranking");
  const supplied = indexById(candidates);

  const seen = new Set<string>();
  const ranked = ranking.map(({ candidateId, utility }) => {
    if (seen.has(candidateId)) throw new PreferenceError("duplicate_candidate", `The ranking names ${candidateId} twice.`);
    seen.add(candidateId);
    const candidate = supplied.get(candidateId);
    if (candidate === undefined) throw new PreferenceError("unknown_candidate", `The ranking names ${candidateId}, which was not supplied.`);
    if (!isEligible(candidate, state)) throw new PreferenceError("ineligible_candidate", `The ranking names ${candidateId}, which is not eligible.`);
    return { candidate, utility };
  });

  return ranked
    .sort((a, b) => b.utility - a.utility || compareIds(a.candidate.id, b.candidate.id))
    .map(({ candidate }) => candidate);
}

function indexById<C extends Candidate>(candidates: readonly C[]): ReadonlyMap<string, C> {
  const byId = new Map<string, C>();
  for (const candidate of candidates) {
    if (byId.has(candidate.id)) throw new PreferenceError("invalid_candidates", `Candidate ${candidate.id} was supplied twice.`);
    byId.set(candidate.id, candidate);
  }
  return byId;
}

// Code-unit order rather than locale order, so the result never depends on the runtime's locale.
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
