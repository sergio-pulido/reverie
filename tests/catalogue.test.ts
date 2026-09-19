import assert from "node:assert/strict";
import test from "node:test";
import { catalogueQuerySchema, CATALOGUE_LIMITS } from "../src/catalogue/contract";
import { fetchCatalogue, readTitanConfig, type FetchLike } from "../api/_lib/titan-catalogue";

const configuredEnvironment = {
  TITAN_CATALOGUE_URL: "https://catalogue.example.com/v1/titles",
  TITAN_API_KEY: "test-key-not-a-real-credential",
} as NodeJS.ProcessEnv;

const defaultQuery = catalogueQuerySchema.parse({});

function jsonFetch(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): FetchLike {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...init.headers },
    });
}

test("query validation clamps and rejects out-of-range input", () => {
  assert.equal(catalogueQuerySchema.parse({}).pageSize, CATALOGUE_LIMITS.pageSizeDefault);
  assert.equal(catalogueQuerySchema.parse({ page: "3" }).page, 3);
  assert.equal(catalogueQuerySchema.safeParse({ pageSize: "500" }).success, false);
  assert.equal(catalogueQuerySchema.safeParse({ page: "0" }).success, false);
  assert.equal(catalogueQuerySchema.safeParse({ query: "x".repeat(121) }).success, false);
});

test("config reports every missing variable and rejects a non-https endpoint", () => {
  assert.deepEqual(readTitanConfig({} as NodeJS.ProcessEnv), {
    configured: false,
    missing: ["TITAN_CATALOGUE_URL", "TITAN_API_KEY"],
  });
  const insecure = readTitanConfig({ ...configuredEnvironment, TITAN_CATALOGUE_URL: "http://catalogue.example.com" });
  assert.deepEqual(insecure, { configured: false, missing: ["TITAN_CATALOGUE_URL"] });
});

test("an unconfigured catalogue returns the explicit state and never calls out", async () => {
  let called = false;
  const result = await fetchCatalogue(defaultQuery, {
    environment: {} as NodeJS.ProcessEnv,
    fetchImplementation: (async () => {
      called = true;
      return new Response("{}");
    }) as FetchLike,
  });
  assert.equal(called, false);
  assert.equal(result.status, "catalogue_not_configured");
  assert.equal(result.status === "catalogue_not_configured" && result.code, "CATALOGUE_NOT_CONFIGURED");
});

test("a valid upstream response is namespaced, bounded and passed through", async () => {
  let requestedUrl = "";
  let sentAuthorization = "";
  const result = await fetchCatalogue(catalogueQuerySchema.parse({ query: "space", page: "2", pageSize: "2" }), {
    environment: configuredEnvironment,
    fetchImplementation: (async (input, init) => {
      requestedUrl = input;
      sentAuthorization = String((init.headers as Record<string, string>).Authorization);
      return new Response(
        JSON.stringify({
          total: 9,
          items: [
            { id: "abc", title: "A Real Title", year: 1999, posterUrl: "https://cdn.example.com/a.jpg", genres: ["Drama"], availability: [{ provider: "Example TV", kind: "stream", url: "https://example.com/watch" }] },
            { id: 42, title: "Another Real Title" },
            { id: "third", title: "Beyond The Page Size" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as FetchLike,
  });

  assert.equal(requestedUrl, "https://catalogue.example.com/v1/titles?query=space&page=2&pageSize=2");
  assert.equal(sentAuthorization, "Bearer test-key-not-a-real-credential");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.items.length, 2, "page size bounds the returned records");
  assert.deepEqual(result.items.map((item) => item.id), ["cat:abc", "cat:42"]);
  assert.equal(result.total, 9);
  assert.equal(result.hasMore, true);
});

test("records that fail validation are dropped instead of partially rendered", async () => {
  const result = await fetchCatalogue(defaultQuery, {
    environment: configuredEnvironment,
    fetchImplementation: jsonFetch({
      items: [
        { id: "ok", title: "Kept Title", posterUrl: "https://cdn.example.com/ok.jpg" },
        { id: "no-title" },
        { id: "bad-poster", title: "Dropped Poster", posterUrl: "javascript:alert(1)" },
      ],
    }),
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.items.map((item) => item.id), ["cat:ok", "cat:bad-poster"]);
  assert.equal(result.items[1].posterUrl, undefined, "a non-https poster is dropped, the record is not faked");
});

test("a malformed upstream body becomes a safe typed error", async () => {
  for (const body of ["not json", JSON.stringify({ unexpected: true })]) {
    const result = await fetchCatalogue(defaultQuery, {
      environment: configuredEnvironment,
      fetchImplementation: jsonFetch(body),
    });
    assert.equal(result.status, "error");
    assert.equal(result.status === "error" && result.code, "CATALOGUE_INVALID_RESPONSE");
  }
});

test("upstream failures map to safe codes without leaking the body or credential", async () => {
  const cases: [number, string, boolean][] = [
    [401, "CATALOGUE_UNAUTHORIZED", false],
    [429, "CATALOGUE_RATE_LIMITED", true],
    [503, "CATALOGUE_UPSTREAM_ERROR", true],
    [404, "CATALOGUE_REQUEST_REJECTED", false],
  ];
  for (const [status, code, retryable] of cases) {
    const result = await fetchCatalogue(defaultQuery, {
      environment: configuredEnvironment,
      fetchImplementation: jsonFetch({ secret: "test-key-not-a-real-credential", detail: "upstream stack" }, { status }),
    });
    assert.equal(result.status, "error");
    if (result.status !== "error") continue;
    assert.equal(result.code, code);
    assert.equal(result.retryable, retryable);
    assert.equal(JSON.stringify(result).includes("test-key-not-a-real-credential"), false);
    assert.equal(JSON.stringify(result).includes("upstream stack"), false);
  }
});

test("an oversized upstream response is refused", async () => {
  const result = await fetchCatalogue(defaultQuery, {
    environment: configuredEnvironment,
    fetchImplementation: jsonFetch({ items: [] }, {
      headers: { "content-length": String(CATALOGUE_LIMITS.maxUpstreamBytes + 1) },
    }),
  });
  assert.equal(result.status, "error");
  assert.equal(result.status === "error" && result.code, "CATALOGUE_RESPONSE_TOO_LARGE");
});

test("a timeout and an unreachable endpoint are distinguished and retryable", async () => {
  const timedOut = await fetchCatalogue(defaultQuery, {
    environment: configuredEnvironment,
    fetchImplementation: (async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    }) as FetchLike,
  });
  assert.equal(timedOut.status === "error" && timedOut.code, "CATALOGUE_TIMEOUT");
  assert.equal(timedOut.status === "error" && timedOut.retryable, true);

  const unreachable = await fetchCatalogue(defaultQuery, {
    environment: configuredEnvironment,
    fetchImplementation: (async () => {
      throw new TypeError("fetch failed");
    }) as FetchLike,
  });
  assert.equal(unreachable.status === "error" && unreachable.code, "CATALOGUE_UNREACHABLE");
});
