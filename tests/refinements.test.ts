import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOGUE_CONFIGURATION } from "../src/catalogue/domain";
import {
  FILTER_GROUPS,
  REFINEMENTS,
  activeRefinements,
  isApplied,
  refinementTurn,
  refinementWithdrawal,
  withdrawalTurn,
  type Refinement,
} from "../src/catalogue/refinements";
import { PreferenceError } from "../src/preferences/errors";
import type { PreferenceState, TurnInput } from "../src/preferences/schema";
import { applyTurn, newState } from "../src/preferences/state";

function byId(id: string): Refinement {
  const refinement = REFINEMENTS.find((candidate) => candidate.id === id);
  assert.ok(refinement, id);
  return refinement;
}

function apply(state: PreferenceState, turn: TurnInput | null): PreferenceState {
  assert.ok(turn, "expected a turn");
  return applyTurn(state, turn, CATALOGUE_CONFIGURATION);
}

function choose(state: PreferenceState, ...ids: string[]): PreferenceState {
  return ids.reduce((current, id) => apply(current, refinementTurn(byId(id), current)), state);
}

function quotesOf(turn: TurnInput): string[] {
  return [...Object.values(turn.dimensions).map(({ quote }) => quote), ...turn.setConstraints.map(({ quote }) => quote)];
}

describe("REFINEMENTS", () => {
  it("have unique ids and cite at least one quote each", () => {
    assert.equal(new Set(REFINEMENTS.map(({ id }) => id)).size, REFINEMENTS.length);
    for (const refinement of REFINEMENTS) {
      assert.ok(quotesOf(refinementTurn(refinement, newState("s"))).length > 0, refinement.id);
    }
  });

  it("every chip's quotes are literal substrings of its own sentence", () => {
    for (const refinement of REFINEMENTS) {
      const turn = refinementTurn(refinement, newState("s"));
      assert.equal(turn.transcript, refinement.sentence);
      for (const quote of quotesOf(turn)) {
        assert.ok(turn.transcript.includes(quote), `${refinement.id}: "${quote}" is not in "${turn.transcript}"`);
      }
    }
  });

  it("every chip is accepted by the engine from a fresh session", () => {
    for (const refinement of REFINEMENTS) {
      const state = apply(newState("s"), refinementTurn(refinement, newState("s")));
      assert.equal(state.stateVersion, 1, refinement.id);
      assert.equal(isApplied(refinement, state), true, `${refinement.id} holds once chosen`);
    }
  });

  it("covers only what the catalogue supports: genres, genre refusals, runtime and era", () => {
    const groups = new Set(REFINEMENTS.map(({ group }) => group));
    assert.deepEqual([...groups].sort(), ["era", "exclude", "genre", "runtime"]);
    for (const refinement of REFINEMENTS) {
      assert.equal(/mood|tone|pace|vibe|cosy|cozy|feel-good|dark/i.test(refinement.sentence), false, refinement.id);
      const turn = refinementTurn(refinement, newState("s"));
      for (const name of Object.keys(turn.dimensions)) assert.match(name, /^genre\./);
      for (const { predicate } of turn.setConstraints) {
        if (predicate.kind === "number") assert.ok(["runtimeMinutes", "year"].includes(predicate.field));
        else assert.equal(predicate.kind, "excludeTag");
      }
    }
  });

  it("a chip with a quote outside its sentence is refused, not applied", () => {
    const broken: Refinement = {
      ...byId("want-horror"),
      dimensions: { "genre.horror": { value: 1, confidence: 0.9, quote: "terrifying" } },
    };
    assert.throws(
      () => apply(newState("s"), refinementTurn(broken, newState("s"))),
      (error: unknown) => error instanceof PreferenceError && error.code === "ungrounded_quote",
    );
  });
});

describe("refinementTurn", () => {
  it("attributes the turn to the next turn of the session, at its current version", () => {
    const state = choose(newState("s"), "want-horror");
    const turn = refinementTurn(byId("under-120"), state);
    assert.equal(turn.turnId, "turn-2");
    assert.equal(turn.expectedStateVersion, 1);
    assert.equal(turn.setConstraints[0].sourceTurnId, "turn-2");
  });

  it("wanting a refused genre lifts the refusal", () => {
    const state = choose(newState("s"), "refuse-horror", "want-horror");
    assert.equal(Object.hasOwn(state.constraints, "exclude.horror"), false);
    assert.equal(state.dimensions["genre.horror"].value, 1);
    assert.equal(isApplied(byId("refuse-horror"), state), false);
  });

  it("refusing a wanted genre replaces the want", () => {
    const state = choose(newState("s"), "want-horror", "refuse-horror");
    assert.equal(state.dimensions["genre.horror"].value, 0);
    assert.equal(isApplied(byId("want-horror"), state), false);
  });

  it("a new runtime or era limit replaces the old one", () => {
    const shorter = choose(newState("s"), "under-120", "under-90");
    assert.deepEqual(Object.keys(shorter.constraints), ["runtime.max"]);
    assert.equal(isApplied(byId("under-120"), shorter), false);

    const classic = choose(newState("s"), "nineties", "classic");
    assert.deepEqual(Object.keys(classic.constraints), ["year.max"], "the nineties' lower bound is gone");
    const recent = choose(newState("s"), "classic", "recent");
    assert.deepEqual(Object.keys(recent.constraints), ["year.min"]);
  });
});

describe("activeRefinements and withdrawal", () => {
  it("lists what is shaping the result", () => {
    const state = choose(newState("s"), "want-horror", "under-120", "refuse-romance", "nineties");
    assert.deepEqual(
      activeRefinements(state).map(({ label }) => label),
      ["Horror", "No Romance", "Under 120 min", "Up to 1999", "From 1990"],
    );
  });

  it("each item can be withdrawn with a grounded turn", () => {
    let state = choose(newState("s"), "want-horror", "under-120", "refuse-romance");
    for (const item of activeRefinements(state)) {
      const turn = withdrawalTurn(state, item);
      assert.ok(turn);
      for (const quote of quotesOf(turn)) assert.ok(turn.transcript.includes(quote));
      state = apply(state, turn);
    }
    assert.deepEqual(activeRefinements(state), []);
    assert.deepEqual(state.constraints, {});
    assert.equal(state.dimensions["genre.romance"].value, null, "a withdrawn refusal no longer counts against the genre");
  });

  it("withdrawing a chip undoes it and nothing else", () => {
    const state = choose(newState("s"), "want-horror", "under-90");
    const withdrawn = apply(state, refinementWithdrawal(byId("under-90"), state));
    assert.deepEqual(Object.keys(withdrawn.constraints), []);
    assert.equal(isApplied(byId("want-horror"), withdrawn), true);
  });

  it("withdrawing something no longer in effect is not a turn", () => {
    assert.equal(refinementWithdrawal(byId("under-90"), newState("s")), null);
  });
});

describe("the filter panel's filters", () => {
  const all = FILTER_GROUPS.flatMap(({ filters }) => filters);
  const filter = (id: string) => {
    const found = all.find((candidate) => candidate.id === id);
    assert.ok(found, id);
    return found;
  };

  it("offer every genre but TV Movie, the eras and the running times, each id once", () => {
    assert.deepEqual(FILTER_GROUPS.map(({ id }) => id), ["genre", "era", "runtime"]);
    assert.equal(FILTER_GROUPS[0].filters.length, 18);
    assert.equal(FILTER_GROUPS[0].filters.some(({ sentence }) => sentence === "TV Movie"), false);
    assert.equal(new Set(all.map(({ id }) => id)).size, all.length);
    assert.equal(new Set(all.map(({ id }) => id)).size + REFINEMENTS.length, new Set([...all, ...REFINEMENTS].map(({ id }) => id)).size, "no id is shared with a chip");
  });

  it("are grounded in their own words, so the engine accepts every one", () => {
    for (const refinement of all) {
      const turn = refinementTurn(refinement, newState("s"));
      for (const quote of quotesOf(turn)) assert.ok(turn.transcript.includes(quote), `${refinement.id}: "${quote}"`);
      const state = applyTurn(newState("s"), turn, CATALOGUE_CONFIGURATION);
      assert.equal(isApplied(refinement, state), true, refinement.id);
    }
  });

  it("hold one era and one running time at a time, and any number of genres", () => {
    const state = [filter("genre-comedy"), filter("genre-horror"), filter("era-1990s"), filter("era-since-2020"), filter("runtime-90"), filter("runtime-150")].reduce(
      (current, refinement) => apply(current, refinementTurn(refinement, current)),
      newState("s"),
    );
    assert.equal(isApplied(filter("genre-comedy"), state), true);
    assert.equal(isApplied(filter("genre-horror"), state), true);
    assert.equal(isApplied(filter("era-1990s"), state), false, "a later era replaced it");
    assert.equal(isApplied(filter("era-since-2020"), state), true);
    assert.equal(isApplied(filter("runtime-90"), state), false);
    assert.equal(isApplied(filter("runtime-150"), state), true);
    assert.deepEqual(activeRefinements(state).map(({ label }) => label), ["Comedy", "Horror", "Under 150 min", "From 2020"]);
  });

  it("withdraw what they stated when chosen again", () => {
    const comedy = filter("genre-comedy");
    const chosen = apply(newState("s"), refinementTurn(comedy, newState("s")));
    const withdrawn = apply(chosen, refinementWithdrawal(comedy, chosen));
    assert.equal(isApplied(comedy, withdrawn), false);
    assert.deepEqual(activeRefinements(withdrawn), []);
  });
});

describe("the subject in the strip", () => {
  /** A state whose subject is the viewer's own words, stated as a turn would state them. */
  function about(phrase: string, transcript: string): PreferenceState {
    return applyTurn(
      newState("strip"),
      {
        sessionId: "strip",
        turnId: "turn-1",
        expectedStateVersion: 0,
        transcript,
        dimensions: {},
        setConstraints: [],
        removeConstraints: [],
        setSubject: phrase,
      },
      CATALOGUE_CONFIGURATION,
    );
  }

  it("leads the strip, labelled with the words the viewer used", () => {
    const [first] = activeRefinements(about("family pets", "a film about a family with some pets"));
    assert.equal(first.key, "subject");
    assert.equal(first.label, "About \u201cfamily pets\u201d");
    assert.equal(first.subject, true);
  });

  it("is absent when the viewer has not said what the film is about", () => {
    assert.equal(activeRefinements(choose(newState("strip"), "want-horror")).some((item) => item.subject), false);
  });

  it("comes off on its own, leaving the other refinements in place", () => {
    const state = choose(about("family pets", "a film about a family with some pets"), "under-120");
    const [subject] = activeRefinements(state);
    const after = apply(state, withdrawalTurn(state, subject));
    assert.equal(after.subject, null);
    assert.deepEqual(
      activeRefinements(after).map(({ label }) => label),
      ["Under 120 min"],
    );
  });

  it("withdraws to nothing once it is already gone", () => {
    const state = about("family pets", "a film about a family with some pets");
    const after = apply(state, withdrawalTurn(state, activeRefinements(state)[0]));
    assert.equal(withdrawalTurn(after, { phrase: "family pets", dimensions: [], constraints: [], subject: true }), null);
  });
});
