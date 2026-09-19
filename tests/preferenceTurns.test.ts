import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_TURNS_PER_SESSION, type PreferenceState } from "../src/preferences/schema";
import { applyTurn, newState } from "../src/preferences/state";
import {
  CONFIG,
  SESSION,
  TRANSCRIPT,
  assertPreferenceError,
  evidence,
  noHorror,
  runtimeUnder,
  turn,
} from "./preferenceFixtures";

/** A state after one accepted turn that stated an explicit comedy preference and a runtime cap. */
function afterFirstTurn(): PreferenceState {
  return applyTurn(
    newState(SESSION),
    turn({ dimensions: { "genre.comedy": evidence() }, setConstraints: [runtimeUnder(100)] }),
    CONFIG,
  );
}

describe("newState", () => {
  it("starts empty at version 0", () => {
    assert.deepEqual(newState(SESSION), {
      schemaVersion: 1,
      sessionId: SESSION,
      stateVersion: 0,
      dimensions: {},
      constraints: {},
      rejectedCandidateIds: [],
      processedTurns: {},
    });
  });
});

describe("applyTurn", () => {
  it("accepts a grounded turn, records it and increments stateVersion", () => {
    const state = newState(SESSION);
    const before = structuredClone(state);
    const next = applyTurn(
      state,
      turn({ dimensions: { "genre.comedy": evidence() }, setConstraints: [runtimeUnder(100), noHorror()] }),
      CONFIG,
    );

    assert.equal(next.stateVersion, 1);
    assert.deepEqual(next.dimensions, { "genre.comedy": evidence() });
    assert.deepEqual(Object.keys(next.constraints).sort(), ["no-horror", "short"]);
    assert.deepEqual(next.processedTurns, { t1: TRANSCRIPT });
    assert.notEqual(next, state);
    assert.deepEqual(state, before, "the input state must not be mutated");
  });

  it("rejects a turn for another session", () => {
    assertPreferenceError(() => applyTurn(newState(SESSION), turn({ sessionId: "other" }), CONFIG), "session_mismatch");
  });

  it("rejects input that does not match the turn schema", () => {
    assertPreferenceError(
      () => applyTurn(newState(SESSION), { ...turn(), expectedStateVersion: "0" }, CONFIG),
      "invalid_turn",
    );
  });

  describe("grounding", () => {
    it("rejects a dimension quote that is not in this turn's transcript", () => {
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ dimensions: { "genre.drama": evidence({ quote: "I love dramas" }) } }), CONFIG),
        "ungrounded_quote",
        "I love dramas",
      );
    });

    it("rejects a constraint quote that is not in this turn's transcript", () => {
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ setConstraints: [runtimeUnder(90, { quote: "under 90 minutes" })] }), CONFIG),
        "ungrounded_quote",
        "under 90 minutes",
      );
    });

    it("rejects a quote that differs only in case, because the match is literal", () => {
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ dimensions: { "genre.comedy": evidence({ quote: "Something Funny" }) } }), CONFIG),
        "ungrounded_quote",
      );
    });

    it("rejects dimension evidence attributed to another turn", () => {
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ dimensions: { "genre.comedy": evidence({ sourceTurnId: "t0" }) } }), CONFIG),
        "foreign_source_turn",
      );
    });

    it("rejects a constraint attributed to another turn", () => {
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ setConstraints: [noHorror({ sourceTurnId: "t0" })] }), CONFIG),
        "foreign_source_turn",
      );
    });

    it("rejects a blank quote, which would otherwise match any transcript", () => {
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ dimensions: { "genre.comedy": evidence({ quote: " " }) } }), CONFIG),
        "invalid_turn",
      );
    });
  });

  describe("explicit evidence", () => {
    it("is never replaced by inferred evidence for the same dimension", () => {
      const inferred = evidence({ sourceTurnId: "t2", quote: "maybe", explicit: false, value: 0.1 });
      assertPreferenceError(
        () =>
          applyTurn(
            afterFirstTurn(),
            turn({ turnId: "t2", expectedStateVersion: 1, transcript: "maybe", dimensions: { "genre.comedy": inferred } }),
            CONFIG,
          ),
        "explicit_overwrite",
        "genre.comedy",
      );
    });

    it("can be replaced by newer explicit evidence", () => {
      const restated = evidence({ sourceTurnId: "t2", quote: "no comedy", value: 0 });
      const next = applyTurn(
        afterFirstTurn(),
        turn({ turnId: "t2", expectedStateVersion: 1, transcript: "no comedy tonight", dimensions: { "genre.comedy": restated } }),
        CONFIG,
      );
      assert.deepEqual(next.dimensions["genre.comedy"], restated);
    });

    it("replaces inferred evidence", () => {
      const inferred = evidence({ explicit: false, quote: "something funny" });
      const state = applyTurn(newState(SESSION), turn({ dimensions: { "genre.comedy": inferred } }), CONFIG);
      const stated = evidence({ sourceTurnId: "t2", quote: "comedy" });
      const next = applyTurn(
        state,
        turn({ turnId: "t2", expectedStateVersion: 1, transcript: "yes, comedy", dimensions: { "genre.comedy": stated } }),
        CONFIG,
      );
      assert.deepEqual(next.dimensions["genre.comedy"], stated);
    });
  });

  describe("idempotence", () => {
    it("returns the state unchanged when a processed turn is replayed with the same transcript", () => {
      const state = afterFirstTurn();
      const replayed = applyTurn(
        state,
        turn({ dimensions: { "genre.comedy": evidence() }, setConstraints: [runtimeUnder(100)] }),
        CONFIG,
      );
      assert.equal(replayed, state);
      assert.equal(replayed.stateVersion, 1);
    });

    it("rejects a processed turnId replayed with a different transcript", () => {
      assertPreferenceError(
        () => applyTurn(afterFirstTurn(), turn({ transcript: "something else entirely" }), CONFIG),
        "turn_replay_conflict",
        "t1",
      );
    });
  });

  it("rejects a turn whose expectedStateVersion is not the current one", () => {
    assertPreferenceError(
      () => applyTurn(afterFirstTurn(), turn({ turnId: "t2", expectedStateVersion: 0 }), CONFIG),
      "stale_state_version",
    );
  });

  it(`accepts ${MAX_TURNS_PER_SESSION} turns per session and rejects the next`, () => {
    let state = newState(SESSION);
    for (let index = 0; index < MAX_TURNS_PER_SESSION; index += 1) {
      state = applyTurn(state, turn({ turnId: `t${index}`, expectedStateVersion: index, transcript: `turn ${index}` }), CONFIG);
    }
    assert.equal(state.stateVersion, MAX_TURNS_PER_SESSION);
    assertPreferenceError(
      () => applyTurn(state, turn({ turnId: "extra", expectedStateVersion: MAX_TURNS_PER_SESSION }), CONFIG),
      "turn_limit_reached",
    );
  });

  describe("vocabulary", () => {
    it("rejects an unknown dimension", () => {
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ dimensions: { "genre.opera": evidence() } }), CONFIG),
        "unknown_dimension",
        "genre.opera",
      );
    });

    it("rejects a numeric constraint on an unknown attribute", () => {
      const constraint = runtimeUnder(100, { predicate: { kind: "number", field: "budget", operator: "lt", value: 100 } });
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ setConstraints: [constraint] }), CONFIG),
        "unknown_attribute",
        "budget",
      );
    });

    it("rejects an unknown tag", () => {
      const constraint = noHorror({ predicate: { kind: "excludeTag", tag: "genre.opera" } });
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ setConstraints: [constraint] }), CONFIG),
        "unknown_tag",
        "genre.opera",
      );
    });

    it("rejects an unknown flag", () => {
      const constraint = noHorror({ id: "no-violence", predicate: { kind: "excludeFlag", flag: "violent" } });
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ setConstraints: [constraint] }), CONFIG),
        "unknown_flag",
        "violent",
      );
    });
  });

  describe("constraint changes", () => {
    it("rejects setting and removing the same id in one turn", () => {
      assertPreferenceError(
        () =>
          applyTurn(
            afterFirstTurn(),
            turn({
              turnId: "t2",
              expectedStateVersion: 1,
              setConstraints: [runtimeUnder(120, { sourceTurnId: "t2" })],
              removeConstraints: ["short"],
            }),
            CONFIG,
          ),
        "constraint_conflict",
        "short",
      );
    });

    it("rejects setting the same id twice in one turn", () => {
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ setConstraints: [runtimeUnder(100), runtimeUnder(90, { quote: "100" })] }), CONFIG),
        "duplicate_constraint",
        "short",
      );
    });

    it("rejects removing a constraint that does not exist", () => {
      assertPreferenceError(
        () => applyTurn(newState(SESSION), turn({ removeConstraints: ["short"] }), CONFIG),
        "unknown_constraint",
        "short",
      );
    });

    it("removes an existing constraint", () => {
      const next = applyTurn(
        afterFirstTurn(),
        turn({ turnId: "t2", expectedStateVersion: 1, transcript: "length doesn't matter", removeConstraints: ["short"] }),
        CONFIG,
      );
      assert.deepEqual(next.constraints, {});
    });
  });

  it("leaves the state untouched when a turn is rejected", () => {
    const state = afterFirstTurn();
    const before = structuredClone(state);
    // Grounded, known dimension and a valid constraint, but the turn also removes a constraint
    // that does not exist: nothing from it may land.
    assertPreferenceError(
      () =>
        applyTurn(
          state,
          turn({
            turnId: "t2",
            expectedStateVersion: 1,
            transcript: "drama please, nothing scary",
            dimensions: { "genre.drama": evidence({ sourceTurnId: "t2", quote: "drama please" }) },
            setConstraints: [noHorror({ sourceTurnId: "t2" })],
            removeConstraints: ["missing"],
          }),
          CONFIG,
        ),
      "unknown_constraint",
    );
    assert.deepEqual(state, before);
  });
});
