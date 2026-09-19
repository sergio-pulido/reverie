import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  filmFacts,
  filmHeadline,
  formatReleaseDate,
  formatRuntime,
  formatSubtitles,
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
  const attribution = readFileSync(new URL("../src/discover/TmdbAttribution.tsx", import.meta.url), "utf8");
  assert.match(page, /\{film && <TmdbAttribution /, "whenever a film is shown");
  assert.match(attribution, /discover-attribution/);
  assert.match(page, /film-actions/, "the page has a place for actions");
});

const checkedAt = "2026-09-19T19:00:00.000Z";

test("subtitles found are a fact: a few are named, many are counted", () => {
  const many: FilmRecord = { ...bare, subtitles: { languages: ["ar", "de", "en", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt-BR", "ru", "sv", "tr"], count: 300, checkedAt } };
  assert.deepEqual(filmFacts(many), [{ label: "Subtitles", value: "14 languages" }]);
  const few: FilmRecord = { ...bare, subtitles: { languages: ["ea", "en", "fr"], count: 5, checkedAt } };
  assert.deepEqual(filmFacts(few), [{ label: "Subtitles", value: "Spanish (Latin America), English and French" }]);
  const one: FilmRecord = { ...bare, subtitles: { languages: ["en"], count: 1, checkedAt } };
  assert.deepEqual(formatSubtitles(one.subtitles), "English");
});

test("audio description shows only as a sourced yes", () => {
  const yes: FilmRecord = { ...bare, audioDescription: { available: true, source: "Audio Description Project directory (adp.acb.org)" } };
  assert.deepEqual(filmFacts(yes), [{ label: "Audio description", value: "Available" }]);
});

test("unknown and not-checked render as nothing, never as no", () => {
  const unchecked: FilmRecord = { ...bare };
  const checkedNone: FilmRecord = { ...bare, subtitles: { languages: [], count: 0, checkedAt } };
  const sourcedNo: FilmRecord = { ...bare, audioDescription: { available: false, source: "a source" } };
  for (const film of [unchecked, checkedNone, sourcedNo]) {
    assert.deepEqual(filmFacts(film), []);
  }
  for (const { value } of filmFacts({ ...full, subtitles: { languages: ["en"], count: 1, checkedAt }, audioDescription: { available: true, source: "s" } })) {
    assert.equal(PLACEHOLDERS.test(value), false, value);
    assert.equal(/^no\b|none/i.test(value), false, value);
  }
});
