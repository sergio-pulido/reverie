import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import test from "node:test";
import catalogueTitle from "../api/catalogue-title";
import { catalogueTitleResponseSchema } from "../src/catalogue/contract";
import { toCatalogueTitle, TMDB_ATTRIBUTION } from "../api/_lib/supabase-catalogue";
import {
  CATALOGUE_TITLE_RPC,
  fetchCatalogueTitle,
  toCatalogueTitleDetail,
} from "../api/_lib/supabase-catalogue-title";

const environment = {
  SUPABASE_URL: "https://project.supabase.example",
  SUPABASE_ANON_KEY: "anon-key-not-a-real-credential",
} as NodeJS.ProcessEnv;
const ACCESS_TOKEN = "viewer.access.token";

const inceptionRow = {
  id: 27205,
  title: "Inception",
  original_title: "Inception",
  release_date: "2010-07-15",
  runtime: 148,
  vote_average: 8.364,
  vote_count: 34495,
  original_language: "en",
  spoken_languages: "English, French, Japanese, Swahili",
  poster_path: "/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg",
  backdrop_path: "/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg",
  overview: "Cobb, a skilled thief who commits corporate espionage by infiltrating the subconscious.",
  tagline: "Your mind is the scene of the crime.",
  genres: "Action, Science Fiction, Adventure",
  keywords: "rescue, mission, dream, heist, subconscious",
  imdb_id: "tt1375666",
};

/** A row as sparse as the dataset allows: every optional column empty or zero. */
const sparseRow = {
  id: 487004,
  title: "Quiet Room",
  original_title: "Quiet Room",
  release_date: null,
  runtime: 0,
  vote_average: 0,
  vote_count: 0,
  original_language: null,
  spoken_languages: null,
  poster_path: null,
  backdrop_path: null,
  overview: null,
  tagline: "   ",
  genres: null,
  keywords: null,
  imdb_id: null,
};

type Captured = { url: string; init: RequestInit };

function rpcFetch(body: unknown, status = 200, captured: Captured[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("a film page reads exactly one row, by id, as the viewer", async () => {
  const captured: Captured[] = [];
  const result = await fetchCatalogueTitle(27205, ACCESS_TOKEN, { environment, fetchImpl: rpcFetch(inceptionRow, 200, captured) });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, `${environment.SUPABASE_URL}/rest/v1/rpc/${CATALOGUE_TITLE_RPC}`);
  assert.deepEqual(JSON.parse(String(captured[0].init.body)), { title_id: 27205 });
  assert.equal((captured[0].init.headers as Record<string, string>).Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(result.status, "ok");
  assert.ok(catalogueTitleResponseSchema.safeParse(result).success);
});

test("the full record maps every field the row holds", async () => {
  const result = await fetchCatalogueTitle(27205, ACCESS_TOKEN, { environment, fetchImpl: rpcFetch(inceptionRow) });
  assert.ok(result.status === "ok");
  const film = result.title;
  assert.equal(film.id, "cat:27205");
  assert.equal(film.tagline, "Your mind is the scene of the crime.");
  assert.equal(film.releaseDate, "2010-07-15");
  assert.equal(film.year, 2010);
  assert.equal(film.runtimeMinutes, 148);
  assert.equal(film.voteAverage, 8.364);
  assert.equal(film.voteCount, 34495);
  assert.equal(film.originalLanguage, "en");
  assert.deepEqual(film.spokenLanguages, ["English", "French", "Japanese", "Swahili"]);
  assert.deepEqual(film.keywords, ["rescue", "mission", "dream", "heist", "subconscious"]);
  assert.deepEqual(film.genres, ["Action", "Science Fiction", "Adventure"]);
  assert.equal(film.imdbId, "tt1375666");
  assert.equal(film.posterUrl, "https://image.tmdb.org/t/p/w500/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg");
  assert.equal(film.backdropUrl, "https://image.tmdb.org/t/p/w1280/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg");
  assert.equal(film.attribution, TMDB_ATTRIBUTION);
  assert.equal(result.attribution, TMDB_ATTRIBUTION);
  assert.deepEqual(film.availability, []);
  assert.equal("originalTitle" in film, false, "an original title equal to the title is not repeated");
});

test("absent, empty or zero fields are omitted from the record, never filled", () => {
  const film = toCatalogueTitleDetail(sparseRow);
  assert.ok(film);
  for (const key of ["tagline", "releaseDate", "year", "runtimeMinutes", "voteAverage", "voteCount", "originalLanguage", "imdbId", "posterUrl", "backdropUrl", "synopsis", "originalTitle"]) {
    assert.equal(key in film, false, `${key} is absent, not defaulted`);
  }
  assert.deepEqual(film.genres, []);
  assert.deepEqual(film.keywords, []);
  assert.deepEqual(film.spokenLanguages, []);
  assert.deepEqual(film.availability, []);
});

test("a score without votes is not a score", () => {
  const film = toCatalogueTitleDetail({ ...inceptionRow, vote_count: 0 });
  assert.ok(film);
  assert.equal("voteAverage" in film, false);
  assert.equal("voteCount" in film, false);
});

test("an unusable IMDb id or image path is dropped rather than rendered", () => {
  const film = toCatalogueTitleDetail({ ...inceptionRow, imdb_id: "javascript:alert(1)", poster_path: "https://evil.example/x.jpg" });
  assert.ok(film);
  assert.equal("imdbId" in film, false);
  assert.equal("posterUrl" in film, false);
});

test("an unknown id is not found, and a malformed or mismatched row is a safe error", async () => {
  const missing = await fetchCatalogueTitle(1, ACCESS_TOKEN, { environment, fetchImpl: rpcFetch(null) });
  assert.equal(missing.status, "not_found");

  const malformed = await fetchCatalogueTitle(27205, ACCESS_TOKEN, { environment, fetchImpl: rpcFetch({ id: "x" }) });
  assert.equal(malformed.status === "error" && malformed.code, "CATALOGUE_INVALID_RESPONSE");

  const mismatched = await fetchCatalogueTitle(603, ACCESS_TOKEN, { environment, fetchImpl: rpcFetch(inceptionRow) });
  assert.equal(mismatched.status === "error" && mismatched.code, "CATALOGUE_INVALID_RESPONSE");
});

test("no request is made without configuration, without a session or for an impossible id", async () => {
  const captured: Captured[] = [];
  const fetchImpl = rpcFetch(inceptionRow, 200, captured);
  assert.equal((await fetchCatalogueTitle(27205, ACCESS_TOKEN, { environment: {} as NodeJS.ProcessEnv, fetchImpl })).status, "catalogue_not_configured");
  const anonymous = await fetchCatalogueTitle(27205, null, { environment, fetchImpl });
  assert.equal(anonymous.status === "error" && anonymous.code, "CATALOGUE_UNAUTHENTICATED");
  assert.equal((await fetchCatalogueTitle(-4, ACCESS_TOKEN, { environment, fetchImpl })).status, "not_found");
  assert.equal(captured.length, 0);
});

test("the grid's list mapping never carries the detail-only fields", () => {
  const listed = toCatalogueTitle(inceptionRow);
  assert.ok(listed);
  for (const key of ["tagline", "voteAverage", "voteCount", "keywords", "spokenLanguages", "imdbId", "originalTitle"]) {
    assert.equal(key in listed, false, key);
  }
});

async function withHandler(fetchImpl: typeof fetch, run: (baseUrl: string) => Promise<void>) {
  const server: Server = createServer((request, response) => {
    void catalogueTitle(request, response, { environment, fetchImpl });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

test("the endpoint validates the id, requires a session and answers 404 for an unknown film", async () => {
  const captured: Captured[] = [];
  await withHandler(rpcFetch(null, 200, captured), async (baseUrl) => {
    const auth = { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } };
    assert.equal((await fetch(`${baseUrl}/api/catalogue-title?id=abc`, auth)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/catalogue-title?id=0`, auth)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/catalogue-title`, auth)).status, 400);
    assert.equal(captured.length, 0);
    assert.equal((await fetch(`${baseUrl}/api/catalogue-title?id=27205`)).status, 401);
    assert.equal(captured.length, 0);
    const missing = await fetch(`${baseUrl}/api/catalogue-title?id=27205`, auth);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).status, "not_found");
    assert.equal((await fetch(`${baseUrl}/api/catalogue-title?id=27205`, { method: "POST", ...auth })).status, 405);
  });
});

test("the endpoint returns the film as the viewer", async () => {
  const captured: Captured[] = [];
  await withHandler(rpcFetch(inceptionRow, 200, captured), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/catalogue-title?id=27205`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.title.title, "Inception");
    assert.equal(body.source, "tmdb");
    assert.equal(captured.length, 1);
  });
});

test("the detail migration reads one row by key, as the caller, for signed-in viewers only", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20260919232000_catalogue_title_detail.sql", import.meta.url), "utf8");
  assert.match(sql, /create or replace function public\.get_catalogue_title\(title_id bigint\)/);
  assert.match(sql, /security invoker/);
  assert.match(sql, /set search_path = ''/);
  assert.match(sql, /where c\.id = title_id;/);
  assert.match(sql, /revoke all on function public\.get_catalogue_title\(bigint\) from public, anon;/);
  assert.match(sql, /grant execute on function public\.get_catalogue_title\(bigint\) to authenticated;/);
  assert.equal(/search_catalogue_titles/.test(sql.replace(/^--.*$/gm, "")), false, "the list query is not touched");
  assert.equal(/'(document|genre_slugs|popularity)'/.test(sql), false, "internal columns are not returned");
});
