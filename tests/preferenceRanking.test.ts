import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isEligible } from "../src/preferences/eligibility";
import { acceptRanking } from "../src/preferences/ranking";
import { MAX_RANKING_ENTRIES, type Constraint, type PreferenceState } from "../src/preferences/schema";
import { newState } from "../src/preferences/state";
import { SESSION, assertPreferenceError, candidate, noHorror, runtimeUnder } from "./preferenceFixtures";

function stateWith(constraints: Constraint[], rejectedCandidateIds: string[] = []): PreferenceState {
  return {
    ...newState(SESSION),
    stateVersion: 2,
    constraints: Object.fromEntries(constraints.map((constraint) => [constraint.id, constraint])),
    rejectedCandidateIds,
  };
}

function runtime(operator: "lt" | "lte" | "gt" | "gte", value: number): Constraint {
  return runtimeUnder(value, { predicate: { kind: "number", field: "runtime", operator, value } });
}

describe("isEligible", () => {
  it("admits any candidate when there are no constraints", () => {
    assert.equal(isEligible(candidate("a"), stateWith([])), true);
  });

  it("refuses a rejected candidate", () => {
    assert.equal(isEligible(candidate("a"), stateWith([], ["a"])), false);
  });

  it("applies each numeric operator", () => {
    const film = candidate("a", { attributes: { runtime: 100 } });
    assert.equal(isEligible(film, stateWith([runtime("lt", 100)])), false);
    assert.equal(isEligible(film, stateWith([runtime("lte", 100)])), true);
    assert.equal(isEligible(film, stateWith([runtime("gt", 100)])), false);
    assert.equal(isEligible(film, stateWith([runtime("gte", 100)])), true);
  });

  it("fails closed when a numeric constraint names an attribute the candidate does not carry", () => {
    assert.equal(isEligible(candidate("a", { attributes: { year: 2001 } }), stateWith([runtime("lt", 100)])), false);
    assert.equal(isEligible(candidate("a", { attributes: {} }), stateWith([runtime("gt", -1)])), false);
  });

  it("fails closed when the attribute is present but null", () => {
    assert.equal(isEligible(candidate("a", { attributes: { runtime: null } }), stateWith([runtime("gt", -1)])), false);
  });

  it("refuses a candidate carrying an excluded tag", () => {
    assert.equal(isEligible(candidate("a", { tags: ["genre.horror"] }), stateWith([noHorror()])), false);
    assert.equal(isEligible(candidate("a", { tags: ["genre.war"] }), stateWith([noHorror()])), true);
  });

  it("refuses a candidate carrying an excluded flag", () => {
    const noAdult = noHorror({ id: "no-adult", predicate: { kind: "excludeFlag", flag: "adult" } });
    assert.equal(isEligible(candidate("a", { flags: ["adult"] }), stateWith([noAdult])), false);
    assert.equal(isEligible(candidate("a"), stateWith([noAdult])), true);
  });

  it("requires every constraint to hold", () => {
    const state = stateWith([runtime("lt", 100), noHorror()]);
    assert.equal(isEligible(candidate("a", { attributes: { runtime: 90 }, tags: ["genre.horror"] }), state), false);
    assert.equal(isEligible(candidate("a", { attributes: { runtime: 90 } }), state), true);
  });
});

describe("acceptRanking", () => {
  const candidates = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
  const state = stateWith([]);

  it("returns the top three supplied candidates by utility, descending", () => {
    const shortlist = acceptRanking(candidates, state, 2, [
      { candidateId: "a", utility: 0.2 },
      { candidateId: "b", utility: 0.9 },
      { candidateId: "c", utility: 0.5 },
      { candidateId: "d", utility: 0.7 },
    ]);
    assert.deepEqual(
      shortlist.map(({ id }) => id),
      ["b", "d", "c"],
    );
    assert.equal(shortlist[0], candidates[1], "returns the caller's candidate objects themselves");
  });

  it("returns fewer than three when the ranking is shorter", () => {
    assert.deepEqual(
      acceptRanking(candidates, state, 2, [{ candidateId: "c", utility: 0.1 }]).map(({ id }) => id),
      ["c"],
    );
  });

  it("breaks ties by candidateId, whatever order the ranking arrives in", () => {
    const tied = [
      { candidateId: "d", utility: 0.5 },
      { candidateId: "b", utility: 0.5 },
      { candidateId: "c", utility: 0.5 },
      { candidateId: "a", utility: 0.5 },
    ];
    const expected = ["a", "b", "c"];
    assert.deepEqual(acceptRanking(candidates, state, 2, tied).map(({ id }) => id), expected);
    assert.deepEqual(acceptRanking(candidates, state, 2, [...tied].reverse()).map(({ id }) => id), expected);
  });

  it("refuses a stale ranking", () => {
    assertPreferenceError(() => acceptRanking(candidates, state, 1, []), "stale_ranking");
  });

  it("refuses input that is not a ranking", () => {
    assertPreferenceError(() => acceptRanking(candidates, state, 2, { a: 1 }), "invalid_ranking");
    assertPreferenceError(() => acceptRanking(candidates, state, 2, [{ candidateId: "a", utility: 1.5 }]), "invalid_ranking");
    assertPreferenceError(() => acceptRanking(candidates, state, 2, [{ candidateId: "a" }]), "invalid_ranking");
  });

  it(`refuses a ranking longer than ${MAX_RANKING_ENTRIES} entries`, () => {
    const oversized = Array.from({ length: MAX_RANKING_ENTRIES + 1 }, (_, index) => ({ candidateId: `x${index}`, utility: 0.5 }));
    assertPreferenceError(() => acceptRanking(candidates, state, 2, oversized), "invalid_ranking");
  });

  it("refuses a ranking naming a candidate the caller did not supply", () => {
    assertPreferenceError(
      () => acceptRanking(candidates, state, 2, [{ candidateId: "a", utility: 0.3 }, { candidateId: "zz", utility: 0.9 }]),
      "unknown_candidate",
      "zz",
    );
  });

  it("refuses a ranking naming an ineligible candidate", () => {
    const constrained = stateWith([noHorror()]);
    const supplied = [candidate("a"), candidate("h", { tags: ["genre.horror"] })];
    assertPreferenceError(
      () => acceptRanking(supplied, constrained, 2, [{ candidateId: "a", utility: 0.3 }, { candidateId: "h", utility: 0.9 }]),
      "ineligible_candidate",
      "h",
    );
  });

  it("refuses a ranking naming a rejected candidate", () => {
    assertPreferenceError(
      () => acceptRanking(candidates, stateWith([], ["b"]), 2, [{ candidateId: "b", utility: 0.9 }]),
      "ineligible_candidate",
      "b",
    );
  });

  it("refuses a ranking that names a candidate twice", () => {
    assertPreferenceError(
      () => acceptRanking(candidates, state, 2, [{ candidateId: "a", utility: 0.3 }, { candidateId: "a", utility: 0.9 }]),
      "duplicate_candidate",
      "a",
    );
  });
});
