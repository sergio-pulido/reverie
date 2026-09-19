import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toCandidate, toCandidates } from "../src/catalogue/candidates";
import { CATALOGUE_CONFIGURATION, LANGUAGE_CODES } from "../src/catalogue/domain";
import { GENRES } from "../src/catalogue/genres";
import { configurationSchema } from "../src/preferences/schema";
import { title } from "./catalogueFixtures";

describe("CATALOGUE_CONFIGURATION", () => {
  it("is a valid engine configuration", () => {
    assert.equal(configurationSchema.safeParse(CATALOGUE_CONFIGURATION).success, true);
  });

  it("has exactly one genre dimension per genre and nothing else", () => {
    assert.deepEqual(
      CATALOGUE_CONFIGURATION.dimensions,
      GENRES.map(({ slug }) => `genre.${slug}`),
    );
  });

  it("offers only the two numeric attributes the catalogue carries", () => {
    assert.deepEqual(CATALOGUE_CONFIGURATION.attributes, ["runtimeMinutes", "year"]);
  });

  it("tags every genre by slug, so a genre can be refused, plus every language", () => {
    for (const { slug } of GENRES) assert.ok(CATALOGUE_CONFIGURATION.tags.includes(slug), slug);
    for (const code of LANGUAGE_CODES) assert.ok(CATALOGUE_CONFIGURATION.tags.includes(`lang.${code}`), code);
    assert.equal(CATALOGUE_CONFIGURATION.tags.length, GENRES.length + LANGUAGE_CODES.length);
    assert.equal(new Set(CATALOGUE_CONFIGURATION.tags).size, CATALOGUE_CONFIGURATION.tags.length, "no duplicate tags");
  });

  it("has no flags yet and nothing for mood, tone or pace", () => {
    assert.deepEqual(CATALOGUE_CONFIGURATION.flags, []);
    const vocabulary = [...CATALOGUE_CONFIGURATION.dimensions, ...CATALOGUE_CONFIGURATION.attributes].join(" ");
    assert.equal(/mood|tone|pace/i.test(vocabulary), false);
  });
});

describe("toCandidate", () => {
  it("maps id, label, genre dimensions, attributes and tags", () => {
    const candidate = toCandidate(
      title(27205, { title: "Inception", genres: ["Action", "Science Fiction", "Adventure"], runtimeMinutes: 148, year: 2010 }),
    );
    assert.equal(candidate.id, "cat:27205");
    assert.equal(candidate.label, "Inception");
    assert.deepEqual(candidate.dimensions, { "genre.action": 1, "genre.science_fiction": 1, "genre.adventure": 1 });
    assert.deepEqual(candidate.attributes, { runtimeMinutes: 148, year: 2010 });
    assert.deepEqual(candidate.tags, ["action", "science_fiction", "adventure", "lang.en"]);
    assert.deepEqual(candidate.flags, []);
    assert.equal(candidate.title.title, "Inception", "the original title rides along for rendering");
  });

  it("omits a missing runtime or year instead of defaulting it", () => {
    const candidate = toCandidate(title(1, { runtimeMinutes: undefined, year: undefined }));
    assert.deepEqual(candidate.attributes, {});
    assert.equal(Object.hasOwn(candidate.attributes, "runtimeMinutes"), false);
    assert.equal(Object.hasOwn(candidate.attributes, "year"), false);
  });

  it("tags no language when the title states none or an unknown one", () => {
    assert.deepEqual(toCandidate(title(1, { originalLanguage: undefined })).tags, ["drama"]);
    assert.deepEqual(toCandidate(title(2, { originalLanguage: "qq" })).tags, ["drama"]);
  });

  it("drops genres outside the vocabulary rather than guessing", () => {
    const candidate = toCandidate(title(1, { genres: ["Drama", "Arthouse"] }));
    assert.deepEqual(candidate.dimensions, { "genre.drama": 1 });
    assert.deepEqual(candidate.tags, ["drama", "lang.en"]);
  });

  it("uses only vocabulary the configuration knows", () => {
    const candidate = toCandidate(title(1, { genres: GENRES.map(({ label }) => label), originalLanguage: "ja" }));
    for (const name of Object.keys(candidate.dimensions)) assert.ok(CATALOGUE_CONFIGURATION.dimensions.includes(name));
    for (const name of Object.keys(candidate.attributes)) assert.ok(CATALOGUE_CONFIGURATION.attributes.includes(name));
    for (const tag of candidate.tags) assert.ok(CATALOGUE_CONFIGURATION.tags.includes(tag), tag);
  });

  it("keeps the first of a repeated id so the engine never sees a duplicate", () => {
    const candidates = toCandidates([title(1, { title: "First" }), title(2), title(1, { title: "Again" })]);
    assert.deepEqual(candidates.map(({ label }) => label), ["First", "Film 2"]);
  });
});
