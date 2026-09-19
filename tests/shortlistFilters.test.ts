import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fetchCatalogue, toRpcFilters } from "../api/_lib/supabase-catalogue";
import {
  catalogueQuerySchema,
  readCatalogueFilters,
  writeCatalogueFilters,
  type CatalogueFilters,
} from "../src/catalogue/contract";
import { CATALOGUE_CONFIGURATION } from "../src/catalogue/domain";
import { REFINEMENTS, refinementTurn } from "../src/catalogue/refinements";
import { isRefined, toShortlistFilters } from "../src/catalogue/shortlistFilters";
import type { Constraint, PreferenceState } from "../src/preferences/schema";
import { applyTurn, newState, rejectCandidate } from "../src/preferences/state";

function choose(state: PreferenceState, ...ids: string[]): PreferenceState {
  return ids.reduce((current, id) => {
    const refinement = REFINEMENTS.find((candidate) => candidate.id === id);
    assert.ok(refinement, id);
    return applyTurn(current, refinementTurn(refinement, current), CATALOGUE_CONFIGURATION);
  }, state);
}

function withConstraints(...constraints: Omit<Constraint, "sourceTurnId" | "quote">[]): PreferenceState {
  const state = newState("s");
  return applyTurn(
    state,
    {
      sessionId: "s",
      turnId: "t1",
      expectedStateVersion: 0,
      transcript: "limits",
      dimensions: {},
      setConstraints: constraints.map((constraint) => ({ ...constraint, sourceTurnId: "t1", quote: "limits" })),
      removeConstraints: [],
    },
    CATALOGUE_CONFIGURATION,
  );
}

describe("toShortlistFilters", () => {
  it("an untouched state is not refined and filters nothing", () => {
    assert.equal(isRefined(newState("s")), false);
    assert.deepEqual(toShortlistFilters(newState("s")), {});
  });

  it("pushes every kind of constraint the state holds", () => {
    const state = rejectCandidate(
      choose(newState("s"), "want-horror", "want-comedy", "refuse-romance", "under-120", "nineties"),
      "cat:27205",
    );
    assert.equal(isRefined(state), true);
    assert.deepEqual(toShortlistFilters(state), {
      maxRuntime: 119,
      minYear: 1990,
      maxYear: 1999,
      includeGenres: ["horror", "comedy"],
      excludeGenres: ["romance"],
      excludeIds: [27205],
    });
  });

  it("turns strict bounds on whole numbers into inclusive ones and keeps the tightest", () => {
    const state = withConstraints(
      { id: "a", predicate: { kind: "number", field: "runtimeMinutes", operator: "gt", value: 80 } },
      { id: "b", predicate: { kind: "number", field: "runtimeMinutes", operator: "gte", value: 85.5 } },
      { id: "c", predicate: { kind: "number", field: "runtimeMinutes", operator: "lte", value: 130 } },
      { id: "d", predicate: { kind: "number", field: "runtimeMinutes", operator: "lt", value: 125 } },
      { id: "e", predicate: { kind: "number", field: "year", operator: "gt", value: 1999 } },
    );
    assert.deepEqual(toShortlistFilters(state), { minRuntime: 86, maxRuntime: 124, minYear: 2000 });
  });

  it("a refused genre is never also required", () => {
    const state = choose(newState("s"), "want-horror", "want-animation", "refuse-animation");
    const filters = toShortlistFilters(state);
    assert.deepEqual(filters.includeGenres, ["horror"]);
    assert.deepEqual(filters.excludeGenres, ["animation"]);
  });

  it("a language refusal is left to the engine, which re-checks every row", () => {
    const state = withConstraints({ id: "no-fr", predicate: { kind: "excludeTag", tag: "lang.fr" } });
    assert.deepEqual(toShortlistFilters(state), {});
  });

  it("clamps bounds into what the endpoint accepts", () => {
    const state = withConstraints(
      { id: "a", predicate: { kind: "number", field: "runtimeMinutes", operator: "lt", value: 5_000 } },
      { id: "b", predicate: { kind: "number", field: "year", operator: "gte", value: 1500 } },
    );
    const filters = toShortlistFilters(state);
    assert.deepEqual(filters, { maxRuntime: 1_200, minYear: 1870 });
    assert.equal(catalogueQuerySchema.safeParse(filters).success, true);
  });
});

describe("filters over HTTP and into the database", () => {
  const filters: CatalogueFilters = {
    minRuntime: 60,
    maxRuntime: 119,
    minYear: 1990,
    maxYear: 1999,
    includeGenres: ["horror", "science_fiction"],
    excludeGenres: ["romance"],
    excludeIds: [27205, 11],
  };

  it("round-trip through URL parameters and validate", () => {
    const params = new URLSearchParams();
    writeCatalogueFilters(params, filters);
    const parsed = catalogueQuerySchema.parse(readCatalogueFilters(params));
    assert.deepEqual({ ...parsed, query: undefined, page: undefined, pageSize: undefined }, {
      ...filters,
      query: undefined,
      page: undefined,
      pageSize: undefined,
    });
  });

  it("reject values outside the vocabulary or the limits", () => {
    const cases: Record<string, unknown>[] = [
      { includeGenres: ["mood.dark"] },
      { excludeGenres: [] },
      { maxRuntime: "0" },
      { minYear: "1200" },
      { excludeIds: ["cat:1"] },
      { excludeIds: Array.from({ length: 101 }, (_, index) => index + 1) },
    ];
    for (const input of cases) assert.equal(catalogueQuerySchema.safeParse(input).success, false, JSON.stringify(input));
  });

  it("reach the search function as its named arguments, and only when set", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ total: 0, items: [] }), { status: 200 });
    }) as typeof fetch;
    const environment = { SUPABASE_URL: "https://project.supabase.example", SUPABASE_ANON_KEY: "anon" } as NodeJS.ProcessEnv;

    await fetchCatalogue(catalogueQuerySchema.parse({ query: "night", pageSize: "48", ...filters }), "token", {
      environment,
      fetchImpl,
    });
    await fetchCatalogue(catalogueQuerySchema.parse({ maxRuntime: "119" }), "token", { environment, fetchImpl });

    assert.deepEqual(bodies[0], {
      search: "night",
      page_number: 1,
      page_size: 48,
      min_runtime: 60,
      max_runtime: 119,
      min_year: 1990,
      max_year: 1999,
      include_genres: ["horror", "science_fiction"],
      exclude_genres: ["romance"],
      exclude_ids: [27205, 11],
    });
    assert.deepEqual(bodies[1], { search: "", page_number: 1, page_size: 24, max_runtime: 119 });
    assert.deepEqual(toRpcFilters({}), {});
  });
});

describe("the shortlist migration", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20260919230000_constrained_catalogue_shortlist.sql", import.meta.url),
    "utf8",
  );
  const code = sql.replace(/--.*$/gm, "");

  it("accepts every filter the adapter sends", () => {
    for (const argument of ["min_runtime", "max_runtime", "min_year", "max_year", "include_genres", "exclude_genres", "exclude_ids"]) {
      assert.match(code, new RegExp(`\\b${argument}\\b`), argument);
    }
  });

  it("applies each filter in SQL, failing closed on missing values", () => {
    assert.match(code, /c\.runtime\s*>=/);
    assert.match(code, /c\.runtime\s*<=/);
    assert.match(code, /c\.release_date\s*>=/);
    assert.match(code, /c\.release_date\s*</);
    assert.match(code, /c\.genre_slugs\s*&&\s*wanted/);
    assert.match(code, /not\s*\(\s*c\.genre_slugs\s*&&\s*refused\s*\)/);
    assert.match(code, /c\.id\s*=\s*any\s*\(\s*turned_down\s*\)/);
  });

  it("never returns more than 50 rows, never selects *, and runs as the caller", () => {
    const limit = /least\(greatest\(coalesce\(page_size, \d+\), 1\), (\d+)\)/.exec(code);
    assert.ok(limit, "the page size is clamped");
    assert.ok(Number(limit[1]) <= 50);
    assert.equal(/select\s+\*/i.test(code), false);
    assert.match(code, /security invoker/);
    assert.match(code, /'original_language'/);
    assert.equal(/grant execute[^;]*\banon\b/i.test(code), false, "anonymous callers without a session get nothing");
  });
});
