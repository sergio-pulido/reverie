import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergePartial } from "../src/voice/partialMerge";

/** Folds a sequence of partials the way the screen receives them. */
function heard(...partials: string[]) {
  return partials.reduce(mergePartial, "");
}

describe("merging partial transcripts", () => {
  it("merges a partial that carries on from the last words, never repeating them", () => {
    assert.equal(mergePartial("I want something", "something funny"), "I want something funny");
    assert.equal(mergePartial("I want something", "want something funny"), "I want something funny");
    assert.equal(mergePartial("a film for a", "for a Friday night"), "a film for a Friday night");
  });

  it("takes a partial that restates everything heard so far", () => {
    assert.equal(mergePartial("I want something", "I want something funny"), "I want something funny");
    assert.equal(heard("A scary", "A scary film", "A scary film under two hours."), "A scary film under two hours.");
  });

  it("takes a partial that starts earlier and already holds everything shown", () => {
    assert.equal(mergePartial("something funny", "I want something funny"), "I want something funny");
  });

  it("lets a restatement revise words the service first heard differently", () => {
    assert.equal(mergePartial("I want some thing", "I want something funny"), "I want something funny");
    assert.equal(mergePartial("I want a comedy for", "I want a comedy"), "I want a comedy", "a restatement may withdraw its last word");
    assert.equal(mergePartial("Eye want a", "I want a thriller"), "I want a thriller", "even its first word");
    assert.equal(mergePartial("I want a comedy", "I mean a drama"), "I mean a drama");
  });

  it("finishes a word the last partial cut short, wherever the next one picks up", () => {
    assert.equal(mergePartial("I want something fun", "something funny"), "I want something funny");
    assert.equal(mergePartial("I want some", "something funny"), "I want something funny");
    assert.equal(mergePartial("I want some", "I want something"), "I want something");
    assert.equal(mergePartial("a", "about time"), "a about time", "a single letter is not taken for a cut word");
  });

  it("compares words without case or surrounding punctuation, and keeps the newer spelling", () => {
    assert.equal(mergePartial("I want something.", "Something funny"), "I want Something funny");
    assert.equal(mergePartial("Under two hours", "under two hours, please."), "under two hours, please.");
  });

  it("ignores a fragment of words already on screen", () => {
    assert.equal(mergePartial("I want something funny tonight", "something funny"), "I want something funny tonight");
    assert.equal(mergePartial("I want something funny", "want"), "I want something funny");
  });

  it("appends a new stretch of speech that shares nothing with what was heard", () => {
    assert.equal(mergePartial("something funny", "for tonight"), "something funny for tonight");
    assert.equal(mergePartial("I want a film", "a comedy"), "I want a film a comedy", "a single shared word that then disagrees is not an overlap");
  });

  it("never lets an empty partial wipe what was heard, and tidies spacing", () => {
    assert.equal(mergePartial("I want something", ""), "I want something");
    assert.equal(mergePartial("I want something", "   "), "I want something");
    assert.equal(mergePartial("", "  a  thriller "), "a thriller");
    assert.equal(mergePartial("", ""), "");
  });

  it("never shows a word twice in a row that was said once, however the stream is cut", () => {
    const sentence = "I want something funny for a Friday night";
    const words = sentence.split(" ");
    // Every way of cutting the sentence into two overlapping pieces merges back to the sentence.
    for (let cut = 1; cut < words.length; cut += 1) {
      for (let overlap = 0; overlap <= Math.min(2, cut); overlap += 1) {
        const first = words.slice(0, cut).join(" ");
        const second = words.slice(cut - overlap).join(" ");
        assert.equal(mergePartial(first, second), sentence, `cut at ${cut} with ${overlap} shared`);
      }
    }
    // And every growing prefix, as a service that re-sends everything would deliver it.
    assert.equal(heard(...words.map((_, index) => words.slice(0, index + 1).join(" "))), sentence);
  });
});
