import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CatalogueTitle } from "../src/catalogue/contract";
import { catalogueUrl, type CatalogueRequest, type CatalogueState } from "../src/discover/catalogueClient";
import { createShelfSource, shelfRequest } from "../src/home/catalogueShelves";
import { createShelfLoader, type ShelfResult, type ShelfState } from "../src/home/shelfLoader";
import { EAGER_SHELVES, SHELF_PAGE_SIZE, SHELVES } from "../src/home/shelves";

const title = (id: number): CatalogueTitle => ({ id: `cat:${id}`, title: `Film ${id}`, genres: [], availability: [] });
const READY: ShelfResult = { phase: "ready", items: [title(1)] };

/** A loader whose reads resolve only when the test says so. */
function manualLoad() {
  const calls: number[] = [];
  const waiting = new Map<number, (result: ShelfResult) => void>();
  return {
    calls,
    load: (index: number) => {
      calls.push(index);
      return new Promise<ShelfResult>((resolve) => waiting.set(index, resolve));
    },
    resolve(index: number, result: ShelfResult) {
      waiting.get(index)?.(result);
      waiting.delete(index);
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the home's shelves", () => {
  it("are genres and eras, each read as page 1 of a small page with no search text", () => {
    assert.ok(SHELVES.length > EAGER_SHELVES, "some shelves wait to be approached");
    assert.ok(SHELF_PAGE_SIZE <= 12, "a shelf asks for a small page");
    for (const shelf of SHELVES) {
      const request = shelfRequest(shelf);
      assert.equal(request.query, "");
      assert.equal(request.page, 1);
      assert.equal(request.pageSize, SHELF_PAGE_SIZE);
      if (shelf.kind === "genre") assert.deepEqual(request.filters, { includeGenres: [shelf.genre] });
      else assert.deepEqual(request.filters, { minYear: shelf.fromYear, maxYear: shelf.toYear });
    }
  });

  it("put their size and filters on the wire, and nothing else", () => {
    const genre = catalogueUrl(shelfRequest(SHELVES.find(({ kind }) => kind === "genre")!), "http://localhost");
    assert.equal(genre.pathname, "/api/catalogue");
    assert.equal(genre.searchParams.get("pageSize"), String(SHELF_PAGE_SIZE));
    assert.equal(genre.searchParams.get("page"), "1");
    assert.equal(genre.searchParams.get("query"), "");
    assert.ok(genre.searchParams.get("includeGenres"));
    assert.equal(genre.searchParams.get("minYear"), null);

    const era = catalogueUrl(shelfRequest(SHELVES.find(({ kind }) => kind === "era")!), "http://localhost");
    assert.ok(era.searchParams.get("minYear") && era.searchParams.get("maxYear"));
    assert.equal(era.searchParams.get("includeGenres"), null);
  });
});

describe("createShelfLoader", () => {
  it("reads only the eager shelves when the home opens", () => {
    const source = manualLoad();
    const loader = createShelfLoader({ count: SHELVES.length, eager: EAGER_SHELVES, load: source.load, onChange: () => undefined });
    loader.start();
    loader.start();
    assert.deepEqual(source.calls, [0, 1]);
    assert.deepEqual(loader.states.slice(EAGER_SHELVES).map(({ phase }) => phase), SHELVES.slice(EAGER_SHELVES).map(() => "idle"));
  });

  it("reads a later shelf once when it is approached, however often that is reported", async () => {
    const source = manualLoad();
    const loader = createShelfLoader({ count: SHELVES.length, eager: EAGER_SHELVES, load: source.load, onChange: () => undefined });
    loader.start();
    assert.equal(loader.approach(4), true);
    assert.equal(loader.approach(4), false, "not twice while it loads");
    source.resolve(4, READY);
    await tick();
    assert.equal(loader.approach(4), false, "not again once loaded");
    assert.deepEqual(source.calls, [0, 1, 4]);
    assert.equal(loader.states[4].phase, "ready");
  });

  it("reads a failed shelf again only when asked to, and marks that read as a retry", async () => {
    const source = manualLoad();
    const states: (readonly ShelfState[])[] = [];
    const loader = createShelfLoader({ count: 3, eager: 1, load: source.load, onChange: (next) => states.push(next) });
    loader.start();
    source.resolve(0, { phase: "error", safeMessage: "down", retryable: true });
    await tick();
    assert.equal(loader.approach(0), false, "approaching does not retry");
    assert.equal(loader.retry(0), true);
    assert.deepEqual(loader.states[0], { phase: "loading", retrying: true });
    assert.equal(loader.retry(0), false, "not while the retry is in flight");
    assert.deepEqual(source.calls, [0, 0]);
  });

  it("never retries a failure that cannot succeed", async () => {
    const source = manualLoad();
    const loader = createShelfLoader({ count: 1, eager: 1, load: source.load, onChange: () => undefined });
    loader.start();
    source.resolve(0, { phase: "error", safeMessage: "bad data", retryable: false });
    await tick();
    assert.equal(loader.retry(0), false);
  });

  it("starts with shelves already held on screen and does not read them", () => {
    const source = manualLoad();
    const loader = createShelfLoader({ count: 3, eager: 2, load: source.load, onChange: () => undefined, initial: (index) => (index === 0 ? READY : null) });
    loader.start();
    assert.equal(loader.states[0].phase, "ready");
    assert.deepEqual(source.calls, [1]);
  });

  it("ignores answers that arrive after the home has gone", async () => {
    const source = manualLoad();
    const changes: unknown[] = [];
    const loader = createShelfLoader({ count: 2, eager: 1, load: source.load, onChange: (next) => changes.push(next) });
    loader.start();
    loader.dispose();
    source.resolve(0, READY);
    await tick();
    assert.equal(changes.length, 1, "only the loading state was published");
    assert.equal(loader.approach(1), false);
  });
});

describe("createShelfSource", () => {
  function catalogue() {
    const requests: CatalogueRequest[] = [];
    const waiting: ((state: CatalogueState) => void)[] = [];
    return {
      requests,
      request: (request: CatalogueRequest) => {
        requests.push(request);
        return new Promise<CatalogueState | null>((resolve) => waiting.push(resolve));
      },
      answer(state: CatalogueState) {
        waiting.shift()?.(state);
      },
    };
  }
  const ok: CatalogueState = { phase: "ready", response: { status: "ok", source: "tmdb", items: [title(7)], page: 1, pageSize: SHELF_PAGE_SIZE, total: 1, hasMore: false, attribution: "TMDB" } };

  it("keeps a loaded shelf for a while and hands it back without asking again", async () => {
    let now = 1_000;
    const upstream = catalogue();
    const source = createShelfSource({ request: upstream.request, now: () => now, keepMs: 60_000 });
    const first = source.load(2);
    upstream.answer(ok);
    assert.equal((await first).phase, "ready");
    assert.equal(source.peek(2)?.phase, "ready");
    assert.equal((await source.load(2)).phase, "ready");
    assert.equal(upstream.requests.length, 1);

    now += 60_001;
    assert.equal(source.peek(2), null, "a kept shelf expires");
    void source.load(2);
    assert.equal(upstream.requests.length, 2);
  });

  it("joins a read already in flight instead of starting another", async () => {
    const upstream = catalogue();
    const source = createShelfSource({ request: upstream.request });
    const a = source.load(0);
    const b = source.load(0);
    upstream.answer(ok);
    assert.deepEqual(await a, await b);
    assert.equal(upstream.requests.length, 1);
    assert.deepEqual(upstream.requests[0], shelfRequest(SHELVES[0]));
  });

  it("never keeps a failure", async () => {
    const upstream = catalogue();
    const source = createShelfSource({ request: upstream.request });
    const failed = source.load(1);
    upstream.answer({ phase: "error", code: "CATALOGUE_UNAVAILABLE", safeMessage: "down", retryable: true });
    assert.equal((await failed).phase, "error");
    assert.equal(source.peek(1), null);
    void source.load(1);
    assert.equal(upstream.requests.length, 2);
  });
});
