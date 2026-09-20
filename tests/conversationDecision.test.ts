import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOGUE_CONFIGURATION } from "../src/catalogue/domain";
import { REFINEMENTS, refinementTurn } from "../src/catalogue/refinements";
import { toShortlistFilters } from "../src/catalogue/shortlistFilters";
import { decisionSchema, decisionToTurn, summarizeState, type Decision } from "../src/conversation/decision";
import { PreferenceError } from "../src/preferences/errors";
import type { PreferenceState } from "../src/preferences/schema";
import { applyTurn, newState } from "../src/preferences/state";

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    dimensions: [],
    subject: null,
    setConstraints: [],
    removeConstraints: [],
    acknowledgement: "Got it.",
    question: null,
    ...overrides,
  };
}

function say(state: PreferenceState, message: string, overrides: Partial<Decision>) {
  const interpretation = decisionToTurn(decisionSchema.parse(decision(overrides)), state, message);
  return { ...interpretation, state: applyTurn(state, interpretation.turn, CATALOGUE_CONFIGURATION) };
}

function chip(state: PreferenceState, id: string): PreferenceState {
  const refinement = REFINEMENTS.find((candidate) => candidate.id === id);
  assert.ok(refinement);
  return applyTurn(state, refinementTurn(refinement, state), CATALOGUE_CONFIGURATION);
}

describe("decisionSchema", () => {
  it("accepts a complete decision", () => {
    const parsed = decisionSchema.safeParse({
      dimensions: [{ dimension: "genre.horror", value: 1, confidence: 0.9, quote: "scary", explicit: true }],
      setConstraints: [{ slot: "runtime.max", minutes: 120, quote: "under two hours" }],
      removeConstraints: ["year.min"],
      acknowledgement: "A scary film under two hours.",
      question: null,
    });
    assert.equal(parsed.success, true);
  });

  it("refuses a dimension outside the genre vocabulary", () => {
    const parsed = decisionSchema.safeParse(
      decision({ dimensions: [{ dimension: "mood.cosy" as never, value: 1, confidence: 0.9, quote: "cosy", explicit: true }] }),
    );
    assert.equal(parsed.success, false);
  });

  it("refuses a constraint slot it does not know, and a genre refusal disguised as a slot", () => {
    for (const slot of ["exclude.horror", "rating.min"]) {
      const parsed = decisionSchema.safeParse(decision({ setConstraints: [{ slot, minutes: 90, quote: "x" } as never] }));
      assert.equal(parsed.success, false, slot);
    }
  });

  it("refuses a blank quote, a repeated dimension, extra keys and a question over the length cap", () => {
    const horror = { dimension: "genre.horror", value: 1, confidence: 0.9, quote: "scary", explicit: true } as const;
    assert.equal(decisionSchema.safeParse(decision({ dimensions: [{ ...horror, quote: "  " }] })).success, false);
    assert.equal(decisionSchema.safeParse(decision({ dimensions: [horror, horror] })).success, false);
    assert.equal(decisionSchema.safeParse({ ...decision(), films: ["Alien"] }).success, false);
    assert.equal(decisionSchema.safeParse(decision({ question: "?".repeat(241) })).success, false);
  });

  it("refuses values outside 0..1 and a runtime that is not a whole number of minutes", () => {
    const dimension = { dimension: "genre.comedy", value: 1.5, confidence: 0.9, quote: "funny", explicit: true } as const;
    assert.equal(decisionSchema.safeParse(decision({ dimensions: [dimension] })).success, false);
    assert.equal(
      decisionSchema.safeParse(decision({ setConstraints: [{ slot: "runtime.max", minutes: 99.5, quote: "short" }] })).success,
      false,
    );
  });
});

describe("decisionToTurn", () => {
  it("builds a turn the engine accepts, attributed to the next turn of the session", () => {
    const state = newState("talk");
    const { turn, state: next } = say(state, "A scary film under two hours", {
      dimensions: [{ dimension: "genre.horror", value: 1, confidence: 0.9, quote: "scary", explicit: true }],
      setConstraints: [{ slot: "runtime.max", minutes: 120, quote: "under two hours" }],
    });
    assert.equal(turn.turnId, "turn-1");
    assert.equal(turn.transcript, "A scary film under two hours");
    assert.deepEqual(toShortlistFilters(next), { maxRuntime: 119, includeGenres: ["horror"] });
  });

  it("refuses the whole turn when a quote is not in the viewer's message", () => {
    const state = newState("talk");
    const { turn } = decisionToTurn(
      decision({ dimensions: [{ dimension: "genre.horror", value: 1, confidence: 0.9, quote: "terrifying", explicit: true }] }),
      state,
      "Something scary",
    );
    assert.throws(
      () => applyTurn(state, turn, CATALOGUE_CONFIGURATION),
      (error: unknown) => error instanceof PreferenceError && error.code === "ungrounded_quote",
    );
  });

  it("refuses a constraint quoted from an earlier turn rather than this message", () => {
    const earlier = say(newState("talk"), "Something light for a Friday night", {
      dimensions: [{ dimension: "genre.comedy", value: 1, confidence: 0.6, quote: "light", explicit: false }],
    }).state;
    const { turn } = decisionToTurn(
      decision({ setConstraints: [{ slot: "year.min", year: 2015, quote: "Friday night" }] }),
      earlier,
      "Only recent ones",
    );
    assert.throws(
      () => applyTurn(earlier, turn, CATALOGUE_CONFIGURATION),
      (error: unknown) => error instanceof PreferenceError && error.code === "ungrounded_quote",
    );
  });

  it("an explicit refusal also excludes the genre, as the chip does", () => {
    const scary = chip(newState("talk"), "want-horror");
    const { turn, state } = say(scary, "actually nothing scary", {
      dimensions: [{ dimension: "genre.horror", value: 0, confidence: 0.9, quote: "nothing scary", explicit: true }],
    });
    assert.deepEqual(turn.setConstraints.map(({ id }) => id), ["exclude.horror"]);
    const filters = toShortlistFilters(state);
    assert.deepEqual(filters.excludeGenres, ["horror"]);
    assert.equal(filters.includeGenres, undefined, "horror is no longer wanted");
  });

  it("an inferred avoidance changes the score but excludes nothing", () => {
    const { turn } = say(newState("talk"), "something cheerful", {
      dimensions: [{ dimension: "genre.horror", value: 0, confidence: 0.5, quote: "cheerful", explicit: false }],
    });
    assert.deepEqual(turn.setConstraints, []);
  });

  it("wanting a refused genre again lifts the refusal", () => {
    const refused = chip(newState("talk"), "refuse-horror");
    const { turn, state } = say(refused, "fine, horror is ok", {
      dimensions: [{ dimension: "genre.horror", value: 1, confidence: 0.9, quote: "horror is ok", explicit: true }],
    });
    assert.deepEqual(turn.removeConstraints, ["exclude.horror"]);
    assert.deepEqual(toShortlistFilters(state).includeGenres, ["horror"]);
  });

  it("leaves out an inference about a genre the viewer stated outright", () => {
    const refused = chip(newState("talk"), "refuse-romance");
    const { turn } = say(refused, "something light", {
      dimensions: [
        { dimension: "genre.romance", value: 1, confidence: 0.5, quote: "light", explicit: false },
        { dimension: "genre.comedy", value: 1, confidence: 0.6, quote: "light", explicit: false },
      ],
    });
    assert.deepEqual(Object.keys(turn.dimensions), ["genre.comedy"]);
  });

  it("an outright genre retires the genres guessed from a mood, so answering the question narrows", () => {
    const light = say(newState("talk"), "something light for a Friday night", {
      dimensions: [
        { dimension: "genre.comedy", value: 1, confidence: 0.6, quote: "light", explicit: false },
        { dimension: "genre.family", value: 1, confidence: 0.5, quote: "light", explicit: false },
        { dimension: "genre.romance", value: 1, confidence: 0.5, quote: "light", explicit: false },
      ],
    }).state;
    assert.deepEqual(toShortlistFilters(light).includeGenres, ["comedy", "family", "romance"]);

    const { turn, state } = say(light, "a comedy please", {
      dimensions: [{ dimension: "genre.comedy", value: 1, confidence: 0.9, quote: "a comedy", explicit: true }],
    });
    assert.deepEqual(toShortlistFilters(state).includeGenres, ["comedy"]);
    assert.equal(turn.dimensions["genre.family"].value, null);
    assert.equal(turn.dimensions["genre.family"].quote, "a comedy", "grounded in the words that replaced it");
  });

  it("an outright refusal does not retire the guesses", () => {
    const light = say(newState("talk"), "something light", {
      dimensions: [{ dimension: "genre.comedy", value: 1, confidence: 0.6, quote: "light", explicit: false }],
    }).state;
    const { state } = say(light, "nothing scary", {
      dimensions: [{ dimension: "genre.horror", value: 0, confidence: 0.9, quote: "nothing scary", explicit: true }],
    });
    assert.deepEqual(toShortlistFilters(state).includeGenres, ["comedy"]);
  });

  it("clearing a slot that is not set changes nothing, and clearing one that is removes it", () => {
    const short = chip(newState("talk"), "under-90");
    const { turn } = say(short, "length doesn't matter, and any year", {
      removeConstraints: ["runtime.max", "year.min"],
    });
    assert.deepEqual(turn.removeConstraints, ["runtime.max"]);
  });

  it("keeps the question only when the turn states nothing outright", () => {
    const vague = say(newState("talk"), "something light for a Friday night", {
      dimensions: [{ dimension: "genre.comedy", value: 1, confidence: 0.6, quote: "light", explicit: false }],
      question: "Would a comedy or something animated suit you?",
    });
    assert.equal(vague.question, "Would a comedy or something animated suit you?");

    const clear = say(newState("talk"), "A scary film under two hours", {
      dimensions: [{ dimension: "genre.horror", value: 1, confidence: 0.9, quote: "scary", explicit: true }],
      setConstraints: [{ slot: "runtime.max", minutes: 120, quote: "under two hours" }],
      question: "Do you prefer recent films?",
    });
    assert.equal(clear.question, null, "a clear request is answered, not questioned");
  });
});

describe("a decision's subject", () => {
  const PETS = "a film about a family with some pets";

  it("carries the viewer's words to the turn and records them", () => {
    const { turn, state } = say(newState("talk"), PETS, { subject: "family with some pets" });
    assert.equal(turn.setSubject, "family with some pets");
    assert.deepEqual(state.subject, { phrase: "family with some pets", sourceTurnId: "turn-1" });
  });

  it("is refused with the turn when it uses a word the viewer did not say", () => {
    const state = newState("talk");
    assert.throws(() => say(state, PETS, { subject: "family dogs" }), (error: unknown) => {
      assert.ok(error instanceof PreferenceError);
      assert.equal(error.code, "ungrounded_quote");
      return true;
    });
  });

  it("states nothing when the model omits it or leaves it blank", () => {
    assert.equal(say(newState("talk"), PETS, {}).turn.setSubject, null);
    assert.equal(say(newState("talk"), PETS, { subject: "   " }).turn.setSubject, null);
  });

  it("answers rather than questions a message that says what the film is about", () => {
    assert.equal(say(newState("talk"), PETS, { subject: "family pets", question: "Any particular genre?" }).question, null);
  });

  it("leaves a standing subject alone when a later turn is silent about it", () => {
    const first = say(newState("talk"), PETS, { subject: "family pets" }).state;
    const second = say(first, "under two hours", { setConstraints: [{ slot: "runtime.max", minutes: 120, quote: "under two hours" }] }).state;
    assert.deepEqual(second.subject, { phrase: "family pets", sourceTurnId: "turn-1" });
  });

  it("replaces a standing subject with a later one", () => {
    const first = say(newState("talk"), PETS, { subject: "family pets" }).state;
    const second = say(first, "actually a heist that goes wrong", { subject: "heist that goes wrong" }).state;
    assert.deepEqual(second.subject, { phrase: "heist that goes wrong", sourceTurnId: "turn-2" });
  });
});

describe("summarizeState", () => {
  it("describes the state without any catalogue data", () => {
    let state = chip(newState("talk"), "want-horror");
    state = chip(state, "under-120");
    const summary = summarizeState(state);
    assert.match(summary, /wants Horror \(genre\.horror, said outright, from "scary"\)/);
    assert.match(summary, /runtime\.max: Under 120 min/);
    assert.match(summary, /"Something scary"/);
    assert.match(summary, /What the film is about: not stated/);
    assert.doesNotMatch(summary, /cat:/);
  });

  it("states the subject in effect so the model does not repeat it", () => {
    const { state } = say(newState("talk"), "a heist that goes wrong", { subject: "heist that goes wrong" });
    assert.match(summarizeState(state), /What the film is about: "heist that goes wrong"/);
  });
});
