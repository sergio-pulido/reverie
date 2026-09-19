import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GENRES, parseGenres, toGenreDimensions } from "../src/catalogue/genres";

/** Every value `catalogue_titles.genres` holds, with the slug each must map to. */
const CATALOGUE_GENRES: ReadonlyArray<[label: string, slug: string]> = [
  ["Drama", "drama"],
  ["Comedy", "comedy"],
  ["Thriller", "thriller"],
  ["Action", "action"],
  ["Romance", "romance"],
  ["Horror", "horror"],
  ["Crime", "crime"],
  ["Adventure", "adventure"],
  ["Family", "family"],
  ["Science Fiction", "science_fiction"],
  ["Fantasy", "fantasy"],
  ["Animation", "animation"],
  ["Mystery", "mystery"],
  ["History", "history"],
  ["Documentary", "documentary"],
  ["Music", "music"],
  ["TV Movie", "tv_movie"],
  ["War", "war"],
  ["Western", "western"],
];

describe("GENRES", () => {
  it("is exactly the 19 catalogue values, each with its stable slug", () => {
    assert.equal(GENRES.length, 19);
    assert.deepEqual(
      [...GENRES].map(({ label, slug }) => [label, slug]).sort(),
      [...CATALOGUE_GENRES].map(([label, slug]) => [label, slug]).sort(),
    );
  });

  it("has unique slugs", () => {
    assert.equal(new Set(GENRES.map(({ slug }) => slug)).size, GENRES.length);
  });
});

describe("parseGenres", () => {
  for (const [label, slug] of CATALOGUE_GENRES) {
    it(`maps "${label}" to ${slug}`, () => {
      assert.deepEqual(parseGenres(label), [slug]);
    });
  }

  it("reads a multi-genre row", () => {
    assert.deepEqual(parseGenres("Action, Science Fiction, TV Movie"), ["action", "science_fiction", "tv_movie"]);
  });

  it("deduplicates repeated genres", () => {
    assert.deepEqual(parseGenres("Drama, Comedy, Drama"), ["drama", "comedy"]);
  });

  it("drops unknown genres without throwing or guessing", () => {
    assert.deepEqual(parseGenres("Drama, Noir, Comedy"), ["drama", "comedy"]);
    assert.deepEqual(parseGenres("Sci-Fi"), []);
    assert.deepEqual(parseGenres("science fiction"), []);
  });

  it("gives an empty result for empty and null input", () => {
    assert.deepEqual(parseGenres(null), []);
    assert.deepEqual(parseGenres(""), []);
    assert.deepEqual(parseGenres("  "), []);
    assert.deepEqual(parseGenres(", ,"), []);
  });
});

describe("toGenreDimensions", () => {
  it("round-trips a multi-genre row into one dimension per stated genre", () => {
    assert.deepEqual(toGenreDimensions(parseGenres("Crime, Mystery, Thriller")), {
      "genre.crime": 1,
      "genre.mystery": 1,
      "genre.thriller": 1,
    });
  });

  it("emits no key for genres the row does not list", () => {
    const dimensions = toGenreDimensions(parseGenres("Western"));
    assert.deepEqual(Object.keys(dimensions), ["genre.western"]);
    assert.equal("genre.drama" in dimensions, false);
    assert.ok(Object.values(dimensions).every((value) => value === 1));
  });

  it("gives no dimensions for a row with no known genres", () => {
    assert.deepEqual(toGenreDimensions(parseGenres(null)), {});
    assert.deepEqual(toGenreDimensions(parseGenres("Noir")), {});
  });

  it("creates no dimension for an unknown genre", () => {
    const dimensions = toGenreDimensions(parseGenres("Family, Noir"));
    assert.deepEqual(dimensions, { "genre.family": 1 });
  });
});
