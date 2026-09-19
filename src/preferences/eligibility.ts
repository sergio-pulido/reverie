import type { Candidate, PreferenceState, Predicate } from "./schema";

/**
 * True when the candidate has not been rejected and satisfies every constraint. Fails closed:
 * a numeric constraint on an attribute the candidate does not carry excludes it, because
 * missing data is not permission.
 */
export function isEligible(candidate: Candidate, state: PreferenceState): boolean {
  if (state.rejectedCandidateIds.includes(candidate.id)) return false;
  return Object.values(state.constraints).every(({ predicate }) => satisfies(candidate, predicate));
}

function satisfies(candidate: Candidate, predicate: Predicate): boolean {
  switch (predicate.kind) {
    case "number": {
      const value = Object.hasOwn(candidate.attributes, predicate.field) ? candidate.attributes[predicate.field] : undefined;
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      return compare(value, predicate.operator, predicate.value);
    }
    case "excludeTag":
      return !candidate.tags.includes(predicate.tag);
    case "excludeFlag":
      return !candidate.flags.includes(predicate.flag);
  }
}

function compare(actual: number, operator: "lt" | "lte" | "gt" | "gte", bound: number): boolean {
  switch (operator) {
    case "lt":
      return actual < bound;
    case "lte":
      return actual <= bound;
    case "gt":
      return actual > bound;
    case "gte":
      return actual >= bound;
  }
}
