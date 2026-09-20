import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Critique, CritiqueResponse, TurnOk } from "../src/conversation/contract";
import { EMPTY_CONVERSATION, attachCritiques, attachResults, assistantReplied, viewerSaid, type ResultSet } from "../src/conversation/transcript";
import { acceptCritiques, critiquePicks, critiqueKey, withheldTitles } from "../src/discover/critiques";
import { newState, rejectCandidate } from "../src/preferences/state";
import { title } from "./catalogueFixtures";

const ROW = [1, 2, 3, 4, 5].map((id) => title(id, { title: `Film ${id}` }));
const PICKS = new Set(["cat:1", "cat:2", "cat:3"]);

function note(candidateId: string): Critique {
  return {
    candidateId,
    why: `Why ${candidateId}.`,
    watching: `Watching ${candidateId}.`,
    reservation: `Against ${candidateId}.`,
  };
}

function written(state: ReturnType<typeof newState>, ...critiques: Critique[]): CritiqueResponse {
  return { status: "ok", source: "nebius", model: "test", stateVersion: state.stateVersion, critiques };
}

describe("what the critic is asked about", () => {
  it("is the row's top picks, and never more than the top picks", () => {
    const picks = critiquePicks(ROW, PICKS);
    assert.deepEqual(picks.map(({ id }) => id), ["cat:1", "cat:2", "cat:3"]);
    assert.deepEqual(critiquePicks(ROW, new Set(ROW.map(({ id }) => id))).length, 3, "a row that is all picks still sends three");
  });

  it("sends every other film in the row as a name it may not use", () => {
    assert.deepEqual(withheldTitles(ROW, critiquePicks(ROW, PICKS)), ["Film 4", "Film 5"]);
  });

  it("keys one set of picks to one state, so an answer cannot cross a version", () => {
    const state = newState("keys");
    const later = rejectCandidate(state, "cat:9");
    assert.notEqual(critiqueKey(state, ROW), critiqueKey(later, ROW));
    assert.notEqual(critiqueKey(state, ROW), critiqueKey(state, ROW.slice(1)));
  });
});

describe("acceptCritiques", () => {
  const state = newState("accept");
  const picks = critiquePicks(ROW, PICKS);

  it("keeps a note for each pick it is shown", () => {
    const accepted = acceptCritiques(written(state, note("cat:1"), note("cat:2")), state, picks);
    assert.deepEqual(Object.keys(accepted), ["cat:1", "cat:2"]);
  });

  it("drops a note for a film that is not one of these picks", () => {
    const accepted = acceptCritiques(written(state, note("cat:4"), note("cat:1")), state, picks);
    assert.deepEqual(Object.keys(accepted), ["cat:1"], "a note never lands under a poster it was not written about");
  });

  it("drops the whole answer when it was written for another state version", () => {
    const later = rejectCandidate(state, "cat:9");
    assert.deepEqual(acceptCritiques(written(state, note("cat:1")), later, picks), {});
  });

  it("takes nothing from an unavailable critic, an error, or an aborted call", () => {
    assert.deepEqual(acceptCritiques({ status: "unavailable", code: "ASSISTANT_TIMEOUT", safeMessage: "…" }, state, picks), {});
    assert.deepEqual(acceptCritiques({ status: "error", code: "X", safeMessage: "…", retryable: false }, state, picks), {});
    assert.deepEqual(acceptCritiques(null, state, picks), {});
  });

  it("notes a film once, however many times it is written about", () => {
    const accepted = acceptCritiques(written(state, note("cat:1"), { ...note("cat:1"), why: "Second thoughts." }), state, picks);
    assert.equal(accepted["cat:1"].why, "Why cat:1.", "the first stands");
  });
});

const REPLY: TurnOk = {
  status: "ok",
  source: "nebius",
  model: "test",
  turn: { sessionId: "s", turnId: "turn-1", expectedStateVersion: 0, transcript: "x", dimensions: {}, setConstraints: [], removeConstraints: [] },
  acknowledgement: "Something funny, then.",
  question: null,
};

function answered(): { conversation: ReturnType<typeof assistantReplied>; lineId: number; results: ResultSet } {
  const conversation = assistantReplied(viewerSaid(EMPTY_CONVERSATION, "something funny"), REPLY, true);
  const lineId = conversation.lines.at(-1)!.id;
  const results: ResultSet = {
    titles: ROW.slice(0, 3),
    pickIds: ["cat:1"],
    reasons: { "cat:1": "The best fit here." },
    critiques: {},
    source: "assistant",
    note: null,
    total: 3,
  };
  return { conversation: attachResults(conversation, lineId, results), lineId, results };
}

describe("attachCritiques", () => {
  it("adds the notes to films already on screen, leaving the films and their order alone", () => {
    const { conversation, lineId, results } = answered();
    const after = attachCritiques(conversation, lineId, { "cat:1": note("cat:1") });
    const shown = after.lines.find(({ id }) => id === lineId)!.results!;
    assert.deepEqual(shown.titles, results.titles, "the snapshot is the snapshot");
    assert.deepEqual(shown.pickIds, results.pickIds);
    assert.deepEqual(shown.reasons, results.reasons, "the ranking's reason stays under it");
    assert.equal(shown.critiques["cat:1"].why, "Why cat:1.");
  });

  it("keeps a note only for a film in the row", () => {
    const { conversation, lineId } = answered();
    const after = attachCritiques(conversation, lineId, { "cat:1": note("cat:1"), "cat:9": note("cat:9") });
    assert.deepEqual(Object.keys(after.lines.find(({ id }) => id === lineId)!.results!.critiques), ["cat:1"]);
  });

  it("writes once: a second set of notes for the same line changes nothing", () => {
    const { conversation, lineId } = answered();
    const once = attachCritiques(conversation, lineId, { "cat:1": note("cat:1") });
    const twice = attachCritiques(once, lineId, { "cat:2": note("cat:2") });
    assert.equal(twice, once, "the same conversation, unchanged");
  });

  it("takes nothing for a line that has no films, or that is gone", () => {
    const conversation = assistantReplied(viewerSaid(EMPTY_CONVERSATION, "something funny"), REPLY, true);
    const lineId = conversation.lines.at(-1)!.id;
    assert.equal(attachCritiques(conversation, lineId, { "cat:1": note("cat:1") }), conversation);
    assert.equal(attachCritiques(conversation, 999, { "cat:1": note("cat:1") }), conversation);
  });

  it("changes nothing when there is nothing to add", () => {
    const { conversation, lineId } = answered();
    assert.equal(attachCritiques(conversation, lineId, {}), conversation);
  });
});
