import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTurn, groundingWords, newState, ungroundedWord } from "../src/preferences/state";
import { CONFIG, SESSION, assertPreferenceError, turn } from "./preferenceFixtures";

const ABOUT_PETS = "a film about a family with some pets";

/** A state whose subject is "family pets", said in the viewer's own words. */
function withSubject() {
  return applyTurn(newState(SESSION), turn({ transcript: ABOUT_PETS, setSubject: "family pets" }), CONFIG);
}

describe("grounding words", () => {
  it("reads a sentence as lowercase words, dropping punctuation", () => {
    assert.deepEqual(groundingWords("A heist that goes wrong!"), ["a", "heist", "that", "goes", "wrong"]);
  });

  it("keeps the apostrophe inside a word and drops a bare one", () => {
    assert.deepEqual(groundingWords("someone who doesn't ' remember"), ["someone", "who", "doesn't", "remember"]);
  });

  it("finds no ungrounded word when every word was said, whatever the order or case", () => {
    assert.equal(ungroundedWord("Pets family", ABOUT_PETS), null);
  });

  it("names the first word the message does not carry", () => {
    assert.equal(ungroundedWord("family dogs", ABOUT_PETS), "dogs");
  });

  it("refuses a phrase that carries no words at all", () => {
    assert.equal(ungroundedWord("…", ABOUT_PETS), "…");
  });
});

describe("a turn's subject", () => {
  it("records the words the viewer used, attributed to the turn that said them", () => {
    assert.deepEqual(withSubject().subject, { phrase: "family pets", sourceTurnId: "t1" });
  });

  it("refuses the whole turn when a word of the subject was never said", () => {
    const state = newState(SESSION);
    assertPreferenceError(() => applyTurn(state, turn({ transcript: ABOUT_PETS, setSubject: "family dogs" }), CONFIG), "ungrounded_quote", "dogs");
    assert.equal(state.subject, null);
  });

  it("leaves a standing subject alone when a later turn says nothing about it", () => {
    const state = withSubject();
    const next = applyTurn(state, turn({ turnId: "t2", expectedStateVersion: 1, transcript: "under two hours" }), CONFIG);
    assert.deepEqual(next.subject, { phrase: "family pets", sourceTurnId: "t1" });
  });

  it("replaces a standing subject with a later one", () => {
    const state = withSubject();
    const next = applyTurn(
      state,
      turn({ turnId: "t2", expectedStateVersion: 1, transcript: "actually a heist that goes wrong", setSubject: "heist goes wrong" }),
      CONFIG,
    );
    assert.deepEqual(next.subject, { phrase: "heist goes wrong", sourceTurnId: "t2" });
  });

  it("withdraws the subject and leaves nothing standing", () => {
    const state = withSubject();
    const next = applyTurn(state, turn({ turnId: "t2", expectedStateVersion: 1, transcript: 'Never mind "family pets".', clearSubject: true }), CONFIG);
    assert.equal(next.subject, null);
  });

  it("refuses a turn that both states and withdraws a subject", () => {
    assertPreferenceError(
      () => applyTurn(newState(SESSION), turn({ transcript: ABOUT_PETS, setSubject: "family pets", clearSubject: true }), CONFIG),
      "subject_conflict",
    );
  });

  it("is absent from a state that never carried one", () => {
    assert.equal(newState(SESSION).subject, null);
  });
});
