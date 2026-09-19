import assert from "node:assert/strict";
import test from "node:test";
import {
  GENTLE_FILTERS,
  LANDING_COUNTS,
  NO_LANDING_FILMS,
  SHELF_FILTERS,
  filmMeta,
  landingPoster,
  selectLandingFilms,
  toLandingFilm,
} from "../src/landing/films";
import { catalogueFiltersSchema } from "../src/catalogue/contract";
import { title } from "./catalogueFixtures";

const poster = (id: number) => `https://image.tmdb.org/t/p/w500/poster-${id}.jpg`;
const withPoster = (id: number, overrides = {}) => title(id, { posterUrl: poster(id), ...overrides });

test("a landing poster is the catalogue's TMDB poster at the landing's width", () => {
  assert.equal(
    landingPoster("https://image.tmdb.org/t/p/w500/kQs6keheMwCxJxrzV83VUwFtHkB.jpg"),
    "https://image.tmdb.org/t/p/w342/kQs6keheMwCxJxrzV83VUwFtHkB.jpg",
  );
});

test("a poster that is not a TMDB poster path is not rendered", () => {
  for (const url of [
    undefined,
    "",
    "https://example.com/t/p/w500/a.jpg",
    "http://image.tmdb.org/t/p/w500/a.jpg",
    "https://image.tmdb.org/t/p/w500/../a.jpg",
    "https://image.tmdb.org/t/p/w500/a.jpg?x=1",
    "https://image.tmdb.org/t/p/original/a.jpg",
  ]) {
    assert.equal(landingPoster(url), null, String(url));
  }
});

test("the meta line is the year and the first genre, and drops what the record does not state", () => {
  assert.equal(filmMeta(title(1, { year: 2023, genres: ["Drama", "Romance"] })), "2023 · Drama");
  assert.equal(filmMeta(title(2, { year: undefined, genres: ["Animation"] })), "Animation");
  assert.equal(filmMeta(title(3, { year: 1999, genres: [] })), "1999");
  assert.equal(filmMeta(title(4, { year: undefined, genres: [] })), "");
});

test("a landing film carries the provider id, the title, the meta line and the poster", () => {
  assert.deepEqual(toLandingFilm(withPoster(27205, { title: "Inception", year: 2010, genres: ["Action"] })), {
    id: "27205",
    title: "Inception",
    meta: "2010 · Action",
    poster: "https://image.tmdb.org/t/p/w342/poster-27205.jpg",
  });
});

test("a title without a usable poster is left out rather than shown as a blank", () => {
  assert.equal(toLandingFilm(title(5)), null);
  assert.equal(toLandingFilm(title(6, { posterUrl: "https://example.com/p.jpg" })), null);
});

test("the shelf is the most popular titles and the community pair comes after it, with no repeats", () => {
  const popular = Array.from({ length: 20 }, (_, index) => withPoster(index + 1));
  const films = selectLandingFilms(popular, []);
  assert.deepEqual(films.shelf.map((film) => film.id), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  assert.deepEqual(films.community.map((film) => film.id), ["13", "14"]);
  assert.equal(films.shelf.length, LANDING_COUNTS.shelf);
  assert.equal(films.community.length, LANDING_COUNTS.community);
});

test("the picks are the first titles of the gentle shortlist, in the order the catalogue ranked them", () => {
  const gentle = [withPoster(40), withPoster(41), title(42), withPoster(43), withPoster(44), withPoster(45)];
  assert.deepEqual(selectLandingFilms([], gentle).picks.map((film) => film.id), ["40", "41", "43", "44"]);
});

test("titles without posters are skipped, so a short read yields fewer films rather than blanks", () => {
  const films = selectLandingFilms([withPoster(1), title(2), withPoster(3)], [title(9)]);
  assert.deepEqual(films.shelf.map((film) => film.id), ["1", "3"]);
  assert.deepEqual(films.community, []);
  assert.deepEqual(films.picks, []);
});

test("a duplicate row in the catalogue read is shown once", () => {
  const films = selectLandingFilms([withPoster(1), withPoster(1), withPoster(2)], []);
  assert.deepEqual(films.shelf.map((film) => film.id), ["1", "2"]);
});

test("with nothing read there is nothing to show, and nothing is invented", () => {
  assert.deepEqual(selectLandingFilms([], []), NO_LANDING_FILMS);
  assert.deepEqual(NO_LANDING_FILMS, { shelf: [], picks: [], community: [] });
});

test("the gentle shortlist is expressed in Discover's own filter vocabulary", () => {
  assert.equal(catalogueFiltersSchema.safeParse(GENTLE_FILTERS).success, true);
  assert.deepEqual(GENTLE_FILTERS.includeGenres, ["drama", "family"]);
  for (const slug of ["horror", "thriller", "war", "action"] as const) assert.ok(GENTLE_FILTERS.excludeGenres?.includes(slug), slug);
});

test("the shelf filters only by genre, in the same vocabulary, and names no film", () => {
  assert.equal(catalogueFiltersSchema.safeParse(SHELF_FILTERS).success, true);
  assert.deepEqual(SHELF_FILTERS, { excludeGenres: ["horror", "thriller"] });
});
