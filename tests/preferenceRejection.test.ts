import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isEligible } from "../src/preferences/eligibility";
import { PreferenceError } from "../src/preferences/errors";
import { MAX_REJECTED_CANDIDATES } from "../src/preferences/schema";
import { newState, rejectCandidate, restoreRejected } from "../src/preferences/state";
import { candidate } from "./preferenceFixtures";

function code(expected: string) {
  return (error: unknown) => error instanceof PreferenceError && error.code === expected;
}

describe("rejectCandidate", () => {
  it("makes the candidate ineligible and bumps the version", () => {
    const state = newState("s");
    const next = rejectCandidate(state, "cat:1");
    assert.deepEqual(next.rejectedCandidateIds, ["cat:1"]);
    assert.equal(next.stateVersion, 1);
    assert.equal(isEligible(candidate("cat:1"), next), false);
    assert.equal(isEligible(candidate("cat:2"), next), true);
    assert.deepEqual(state.rejectedCandidateIds, [], "the previous state is untouched");
  });

  it("rejecting twice returns the same state", () => {
    const once = rejectCandidate(newState("s"), "cat:1");
    assert.equal(rejectCandidate(once, "cat:1"), once);
  });

  it("refuses a malformed id and more than the session limit", () => {
    assert.throws(() => rejectCandidate(newState("s"), "__proto__"), code("invalid_candidates"));
    assert.throws(() => rejectCandidate(newState("s"), 7), code("invalid_candidates"));
    let state = newState("s");
    for (let index = 0; index < MAX_REJECTED_CANDIDATES; index += 1) state = rejectCandidate(state, `cat:${index}`);
    assert.throws(() => rejectCandidate(state, "cat:overflow"), code("rejection_limit_reached"));
  });
});

describe("restoreRejected", () => {
  it("makes rejected candidates eligible again", () => {
    const restored = restoreRejected(rejectCandidate(newState("s"), "cat:1"));
    assert.deepEqual(restored.rejectedCandidateIds, []);
    assert.equal(restored.stateVersion, 2);
    assert.equal(isEligible(candidate("cat:1"), restored), true);
  });

  it("is a no-op when nothing was rejected", () => {
    const state = newState("s");
    assert.equal(restoreRejected(state), state);
  });
});
