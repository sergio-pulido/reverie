import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogueOk, CatalogueTitle } from "../src/catalogue/contract";
import {
  appendPage,
  createFeedController,
  isInLastRow,
  seedFeed,
  type Feed,
  type PageResult,
} from "../src/discover/pageFeed";

const PAGE_SIZE = 6;
const COLUMNS = 3;

function titles(page: number, count = PAGE_SIZE): CatalogueTitle[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `cat:${page * 100 + index}`,
    title: `Film ${page}.${index}`,
    genres: [],
    availability: [],
  }));
}

function pageOf(page: number, total: number, count = PAGE_SIZE): CatalogueOk {
  return { status: "ok", source: "tmdb", items: titles(page, count), page, pageSize: PAGE_SIZE, total, hasMore: page * PAGE_SIZE < total };
}

/** A page loader whose answers the test releases by hand, so "in flight" is observable. */
function manualLoader() {
  const calls: Array<{ page: number; signal: AbortSignal; resolve: (result: PageResult) => void }> = [];
  const load = (page: number, signal: AbortSignal) =>
    new Promise<PageResult>((resolve) => {
      calls.push({ page, signal, resolve });
    });
  return { calls, load };
}

function setup(total = 24) {
  const loader = manualLoader();
  const seen: Feed[] = [];
  const controller = createFeedController(loader.load, (feed) => seen.push(feed));
  controller.reset(seedFeed(pageOf(1, total), true));
  return { loader, controller, seen };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the last row is recognised for full and short rows", () => {
  assert.equal(isInLastRow(3, 6, 3), true);
  assert.equal(isInLastRow(2, 6, 3), false);
  assert.equal(isInLastRow(6, 7, 3), true, "a one-poster last row");
  assert.equal(isInLastRow(5, 7, 3), false);
  assert.equal(isInLastRow(0, 1, 7), true);
  assert.equal(isInLastRow(9, 6, 3), false, "outside the grid");
  assert.equal(isInLastRow(0, 0, 3), false);
});

test("focus moving into the last row loads the next page", async () => {
  const { loader, controller } = setup();
  assert.equal(controller.focusMoved(1, COLUMNS), false, "the first row does not ask");
  assert.equal(loader.calls.length, 0);

  assert.equal(controller.focusMoved(4, COLUMNS), true);
  assert.equal(loader.calls.length, 1);
  assert.equal(loader.calls[0].page, 2);
  assert.equal(controller.feed.loading, true);

  loader.calls[0].resolve({ ok: true, response: pageOf(2, 24) });
  await flush();
  assert.equal(controller.feed.items.length, 12);
  assert.equal(controller.feed.loading, false);
});

test("the end of the grid coming into view loads the next page", async () => {
  const { loader, controller } = setup();
  assert.equal(controller.endInView(), true);
  assert.deepEqual(loader.calls.map(({ page }) => page), [2]);
  loader.calls[0].resolve({ ok: true, response: pageOf(2, 24) });
  await flush();
  assert.equal(controller.feed.page, 2);
});

test("a second trigger while a page is loading is ignored, not queued", async () => {
  const { loader, controller } = setup();
  controller.focusMoved(5, COLUMNS);
  assert.equal(controller.endInView(), false);
  assert.equal(controller.focusMoved(4, COLUMNS), false);
  assert.equal(controller.endInView(), false);
  assert.equal(loader.calls.length, 1);

  loader.calls[0].resolve({ ok: true, response: pageOf(2, 24) });
  await flush();
  assert.equal(loader.calls.length, 1, "nothing was queued behind the first request");
  assert.equal(controller.feed.page, 2);
});

test("appending keeps every title already on screen where it was, so focus stays put", async () => {
  const { loader, controller } = setup();
  const before = controller.feed.items;
  const focusedIndex = 4;
  const focusedId = before[focusedIndex].id;

  controller.focusMoved(focusedIndex, COLUMNS);
  loader.calls[0].resolve({ ok: true, response: pageOf(2, 24) });
  await flush();

  const after = controller.feed.items;
  assert.equal(after.length, before.length + PAGE_SIZE);
  before.forEach((title, index) => assert.equal(after[index], title, `title ${index} is the same object in the same place`));
  assert.equal(after[focusedIndex].id, focusedId, "the focused index still names the focused film");
  assert.equal(new Set(after.map(({ id }) => id)).size, after.length, "keys stay unique");
});

test("a page repeating titles already shown appends only the new ones", () => {
  const first = seedFeed(pageOf(1, 24), true);
  const overlap: CatalogueOk = { ...pageOf(2, 24), items: [...titles(1).slice(4), ...titles(2).slice(0, 4)] };
  const next = appendPage(first, overlap);
  assert.equal(next.items.length, PAGE_SIZE + 4);
  assert.deepEqual(next.items.slice(0, PAGE_SIZE), first.items);
});

test("reaching the last page stops further requests", async () => {
  const { loader, controller } = setup(12);
  controller.endInView();
  loader.calls[0].resolve({ ok: true, response: pageOf(2, 12) });
  await flush();

  assert.equal(controller.feed.hasMore, false);
  assert.equal(controller.endInView(), false);
  assert.equal(controller.focusMoved(controller.feed.items.length - 1, COLUMNS), false);
  assert.equal(loader.calls.length, 1);
  assert.equal(controller.feed.failure, null, "an ended feed is not an error");
});

test("a single page, or a refined shortlist, never asks for more", () => {
  const loader = manualLoader();
  const controller = createFeedController(loader.load, () => {});
  controller.reset(seedFeed(pageOf(1, 4, 4), true));
  assert.equal(controller.endInView(), false);
  controller.reset(seedFeed(pageOf(1, 4_000), false));
  assert.equal(controller.endInView(), false);
  assert.equal(loader.calls.length, 0);
});

test("a failed page keeps what is loaded, stops triggering, and recovers on retry", async () => {
  const { loader, controller } = setup();
  const before = controller.feed.items;
  controller.endInView();
  loader.calls[0].resolve({ ok: false, failure: { code: "CATALOGUE_UNAVAILABLE", safeMessage: "More films could not be loaded.", retryable: true } });
  await flush();

  assert.equal(controller.feed.items, before, "everything loaded stays on screen");
  assert.equal(controller.feed.failure?.code, "CATALOGUE_UNAVAILABLE");
  assert.equal(controller.endInView(), false, "a failure is not retried behind the viewer's back");
  assert.equal(loader.calls.length, 1);

  assert.equal(controller.retry(), true);
  assert.equal(loader.calls[1].page, 2, "the same page is asked for again");
  loader.calls[1].resolve({ ok: true, response: pageOf(2, 24) });
  await flush();
  assert.equal(controller.feed.failure, null);
  assert.equal(controller.feed.items.length, 12);
});

test("a thrown loader error becomes a recoverable failure", async () => {
  const controller = createFeedController(() => Promise.reject(new TypeError("fetch failed")), () => {});
  controller.reset(seedFeed(pageOf(1, 24), true));
  controller.endInView();
  await flush();
  assert.equal(controller.feed.failure?.retryable, true);
  assert.equal(controller.feed.items.length, PAGE_SIZE);
});

test("a new search resets the feed and ignores the old search's page when it lands", async () => {
  const { loader, controller } = setup();
  controller.endInView();
  const stale = loader.calls[0];

  controller.reset(seedFeed({ ...pageOf(7, 24), page: 1, hasMore: true }, true));
  assert.equal(stale.signal.aborted, true, "the old request is aborted");
  stale.resolve({ ok: true, response: pageOf(2, 24) });
  await flush();

  assert.equal(controller.feed.page, 1);
  assert.equal(controller.feed.items[0].id, "cat:700");
  assert.equal(controller.feed.loading, false);
  assert.equal(controller.endInView(), true, "the new feed can page from its own start");
  assert.equal(loader.calls[1].page, 2);
});
