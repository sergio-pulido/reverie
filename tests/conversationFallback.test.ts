import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOGUE_CONFIGURATION } from "../src/catalogue/domain";
import { REFINEMENTS, refinementTurn } from "../src/catalogue/refinements";
import { EMPTY_CONVERSATION, FALLBACK_SUFFIX, assistantReplied, viewerSaid } from "../src/conversation/transcript";
import type { TurnOk } from "../src/conversation/contract";
import { RANKED_BY, orderShortlist, rankingKey, type RankingStatus } from "../src/discover/rankedShortlist";
import { applyTurn, newState } from "../src/preferences/state";
import { title } from "./catalogueFixtures";

const OK: TurnOk = {
  status: "ok",
  source: "nebius",
  model: "test-model",
  turn: {
    sessionId: "s",
    turnId: "turn-1",
    expectedStateVersion: 0,
    transcript: "something light",
    dimensions: {},
    setConstraints: [],
    removeConstraints: [],
  },
  acknowledgement: "Something easy-going.",
  question: "A comedy, or something animated?",
};

describe("the conversation transcript", () => {
  it("shows the acknowledgement and the question, and keeps the question open for the next message", () => {
    const after = assistantReplied(viewerSaid(EMPTY_CONVERSATION, "something light"), OK, true);
    assert.deepEqual(after.lines.map(({ speaker, text, question }) => [speaker, text, question ?? false]), [
      ["viewer", "something light", false],
      ["assistant", "Something easy-going.", false],
      ["assistant", "A comedy, or something animated?", true],
    ]);
    assert.equal(after.openQuestion, "A comedy, or something animated?");
    assert.equal(after.spoken, true);
  });

  it("says plainly that the assistant is unavailable and that the filters and genre ranking carry on", () => {
    const after = assistantReplied(
      viewerSaid(EMPTY_CONVERSATION, "something light"),
      { status: "unavailable", code: "ASSISTANT_TIMEOUT", safeMessage: "The assistant did not answer in time." },
      false,
    );
    const notice = after.lines.at(-1);
    assert.equal(notice?.speaker, "system");
    assert.equal(notice?.text, `The assistant is unavailable: The assistant did not answer in time. ${FALLBACK_SUFFIX}`);
    assert.equal(after.available, false);
    assert.equal(after.spoken, false, "nothing was interpreted, so nothing claims the assistant did");
  });

  it("claims nothing when the browser's engine did not accept the turn", () => {
    const after = assistantReplied(EMPTY_CONVERSATION, OK, false);
    assert.equal(after.lines.length, 1);
    assert.equal(after.lines[0].speaker, "system");
    assert.equal(after.spoken, false);
    assert.equal(after.openQuestion, null);
  });

  it("recovers when the assistant answers again after being unavailable", () => {
    const down = assistantReplied(EMPTY_CONVERSATION, { status: "unavailable", code: "ASSISTANT_BUSY", safeMessage: "Busy." }, false);
    assert.equal(assistantReplied(down, OK, true).available, true);
  });

});

describe("which ranking a shortlist is shown in", () => {
  const scary = REFINEMENTS.find(({ id }) => id === "want-horror");
  assert.ok(scary);
  const state = applyTurn(newState("shown"), refinementTurn(scary, newState("shown")), CATALOGUE_CONFIGURATION);
  const items = [
    title(1, { genres: ["Horror"] }),
    title(2, { genres: ["Horror", "Comedy"] }),
    title(3, { genres: ["Horror"] }),
    title(4, { genres: ["Horror"] }),
  ];
  const key = rankingKey(state, items);
  const ranked: RankingStatus = {
    phase: "ranked",
    key,
    stateVersion: state.stateVersion,
    ranking: [
      { candidateId: "cat:4", utility: 0.9 },
      { candidateId: "cat:3", utility: 0.8 },
      { candidateId: "cat:1", utility: 0.4 },
    ],
    reasons: [{ candidateId: "cat:4", reason: "Tense and short." }],
  };

  it("shows the assistant's order, labelled as the assistant's, with its reasons", () => {
    const shown = orderShortlist(items, state, ranked, true);
    assert.equal(shown.source, "assistant");
    assert.deepEqual(shown.items.map(({ id }) => id), ["cat:4", "cat:3", "cat:1", "cat:2"]);
    assert.deepEqual([...shown.pickIds], ["cat:4", "cat:3", "cat:1"]);
    assert.equal(shown.reasons.get("cat:4"), "Tense and short.");
    assert.equal(RANKED_BY[shown.source], "Ranked by the assistant");
  });

  it("never shows a ranking made for another shortlist or state", () => {
    const stale = orderShortlist(items.slice(0, 3), state, ranked, true);
    assert.equal(stale.source, "pending");
    assert.equal(stale.pickIds.size, 0, "nothing is marked a pick before the assistant has picked it");
  });

  it("falls back to the scorer, labelled as genre match, when the ranking names an unknown film", () => {
    const bad: RankingStatus = { ...ranked, ranking: [{ candidateId: "cat:99", utility: 1 }] };
    const shown = orderShortlist(items, state, bad, true);
    assert.equal(shown.source, "fallback");
    assert.equal(RANKED_BY[shown.source], "Ranked by genre match");
    assert.equal(shown.reasons.size, 0);
    assert.match(shown.note ?? "", /did not match/);
  });

  it("falls back to the scorer with the reason when the assistant could not rank", () => {
    const failed: RankingStatus = { phase: "failed", key, message: "The assistant did not answer in time." };
    const shown = orderShortlist(items, state, failed, true);
    assert.equal(shown.source, "fallback");
    assert.equal(shown.note, "The assistant did not answer in time.");
    assert.equal(shown.pickIds.size, 3, "the scorer's own picks");
  });

  it("uses the scorer, labelled as such, when the viewer has only used chips", () => {
    const shown = orderShortlist(items, state, ranked, false);
    assert.equal(shown.source, "genre");
    assert.equal(shown.reasons.size, 0);
  });
});
