import assert from "node:assert/strict";
import test from "node:test";
import { CATALOGUE_RPC } from "../api/_lib/supabase-catalogue";
import { NO_LANDING_FILMS } from "../src/landing/films";
import { readLandingFilms } from "../scripts/landing-films";

const environment = {
  SUPABASE_URL: "https://project.supabase.example",
  SUPABASE_ANON_KEY: "anon-key-not-a-real-credential",
} as NodeJS.ProcessEnv;
const VIEWER_TOKEN = "anonymous.viewer.token-for-the-build";

const row = (id: number, genres = "Drama") => ({
  id,
  title: `Film ${id}`,
  release_date: "2023-05-01",
  runtime: 100,
  poster_path: `/poster-${id}.jpg`,
  genres,
});

type Call = { url: string; init: RequestInit };

type Answers = { signIn?: Response; popular?: Response; gentle?: Response };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function supabaseDouble(answers: Answers, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.endsWith("/auth/v1/signup")) return answers.signIn ?? json({ access_token: VIEWER_TOKEN, token_type: "bearer" });
    const args = JSON.parse(String(init?.body ?? "{}")) as { include_genres?: string[] };
    if (args.include_genres) return answers.gentle ?? json({ total: 3, items: [row(40), row(41), row(42)] });
    return answers.popular ?? json({ total: 20, items: Array.from({ length: 16 }, (_, index) => row(index + 1)) });
  }) as typeof fetch;
}

test("without Supabase configuration the build reads nothing and says why", async () => {
  const calls: Call[] = [];
  const result = await readLandingFilms({} as NodeJS.ProcessEnv, { fetchImpl: supabaseDouble({}, calls) });
  assert.equal(result.status, "unavailable");
  assert.match(result.status === "unavailable" ? result.reason : "", /not configured/);
  assert.equal(calls.length, 0);
});

test("the build signs in anonymously, like any browser, and reads through the catalogue function as that viewer", async () => {
  const calls: Call[] = [];
  const result = await readLandingFilms(environment, { fetchImpl: supabaseDouble({}, calls) });

  const [signIn, ...reads] = calls;
  assert.equal(signIn.url, "https://project.supabase.example/auth/v1/signup");
  assert.equal(signIn.init.method, "POST");
  assert.equal(new Headers(signIn.init.headers).get("apikey"), environment.SUPABASE_ANON_KEY);
  assert.equal(new Headers(signIn.init.headers).get("authorization"), null);

  assert.equal(reads.length, 2);
  for (const read of reads) {
    assert.equal(read.url, `https://project.supabase.example/rest/v1/rpc/${CATALOGUE_RPC}`);
    assert.equal(new Headers(read.init.headers).get("authorization"), `Bearer ${VIEWER_TOKEN}`);
  }
  const args = reads.map((read) => JSON.parse(String(read.init.body)));
  const popular = args.find((arg) => !arg.include_genres);
  const gentle = args.find((arg) => arg.include_genres);
  assert.deepEqual(
    { search: popular.search, page_number: popular.page_number, exclude_genres: popular.exclude_genres },
    { search: "", page_number: 1, exclude_genres: ["horror", "thriller"] },
  );
  assert.deepEqual(gentle.include_genres, ["drama", "family"]);
  assert.ok(gentle.exclude_genres.includes("horror"));

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.films.shelf.map((film) => film.id), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  assert.deepEqual(result.films.community.map((film) => film.id), ["13", "14"]);
  assert.deepEqual(result.films.picks.map((film) => film.id), ["40", "41", "42"]);
  assert.equal(result.films.shelf[0].poster, "https://image.tmdb.org/t/p/w342/poster-1.jpg");
  assert.equal(result.films.shelf[0].meta, "2023 · Drama");
});

test("a refused anonymous sign-in makes the read unavailable, and the reason never carries a token", async () => {
  const result = await readLandingFilms(environment, {
    fetchImpl: supabaseDouble({ signIn: json({ code: 422, msg: "Anonymous sign-ins are disabled" }, 422) }),
  });
  assert.equal(result.status, "unavailable");
  assert.match(result.status === "unavailable" ? result.reason : "", /anonymous sign-in/i);
});

test("a sign-in answer without a usable token is refused rather than trusted", async () => {
  const result = await readLandingFilms(environment, { fetchImpl: supabaseDouble({ signIn: json({ user: {} }) }) });
  assert.equal(result.status, "unavailable");
});

test("an unreachable project makes the read unavailable instead of throwing", async () => {
  const result = await readLandingFilms(environment, {
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  assert.equal(result.status, "unavailable");
});

test("a failed catalogue read is reported with the adapter's safe message, not shown as an empty page", async () => {
  const result = await readLandingFilms(environment, {
    fetchImpl: supabaseDouble({ popular: json({ message: "relation does not exist" }, 500) }),
  });
  assert.equal(result.status, "unavailable");
  assert.doesNotMatch(result.status === "unavailable" ? result.reason : "", /relation/);
});

test("an empty catalogue is unavailable too: the landing has nothing real to show", async () => {
  const result = await readLandingFilms(environment, {
    fetchImpl: supabaseDouble({ popular: json({ total: 0, items: [] }), gentle: json({ total: 0, items: [] }) }),
  });
  assert.deepEqual(result, { status: "unavailable", reason: "the catalogue returned no films with posters" });
  assert.deepEqual(NO_LANDING_FILMS.shelf, []);
});
