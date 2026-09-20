import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TurnOk } from "../src/conversation/contract";
import {
  EMPTY_CONVERSATION,
  MAX_TURNS,
  answerLineOf,
  assistantReplied,
  attachResults,
  lookupAnswered,
  systemSaid,
  viewerSaid,
  type Conversation,
  type ResultSet,
} from "../src/conversation/transcript";
import { title } from "./catalogueFixtures";

const REPLY: TurnOk = {
  status: "ok",
  source: "nebius",
  model: "test-model",
  turn: { sessionId: "s", turnId: "turn-1", expectedStateVersion: 0, transcript: "x", dimensions: {}, setConstraints: [], removeConstraints: [] },
  acknowledgement: "Something tense, then.",
  question: null,
};

function results(ids: number[], source: ResultSet["source"] = "assistant"): ResultSet {
  return { titles: ids.map((id) => title(id)), pickIds: ids.slice(0, 1).map((id) => `cat:${id}`), reasons: {}, critiques: {}, source, note: null, total: ids.length };
}

/** One full exchange: the viewer's message and the assistant's acknowledgement. */
function exchange(conversation: Conversation, message: string): Conversation {
  return assistantReplied(viewerSaid(conversation, message), { ...REPLY, acknowledgement: `About ${message}.` }, true);
}

describe("turns", () => {
  it("numbers each turn from the viewer's message, and files the reply under it", () => {
    const first = exchange(EMPTY_CONVERSATION, "a thriller");
    const second = exchange(first, "shorter");
    assert.equal(second.turns, 2);
    assert.deepEqual(second.lines.map(({ turn, speaker }) => [turn, speaker]), [
      [1, "viewer"],
      [1, "assistant"],
      [2, "viewer"],
      [2, "assistant"],
    ]);
    assert.equal(new Set(second.lines.map(({ id }) => id)).size, 4, "every line has its own id");
  });

  it("is bounded by turns, never by lines, and drops the oldest turn whole", () => {
    let conversation = EMPTY_CONVERSATION;
    for (let index = 0; index < MAX_TURNS + 3; index += 1) {
      conversation = exchange(conversation, `message ${index}`);
      const answer = answerLineOf(conversation, conversation.turns);
      assert.ok(answer !== null);
      conversation = attachResults(conversation, answer, results([index + 1]));
    }
    const turns = new Set(conversation.lines.map(({ turn }) => turn));
    assert.equal(turns.size, MAX_TURNS);
    assert.equal(Math.min(...turns), 4, "the three oldest turns left");
    assert.equal(conversation.lines.length, MAX_TURNS * 2, "no turn lost a line to make room");
    const kept = conversation.lines.filter(({ results }) => results);
    assert.equal(kept.length, MAX_TURNS, "every remaining turn keeps its posters");
    assert.equal(kept[0].results?.titles[0].id, "cat:4");
  });

  it("keeps a turn's question and its posters together", () => {
    const asked = assistantReplied(viewerSaid(EMPTY_CONVERSATION, "something light"), { ...REPLY, question: "Funny, or gentle?" }, true);
    assert.deepEqual(asked.lines.map(({ speaker, question }) => [speaker, question ?? false]), [
      ["viewer", false],
      ["assistant", false],
      ["assistant", true],
    ]);
    const answer = answerLineOf(asked, 1);
    assert.equal(answer, asked.lines[1].id, "films go under the acknowledgement, the turn's first answer");
  });
});

describe("result sets", () => {
  it("attaches a turn's films to its answer as a snapshot", () => {
    const answered = exchange(EMPTY_CONVERSATION, "a thriller");
    const line = answerLineOf(answered, 1)!;
    const shown = results([1, 2, 3]);
    const after = attachResults(answered, line, shown);
    assert.deepEqual(after.lines.find(({ id }) => id === line)?.results, shown);
    assert.equal(answered.lines[1].results, undefined, "the earlier conversation is not changed");
  });

  it("never replaces a snapshot, so a later state cannot rewrite what an earlier turn showed", () => {
    const answered = exchange(EMPTY_CONVERSATION, "a thriller");
    const line = answerLineOf(answered, 1)!;
    const first = attachResults(answered, line, results([1, 2, 3]));
    const again = attachResults(first, line, results([9, 8, 7]));
    assert.equal(again, first, "nothing changed");
    assert.deepEqual(again.lines[1].results?.titles.map(({ id }) => id), ["cat:1", "cat:2", "cat:3"]);
  });

  it("keeps each turn's own films when the next turn brings different ones", () => {
    let conversation = exchange(EMPTY_CONVERSATION, "a thriller");
    conversation = attachResults(conversation, answerLineOf(conversation, 1)!, results([1, 2]));
    conversation = exchange(conversation, "from the nineties");
    conversation = attachResults(conversation, answerLineOf(conversation, 2)!, results([3]));
    assert.deepEqual(
      conversation.lines.filter(({ results }) => results).map(({ turn, results }) => [turn, results!.titles.map(({ id }) => id)]),
      [
        [1, ["cat:1", "cat:2"]],
        [2, ["cat:3"]],
      ],
    );
  });

  it("gives films only to an assistant line that is still there", () => {
    const said = viewerSaid(EMPTY_CONVERSATION, "a thriller");
    assert.equal(attachResults(said, said.lines[0].id, results([1])), said, "a viewer line carries no films");
    assert.equal(attachResults(said, 999, results([1])), said, "an unknown line takes nothing");
    const stale = assistantReplied(said, REPLY, false);
    assert.equal(answerLineOf(stale, 1), null, "a turn that went stale has no answer to put films under");
  });

  it("answers a title lookup with the films found, without touching the assistant's state", () => {
    const asked = viewerSaid(EMPTY_CONVERSATION, "Inception");
    const found = lookupAnswered(asked, "Inception", results([27205], "lookup"));
    const answer = found.lines.at(-1)!;
    assert.equal(answer.speaker, "assistant");
    assert.equal(answer.turn, 1);
    assert.equal(answer.text, "Here’s what I found for “Inception”.");
    assert.equal(answer.results?.source, "lookup");
    assert.equal(found.spoken, false, "the assistant interpreted nothing");
    assert.equal(found.available, true);
    assert.equal(found.openQuestion, null);

    const asked2 = assistantReplied(viewerSaid(EMPTY_CONVERSATION, "something light"), { ...REPLY, question: "Funny, or gentle?" }, true);
    const movedOn = lookupAnswered(viewerSaid(asked2, "Inception"), "Inception", results([27205], "lookup"));
    assert.equal(movedOn.openQuestion, null, "a question the viewer moved on from is not answered by the next message");
    assert.equal(movedOn.spoken, true, "what the assistant interpreted before still stands");
  });

  it("files a notice from the screen under the current turn", () => {
    const noticed = systemSaid(viewerSaid(EMPTY_CONVERSATION, "a thriller"), "Films could not be loaded.");
    assert.deepEqual(noticed.lines.at(-1), { id: 2, turn: 1, speaker: "system", text: "Films could not be loaded." });
  });
});
