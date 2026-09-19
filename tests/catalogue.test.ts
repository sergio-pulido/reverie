import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import test from "node:test";
import catalogue from "../api/catalogue";
import {
  catalogueOkSchema,
  catalogueQuerySchema,
  CATALOGUE_LIMITS,
  isCatalogueId,
} from "../src/catalogue/contract";
import {
  CATALOGUE_RPC,
  fetchCatalogue,
  TMDB_ATTRIBUTION,
  toCatalogueTitle,
} from "../api/_lib/supabase-catalogue";

const environment = {
  SUPABASE_URL: "https://project.supabase.example",
  SUPABASE_ANON_KEY: "anon-key-not-a-real-credential",
} as NodeJS.ProcessEnv;
const ACCESS_TOKEN = "viewer.access.token";

const defaultQuery = catalogueQuerySchema.parse({});

const inceptionRow = {
  id: 27205,
  title: "Inception",
  release_date: "2010-07-15",
  runtime: 148,
  poster_path: "/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg",
  backdrop_path: "/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg",
  overview: "Cobb, a skilled thief who commits corporate espionage by infiltrating the subconscious.",
  genres: "Action, Science Fiction, Adventure",
};

type Captured = { url: string; init: RequestInit };

function rpcFetch(body: unknown, status = 200, captured: Captured[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("query validation clamps and rejects out-of-range input", () => {
  assert.equal(catalogueQuerySchema.parse({}).pageSize, CATALOGUE_LIMITS.pageSizeDefault);
  assert.equal(catalogueQuerySchema.parse({ page: "3" }).page, 3);
  assert.equal(catalogueQuerySchema.safeParse({ pageSize: "500" }).success, false);
  assert.equal(catalogueQuerySchema.safeParse({ page: "0" }).success, false);
  assert.equal(catalogueQuerySchema.safeParse({ query: "x".repeat(121) }).success, false);
});

test("without Supabase configuration the catalogue says so and never calls out", async () => {
  const captured: Captured[] = [];
  const result = await fetchCatalogue(defaultQuery, ACCESS_TOKEN, {
    environment: {} as NodeJS.ProcessEnv,
    fetchImpl: rpcFetch({ total: 0, items: [] }, 200, captured),
  });
  assert.equal(captured.length, 0);
  assert.equal(result.status, "catalogue_not_configured");
});

test("without a viewer session the catalogue is refused before any request", async () => {
  const captured: Captured[] = [];
  const result = await fetchCatalogue(defaultQuery, null, {
    environment,
    fetchImpl: rpcFetch({ total: 0, items: [] }, 200, captured),
  });
  assert.equal(captured.length, 0);
  assert.equal(result.status === "error" && result.code, "CATALOGUE_UNAUTHENTICATED");
});

test("one bounded RPC is sent as the viewer, carrying only the query and page", async () => {
  const captured: Captured[] = [];
  const query = catalogueQuerySchema.parse({ query: "heist dream", page: "2", pageSize: "12" });
  await fetchCatalogue(query, ACCESS_TOKEN, { environment, fetchImpl: rpcFetch({ total: 0, items: [] }, 200, captured) });

  assert.equal(captured.length, 1, "exactly one round trip per page");
  assert.equal(captured[0].url, `https://project.supabase.example/rest/v1/rpc/${CATALOGUE_RPC}`);
  const headers = captured[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${ACCESS_TOKEN}`, "RLS applies as the viewer, not a privileged key");
  assert.equal(headers.apikey, environment.SUPABASE_ANON_KEY);
  assert.deepEqual(JSON.parse(String(captured[0].init.body)), { search: "heist dream", page_number: 2, page_size: 12 });
});

test("a row maps to a TMDB-attributed catalogue title with no availability", async () => {
  const result = await fetchCatalogue(defaultQuery, ACCESS_TOKEN, {
    environment,
    fetchImpl: rpcFetch({ total: 1, items: [inceptionRow] }),
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(catalogueOkSchema.safeParse(result).success, true);
  assert.equal(result.source, "tmdb");
  assert.equal(result.attribution, TMDB_ATTRIBUTION);
  assert.deepEqual(result.items[0], {
    id: "cat:27205",
    title: "Inception",
    year: 2010,
    synopsis: inceptionRow.overview,
    genres: ["Action", "Science Fiction", "Adventure"],
    runtimeMinutes: 148,
    posterUrl: "https://image.tmdb.org/t/p/w500/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg",
    backdropUrl: "https://image.tmdb.org/t/p/w780/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg",
    attribution: TMDB_ATTRIBUTION,
    availability: [],
  });
  assert.equal(isCatalogueId(result.items[0].id), true, "real films keep their own namespace");
});

test("availability stays empty even if a row were to carry provider fields", () => {
  const title = toCatalogueTitle({ ...inceptionRow, availability: [{ provider: "Example TV", kind: "stream" }] });
  assert.deepEqual(title?.availability, []);
});

test("absent or unusable fields are omitted, never faked", () => {
  const title = toCatalogueTitle({
    id: 1,
    title: "Sparse Film",
    release_date: null,
    runtime: 0,
    poster_path: "javascript:alert(1)",
    backdrop_path: null,
    overview: "x".repeat(5_000),
    genres: null,
  });
  assert.ok(title);
  assert.equal(title.year, undefined);
  assert.equal(title.runtimeMinutes, undefined, "a zero runtime is not a runtime");
  assert.equal(title.posterUrl, undefined, "an untrusted image path is dropped");
  assert.equal(title.backdropUrl, undefined);
  assert.deepEqual(title.genres, []);
  assert.equal(title.synopsis?.length, 1_200, "synopsis is truncated to the contract limit");
  assert.ok(title.synopsis?.endsWith("…"));
});

test("rows that fail validation are dropped instead of partially rendered", async () => {
  const result = await fetchCatalogue(defaultQuery, ACCESS_TOKEN, {
    environment,
    fetchImpl: rpcFetch({ total: 3, items: [inceptionRow, { id: 2 }, { id: "3", title: "String Id" }] }),
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.items.map((item) => item.id), ["cat:27205"]);
});

test("paging reports the database total and whether more pages exist", async () => {
  const query = catalogueQuerySchema.parse({ page: "2", pageSize: "1" });
  const result = await fetchCatalogue(query, ACCESS_TOKEN, {
    environment,
    fetchImpl: rpcFetch({ total: 3, items: [inceptionRow, { ...inceptionRow, id: 9 }] }),
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.items.length, 1, "never more items than the page renders");
  assert.equal(result.total, 3);
  assert.equal(result.hasMore, true);
});

test("a malformed database body becomes a safe typed error", async () => {
  const cases: [unknown, string][] = [
    ["not json", "CATALOGUE_UNAVAILABLE"],
    [{ unexpected: true }, "CATALOGUE_INVALID_RESPONSE"],
    [{ total: 1, items: Array(CATALOGUE_LIMITS.maxItemsPerResponse + 1).fill(inceptionRow) }, "CATALOGUE_INVALID_RESPONSE"],
  ];
  for (const [body, code] of cases) {
    const result = await fetchCatalogue(defaultQuery, ACCESS_TOKEN, { environment, fetchImpl: rpcFetch(body) });
    assert.equal(result.status === "error" && result.code, code);
  }
});

test("database failures map to safe codes without leaking the body or credentials", async () => {
  const cases: [number, string, boolean][] = [
    [401, "CATALOGUE_UNAUTHENTICATED", true],
    [403, "CATALOGUE_FORBIDDEN", false],
    [500, "CATALOGUE_UNAVAILABLE", true],
  ];
  for (const [status, code, retryable] of cases) {
    const result = await fetchCatalogue(defaultQuery, ACCESS_TOKEN, {
      environment,
      fetchImpl: rpcFetch({ message: "relation public.catalogue_titles", hint: ACCESS_TOKEN }, status),
    });
    assert.equal(result.status, "error");
    if (result.status !== "error") continue;
    assert.equal(result.code, code);
    assert.equal(result.retryable, retryable);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(ACCESS_TOKEN), false);
    assert.equal(serialized.includes("catalogue_titles"), false);
  }

  const unreachable = await fetchCatalogue(defaultQuery, ACCESS_TOKEN, {
    environment,
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  assert.equal(unreachable.status === "error" && unreachable.code, "CATALOGUE_UNAVAILABLE");
});

async function withHandler(fetchImpl: typeof fetch, run: (baseUrl: string) => Promise<void>) {
  const server: Server = createServer((request, response) => {
    void catalogue(request, response, { environment, fetchImpl });
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

test("the endpoint answers 401 without a bearer token and forwards the viewer's token", async () => {
  const captured: Captured[] = [];
  await withHandler(rpcFetch({ total: 1, items: [inceptionRow] }, 200, captured), async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/catalogue`);
    assert.equal(anonymous.status, 401);
    assert.equal(captured.length, 0);

    const signedIn = await fetch(`${baseUrl}/api/catalogue?query=inception`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    assert.equal(signedIn.status, 200);
    const body = await signedIn.json();
    assert.equal(body.source, "tmdb");
    assert.equal(body.items[0].title, "Inception");
    assert.equal((captured[0].init.headers as Record<string, string>).Authorization, `Bearer ${ACCESS_TOKEN}`);
  });
});

test("nothing that draws a title implies where it can be watched", () => {
  const renderers = [
    "../src/discover/DiscoverScreen.tsx",
    "../src/discover/Artwork.tsx",
    "../src/discover/FilmPage.tsx",
    "../src/home/HomeScreen.tsx",
    "../src/home/HomeHero.tsx",
    "../src/home/Shelf.tsx",
    "../src/home/JamSpotlight.tsx",
  ];
  for (const file of renderers) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(/\.availability\b/.test(source), false, `${file} never renders availability`);
    assert.equal(/where to watch/i.test(source), false, file);
  }
});
