import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectPreferences, previewFilters } from "../src/search/detect";
import { carriesRequest } from "../src/search/filler";
import { MAX_LOOKUP_WORDS, messageIntent } from "../src/search/intent";

describe("whether a phrase carries a request", () => {
  it("does not treat hesitation or the start of a sentence as a request", () => {
    for (const phrase of ["Um", "um, uh", "I want", "I want something", "or", "Or…", "and", "I'd like to watch", "hmm, maybe something", "show me a movie", "  ", "", "Okay so", "I'm in the mood for"]) {
      assert.equal(carriesRequest(phrase), false, JSON.stringify(phrase));
    }
  });

  it("recognises a request as soon as it says anything", () => {
    for (const phrase of ["something funny", "a thriller", "comedy", "under two hours", "90s", "something quiet for a Sunday", "I want to laugh", "nothing scary", "um, a western"]) {
      assert.equal(carriesRequest(phrase), true, phrase);
    }
  });

  it("lets any title through, even one made of short or common words", () => {
    for (const title of ["Inception", "Up", "It", "Us", "Her", "Heat", "Love Actually", "Apocalypse Now", "Get Out", "9", "Amélie", "Crouching Tiger, Hidden Dragon"]) {
      assert.equal(carriesRequest(title), true, title);
    }
  });

  it("counts a short answer only while the assistant is waiting on a question", () => {
    for (const answer of ["yes", "No.", "either", "neither", "both", "the first one", "sure"]) {
      assert.equal(carriesRequest(answer), false, `${answer} on its own`);
      assert.equal(carriesRequest(answer, { answering: true }), true, `${answer} as an answer`);
    }
    assert.equal(carriesRequest("um", { answering: true }), false, "filler is filler even as an answer");
  });

  it("reads curly and straight apostrophes alike", () => {
    assert.equal(carriesRequest("I’d like"), false);
    assert.equal(carriesRequest("I'd like"), false);
  });
});

describe("a title lookup or a conversation", () => {
  it("looks up what reads like a film's name", () => {
    for (const title of ["Inception", "The Godfather", "Spirited Away", "Up", "Us", "Despicable Me", "Love Actually", "Star Wars", "No Country for Old Men", "The Silence of the Lambs", "Tom Hanks", "inception 2010"]) {
      assert.equal(messageIntent(title), "lookup", title);
    }
  });

  it("talks about what reads like a request", () => {
    for (const request of [
      "something quiet for a Sunday",
      "I want to laugh",
      "a comedy",
      "funny",
      "90s thrillers",
      "under two hours",
      "anything like Inception?",
      "what's good tonight?",
      "films about space",
      "a film with dogs",
      "movies set in Paris",
      "nothing scary",
      "an old film",
      "show me westerns",
      "recommend me something",
    ]) {
      assert.equal(messageIntent(request), "conversation", request);
    }
  });

  it("treats a long message as a sentence, whatever its words", () => {
    const long = Array.from({ length: MAX_LOOKUP_WORDS + 1 }, (_, index) => `Word${index}`).join(" ");
    assert.equal(messageIntent(long), "conversation");
    const titleLength = Array.from({ length: MAX_LOOKUP_WORDS }, (_, index) => `Word${index}`).join(" ");
    assert.equal(messageIntent(titleLength), "lookup");
  });

  it("sends an answer to the assistant's question back to the assistant, but still looks up a title", () => {
    assert.equal(messageIntent("yes", { answering: true }), "conversation");
    assert.equal(messageIntent("the first one", { answering: true }), "conversation");
    assert.equal(messageIntent("either", { answering: true }), "conversation");
    assert.equal(messageIntent("Inception", { answering: true }), "lookup", "the viewer may name a film instead of answering");
  });
});

describe("preferences heard while the viewer speaks", () => {
  const labels = (text: string) => detectPreferences(text).map(({ label }) => label);

  it("hears genres in everyday words, in the order they were said", () => {
    assert.deepEqual(labels("something funny and a bit scary"), ["Comedy", "Horror"]);
    assert.deepEqual(labels("a sci-fi thriller"), ["Science Fiction", "Thriller"]);
    assert.deepEqual(labels("an animated film for the kids"), ["Animation", "Family"]);
    assert.deepEqual(labels("a rom-com"), ["Comedy", "Romance"]);
  });

  it("hears a refusal in the words just before a genre", () => {
    assert.deepEqual(labels("nothing scary"), ["No Horror"]);
    assert.deepEqual(labels("I don’t want anything scary"), ["No Horror"]);
    assert.deepEqual(labels("a comedy, no romance"), ["Comedy", "No Romance"]);
    const refusal = detectPreferences("no horror").at(0);
    assert.ok(refusal?.kind === "genre" && refusal.refused && refusal.genre === "horror");
  });

  it("lets the last thing said about a genre win", () => {
    assert.deepEqual(labels("scary, actually no, nothing scary"), ["No Horror"]);
  });

  it("hears a running-time limit in minutes or hours, in words or digits", () => {
    assert.deepEqual(labels("under two hours"), ["Under 120 min"]);
    assert.deepEqual(labels("less than 90 minutes"), ["Under 90 min"]);
    assert.deepEqual(labels("under an hour and a half"), ["Under 90 min"]);
    assert.deepEqual(labels("no more than 2 hours please"), ["Under 120 min"]);
    assert.deepEqual(labels("something short"), ["Under 90 min"]);
    assert.deepEqual(labels("under 1.5 hours"), ["Under 90 min"]);
  });

  it("hears an era by decade, or as recent or classic", () => {
    assert.deepEqual(labels("from the nineties"), ["1990s"]);
    assert.deepEqual(labels("an 80s action film"), ["Action", "1980s"]);
    assert.deepEqual(labels("something from the 2010s"), ["2010s"]);
    assert.deepEqual(labels("a recent thriller"), ["Thriller", "From 2015"]);
    assert.deepEqual(labels("an old movie"), ["Before 1980"]);
  });

  it("hears nothing in filler, in a bare title, or in words that only look like a genre", () => {
    for (const text of ["um", "I want", "Inception", "Star Wars", "No Country for Old Men", "Love Actually", "", "constructor", "the prototype of toString"]) {
      assert.deepEqual(labels(text), [], text);
    }
  });
});

describe("filters for a preview", () => {
  const heard = (text: string) => detectPreferences(text);

  it("is nothing when nothing was heard", () => {
    assert.equal(previewFilters({ includeGenres: ["drama"] }, []), null);
  });

  it("adds a heard genre to those already wanted, and keeps what else is narrowing", () => {
    assert.deepEqual(previewFilters({ includeGenres: ["drama"], excludeIds: [7] }, heard("a thriller")), { includeGenres: ["drama", "thriller"], excludeIds: [7] });
    assert.deepEqual(previewFilters(null, heard("something funny")), { includeGenres: ["comedy"] });
  });

  it("turns a heard refusal into an exclusion, lifting it from the wanted genres", () => {
    assert.deepEqual(previewFilters({ includeGenres: ["horror", "comedy"] }, heard("nothing scary")), { includeGenres: ["comedy"], excludeGenres: ["horror"] });
    assert.deepEqual(previewFilters({ excludeGenres: ["horror"] }, heard("a horror film")), { includeGenres: ["horror"] }, "wanting it again lifts the refusal");
  });

  it("replaces the running time and the era in effect, as the engine would", () => {
    assert.deepEqual(previewFilters({ maxRuntime: 89, minYear: 1990, maxYear: 1999 }, heard("under two hours from the 2010s")), { maxRuntime: 119, minYear: 2010, maxYear: 2019 });
    assert.deepEqual(previewFilters({ minYear: 1990, maxYear: 1999 }, heard("a classic")), { maxYear: 1979 }, "before 1980 has no lower bound");
    assert.deepEqual(previewFilters({ maxRuntime: 89, minYear: 1990 }, heard("a comedy")), { maxRuntime: 89, minYear: 1990, includeGenres: ["comedy"] });
  });
});
