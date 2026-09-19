import { CATALOGUE_LIMITS, type CatalogueOk, type CatalogueTitle } from "../catalogue/contract";

/**
 * An endless poster grid built on the page-based catalogue query: page 1 arrives as usual, and
 * every later page is appended when the viewer nears the end. Nothing here touches React or the
 * DOM, so the triggers and the single-flight rule are testable directly.
 *
 * Two triggers ask for the next page: focus reaching the last row (a remote moves focus, not the
 * scrollbar) and the end of the grid nearing the viewport (mouse and touch). Either may fire
 * any number of times; at most one request is ever in flight and a trigger during it is dropped,
 * not queued. After the last page, or after a failure, triggers do nothing until `retry`.
 */

export type FeedFailure = { code: string; safeMessage: string; retryable: boolean };

export type Feed = {
  items: readonly CatalogueTitle[];
  /** The last page appended; 0 before the first page. */
  page: number;
  hasMore: boolean;
  loading: boolean;
  failure: FeedFailure | null;
};

export const EMPTY_FEED: Feed = { items: [], page: 0, hasMore: false, loading: false, failure: null };

/** What loading one page yields: the page, or why it failed. */
export type PageResult = { ok: true; response: CatalogueOk } | { ok: false; failure: FeedFailure };

export type PageLoader = (page: number, signal: AbortSignal) => Promise<PageResult>;

/** The feed after page 1: appending is on only when the grid shows pages (not a shortlist). */
export function seedFeed(first: CatalogueOk, pageable: boolean): Feed {
  return { items: dedupe([], first.items), page: first.page, hasMore: pageable && canPageAfter(first), loading: false, failure: null };
}

/** Appends a page after the ones already shown. Titles already on screen keep their place. */
export function appendPage(feed: Feed, response: CatalogueOk): Feed {
  return {
    items: dedupe(feed.items, response.items),
    page: response.page,
    hasMore: canPageAfter(response),
    loading: false,
    failure: null,
  };
}

export function canRequestMore(feed: Feed) {
  return feed.hasMore && !feed.loading && feed.failure === null;
}

/** True when `index` sits in the grid's last row, however short that row is. */
export function isInLastRow(index: number, count: number, columns: number) {
  if (count <= 0 || index < 0 || index >= count) return false;
  const width = Math.max(1, Math.floor(columns));
  const lastRowStart = (count - 1) - ((count - 1) % width);
  return index >= lastRowStart;
}

/** The query refuses pages past its own maximum, so the feed ends there even if more match. */
function canPageAfter(response: CatalogueOk) {
  return response.hasMore && response.page < CATALOGUE_LIMITS.pageMax;
}

function dedupe(existing: readonly CatalogueTitle[], incoming: readonly CatalogueTitle[]) {
  const seen = new Set(existing.map(({ id }) => id));
  const added = incoming.filter(({ id }) => (seen.has(id) ? false : (seen.add(id), true)));
  return added.length === 0 ? existing : [...existing, ...added];
}

/**
 * Owns one feed and its single in-flight request. `reset` starts a new feed (a new search or
 * refinement); anything still in flight for the old one is aborted and its answer ignored.
 */
export function createFeedController(loadPage: PageLoader, onChange: (feed: Feed) => void) {
  let feed = EMPTY_FEED;
  let generation = 0;
  let controller: AbortController | null = null;

  const publish = (next: Feed) => {
    feed = next;
    onChange(feed);
  };

  function cancel() {
    generation += 1;
    controller?.abort();
    controller = null;
  }

  /** Requests the next page. Returns false when the request was not started. */
  function requestNext(): boolean {
    if (!canRequestMore(feed)) return false;
    const mine = generation;
    const nextPage = feed.page + 1;
    controller = new AbortController();
    const { signal } = controller;
    publish({ ...feed, loading: true });
    void loadPage(nextPage, signal)
      .catch((): PageResult => ({ ok: false, failure: { code: "CATALOGUE_REQUEST_FAILED", safeMessage: "More films could not be loaded.", retryable: true } }))
      .then((result) => {
        if (mine !== generation || signal.aborted) return;
        controller = null;
        publish(result.ok ? appendPage(feed, result.response) : { ...feed, loading: false, failure: result.failure });
      });
    return true;
  }

  return {
    get feed() {
      return feed;
    },
    reset(next: Feed) {
      cancel();
      publish(next);
    },
    /** Focus moved to `index`: the last row asks for more. */
    focusMoved(index: number, columns: number) {
      return isInLastRow(index, feed.items.length, columns) ? requestNext() : false;
    },
    /** The end of the grid came within reach of the viewport. */
    endInView() {
      return requestNext();
    },
    /** Clears a failure and asks again; the titles already loaded stay. */
    retry() {
      if (!feed.failure) return false;
      feed = { ...feed, failure: null };
      return requestNext();
    },
    dispose: cancel,
  };
}

export type FeedController = ReturnType<typeof createFeedController>;
