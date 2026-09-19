import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  filmFacts,
  filmHeadline,
  formatReleaseDate,
  formatRuntime,
  imdbUrl,
  type FilmRecord,
} from "../src/discover/filmFacts";

const bare: FilmRecord = { id: "cat:487004", title: "Quiet Room", genres: [], availability: [] };

const full: FilmRecord = {
  id: "cat:27205",
  title: "Inception",
  originalTitle: "Origen",
  year: 2010,
  releaseDate: "2010-07-15",
  runtimeMinutes: 148,
  voteAverage: 8.364,
  voteCount: 34495,
  originalLanguage: "en",
  spokenLanguages: ["English", "French"],
  keywords: ["dream"],
  imdbId: "tt1375666",
  genres: ["Action"],
  availability: [],
};

const PLACEHOLDERS = /unknown|n\/a|^0$|^0 |—|–|not available|tbd/i;

test("a record holding nothing but its title yields no headline and no facts", () => {
  assert.deepEqual(filmHeadline(bare), []);
  assert.deepEqual(filmFacts(bare), []);
  assert.equal(imdbUrl(bare.imdbId), undefined);
});

test("zero or missing runtime, score and votes are omitted, not shown as 0", () => {
  const zeroed: FilmRecord = { ...bare, runtimeMinutes: 0, voteAverage: 0, voteCount: 0, spokenLanguages: [], releaseDate: "" };
  assert.deepEqual(filmHeadline(zeroed), []);
  assert.deepEqual(filmFacts(zeroed), []);
  const scoreWithoutVotes: FilmRecord = { ...bare, voteAverage: 7.1 };
  assert.deepEqual(filmHeadline(scoreWithoutVotes), []);
  assert.deepEqual(filmFacts(scoreWithoutVotes), []);
});

test("every fact a full record yields is a real value", () => {
  assert.deepEqual(filmHeadline(full), ["2010", "2 h 28 min", "8.4 / 10"]);
  const facts = filmFacts(full);
  assert.deepEqual(
    facts.map(({ label }) => label),
    ["Original title", "Released", "Running time", "Audience score", "Original language", "Spoken languages"],
  );
  assert.equal(facts.find(({ label }) => label === "Released")?.value, "15 July 2010");
  assert.equal(facts.find(({ label }) => label === "Audience score")?.value, "8.4 / 10 · 34,495 votes");
  assert.equal(facts.find(({ label }) => label === "Original language")?.value, "English");
  for (const { value } of facts) assert.equal(PLACEHOLDERS.test(value), false, value);
  assert.equal(imdbUrl(full.imdbId), "https://www.imdb.com/title/tt1375666/");
});

test("a partial record shows exactly the facts it has", () => {
  const partial: FilmRecord = { ...bare, runtimeMinutes: 45, originalLanguage: "fr" };
  assert.deepEqual(filmHeadline(partial), ["45 min"]);
  assert.deepEqual(filmFacts(partial), [
    { label: "Running time", value: "45 min" },
    { label: "Original language", value: "French" },
  ]);
});

test("formatters return nothing for nothing", () => {
  assert.equal(formatRuntime(undefined), undefined);
  assert.equal(formatRuntime(0), undefined);
  assert.equal(formatRuntime(120), "2 h");
  assert.equal(formatReleaseDate(undefined), undefined);
  assert.equal(formatReleaseDate("2010-13-45"), undefined);
  assert.equal(formatReleaseDate("1999-03-30"), "30 March 1999");
});

test("the film page renders facts only through these helpers and keeps the TMDB attribution", () => {
  const page = readFileSync(new URL("../src/discover/FilmPage.tsx", import.meta.url), "utf8");
  assert.equal(/\.availability\b/.test(page), false, "availability is never rendered");
  assert.equal(/where to watch/i.test(page), false);
  assert.equal(/unknown|"—"|"0"/i.test(page), false, "no placeholder text in the page");
  assert.match(page, /discover-attribution/);
  assert.match(page, /film-actions/, "the page has a place for actions");
});
