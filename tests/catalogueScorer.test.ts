import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toCandidates } from "../src/catalogue/candidates";
import { CATALOGUE_CONFIGURATION } from "../src/catalogue/domain";
import { REFINEMENTS, refinementTurn } from "../src/catalogue/refinements";
import { rankShortlist, scoreCandidates } from "../src/catalogue/scorer";
import { rankingSchema, type PreferenceState } from "../src/preferences/schema";
import { applyTurn, newState, rejectCandidate } from "../src/preferences/state";
import { title } from "./catalogueFixtures";

function choose(state: PreferenceState, ...ids: string[]): PreferenceState {
  return ids.reduce((current, id) => {
    const refinement = REFINEMENTS.find((candidate) => candidate.id === id);
    assert.ok(refinement, id);
    return applyTurn(current, refinementTurn(refinement, current), CATALOGUE_CONFIGURATION);
  }, state);
}

function wanting(dimensions: Record<string, { value: number; confidence: number }>): PreferenceState {
  const state = newState("scorer");
  const quote = "as stated";
  return applyTurn(
    state,
    {
      sessionId: state.sessionId,
      turnId: "t1",
      expectedStateVersion: 0,
      transcript: quote,
      dimensions: Object.fromEntries(
        Object.entries(dimensions).map(([name, stated]) => [name, { ...stated, sourceTurnId: "t1", quote, explicit: true }]),
      ),
      setConstraints: [],
      removeConstraints: [],
    },
    CATALOGUE_CONFIGURATION,
  );
}

const shortlist = toCandidates([
  title(1, { genres: ["Drama"] }),
  title(2, { genres: ["Horror"] }),
  title(3, { genres: ["Horror", "Comedy"] }),
  title(4, { genres: ["Comedy"], runtimeMinutes: 150 }),
  title(5, { genres: ["Horror"], runtimeMinutes: undefined }),
]);

describe("scoreCandidates", () => {
  it("produces a ranking the engine's schema accepts, with every utility in 0..1", () => {
    const ranking = scoreCandidates(shortlist, choose(newState("s"), "want-horror", "want-comedy"));
    assert.equal(rankingSchema.safeParse(ranking).success, true);
    for (const { utility } of ranking) assert.ok(utility >= 0 && utility <= 1);
  });

  it("ranks a title higher the more wanted genres it carries", () => {
    const ranking = scoreCandidates(shortlist, choose(newState("s"), "want-horror", "want-comedy"));
    const utility = Object.fromEntries(ranking.map(({ candidateId, utility }) => [candidateId, utility]));
    assert.ok(utility["cat:3"] > utility["cat:2"], "two wanted genres beat one");
    assert.ok(utility["cat:2"] > utility["cat:1"], "one wanted genre beats none");
    assert.ok(utility["cat:4"] > utility["cat:1"]);
  });

  it("weights each genre by the confidence it was stated with", () => {
    const state = wanting({ "genre.horror": { value: 1, confidence: 0.9 }, "genre.comedy": { value: 1, confidence: 0.3 } });
    const candidates = toCandidates([title(1, { genres: ["Comedy"] }), title(2, { genres: ["Horror"] })]);
    const [comedy, horror] = scoreCandidates(candidates, state);
    assert.ok(horror.utility > comedy.utility, "the confident preference outweighs the tentative one, despite position");
  });

  it("scores an unwanted genre below a neutral one", () => {
    const state = wanting({ "genre.horror": { value: 0, confidence: 0.9 } });
    const candidates = toCandidates([title(1, { genres: ["Horror"] }), title(2, { genres: ["Drama"] })]);
    const [horror, drama] = scoreCandidates(candidates, state);
    assert.ok(drama.utility > horror.utility);
  });

  it("with no stated genres keeps the shortlist's own order", () => {
    const ranking = scoreCandidates(shortlist, newState("s"));
    const utilities = ranking.map(({ utility }) => utility);
    assert.deepEqual([...utilities].sort((a, b) => b - a), utilities);
    assert.equal(new Set(utilities).size, utilities.length, "no ties to fall back on id order");
  });

  it("scores only eligible candidates", () => {
    const state = choose(newState("s"), "want-horror", "under-120");
    const ids = scoreCandidates(shortlist, state).map(({ candidateId }) => candidateId);
    assert.deepEqual(ids, ["cat:1", "cat:2", "cat:3"], "150 minutes and unknown runtime are both out");
  });

  it("is pure and deterministic", () => {
    const state = choose(newState("s"), "want-horror");
    const before = JSON.stringify(state);
    assert.deepEqual(scoreCandidates(shortlist, state), scoreCandidates(shortlist, state));
    assert.equal(JSON.stringify(state), before);
  });
});

describe("rankShortlist", () => {
  it("puts the accepted picks first and every other eligible title after, by utility", () => {
    const state = choose(newState("s"), "want-horror", "want-comedy");
    const { picks, ordered } = rankShortlist(shortlist, state);
    assert.deepEqual(picks.map(({ id }) => id), ["cat:3", "cat:2", "cat:4"], "equal genres tie-break on shortlist position");
    assert.deepEqual(ordered.map(({ id }) => id), ["cat:3", "cat:2", "cat:4", "cat:5", "cat:1"]);
  });

  it("never returns a rejected or constrained-out title", () => {
    const state = rejectCandidate(choose(newState("s"), "refuse-horror"), "cat:1");
    const { ordered } = rankShortlist(shortlist, state);
    assert.deepEqual(ordered.map(({ id }) => id), ["cat:4"]);
  });

  it("returns the caller's own candidate objects", () => {
    const { ordered } = rankShortlist(shortlist, newState("s"));
    for (const candidate of ordered) assert.ok(shortlist.includes(candidate));
  });
});
