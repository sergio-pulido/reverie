import { useCallback, useEffect, useRef, useState } from "react";
import { CATALOGUE_LIMITS, type CatalogueFilters } from "../catalogue/contract";
import type { CatalogueRequest, CatalogueState } from "./catalogueClient";
import { useCatalogueRead, type CatalogueRead } from "./CatalogueReadContext";
import { createFeedController, EMPTY_FEED, seedFeed, type Feed, type PageResult } from "./pageFeed";

export type { CatalogueState } from "./catalogueClient";

/** Identifies one query and set of filters, as `loadedFor` reports them. */
export function catalogueRequestKey(query: string, filters: CatalogueFilters | null): string {
  return `${query}|${filters ? JSON.stringify(filters) : ""}`;
}

/**
 * A request for the Discover grid: an unrefined browse pages through the default page size, a
 * refined one reads a single shortlist.
 */
function gridRequest(query: string, page: number, filters: CatalogueFilters | null): CatalogueRequest {
  return filters
    ? { query, page: 1, pageSize: CATALOGUE_LIMITS.shortlistSize, filters }
    : { query, page, pageSize: CATALOGUE_LIMITS.pageSizeDefault, filters: null };
}

const SEARCH_DEBOUNCE_MS = 320;

/** A later page for the endless grid, as the feed expects it. */
async function requestNextPage(read: CatalogueRead, request: CatalogueRequest, signal: AbortSignal): Promise<PageResult> {
  const state = await read(request, signal);
  if (state?.phase === "ready") return { ok: true, response: state.response };
  if (state?.phase === "error") return { ok: false, failure: { code: state.code, safeMessage: MORE_FAILED, retryable: state.retryable } };
  return { ok: false, failure: { code: "CATALOGUE_REQUEST_FAILED", safeMessage: MORE_FAILED, retryable: true } };
}

const MORE_FAILED = "More films could not be loaded.";

/**
 * Page 1 of a search, and the feed that grows from it.
 *
 * Unrefined, the grid is endless: `feed` holds every page appended so far, and `more` is the
 * controller the grid's triggers call. Refined, it reads one shortlist of
 * `CATALOGUE_LIMITS.shortlistSize` rows with every filter applied by the database, and the feed
 * never asks for more. A new query or refinement starts again from page 1. Nothing is read
 * until `enabled`.
 */
export function useCatalogue(query: string, filters: CatalogueFilters | null, enabled = true) {
  const [state, setState] = useState<CatalogueState>({ phase: "loading" });
  /** The query and filters the state on screen was loaded for, so callers never pair it with newer ones. */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [feed, setFeed] = useState<Feed>(EMPTY_FEED);
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const read = useCatalogueRead();
  const readRef = useRef(read);
  readRef.current = read;
  const feedQuery = useRef<{ query: string; filters: CatalogueFilters | null }>({ query: "", filters: null });
  const [more] = useState(() =>
    createFeedController((page, signal) => requestNextPage(readRef.current, gridRequest(feedQuery.current.query, page, feedQuery.current.filters), signal), setFeed),
  );
  const filtersKey = filters ? JSON.stringify(filters) : "";

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const refined: CatalogueFilters | null = filtersKey ? JSON.parse(filtersKey) : null;
    more.reset(EMPTY_FEED);
    const timer = window.setTimeout(() => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setState((current) => {
        const previous = current.phase === "ready" ? current.response : current.phase === "loading" ? current.previous : undefined;
        return refined && previous ? { phase: "loading", previous } : { phase: "loading" };
      });

      void readRef.current(gridRequest(query, 1, refined), controller.signal).then((next) => {
        if (!next || controller.signal.aborted) return;
        feedQuery.current = { query, filters: refined };
        setState(next);
        setLoadedFor(catalogueRequestKey(query, refined));
        if (next.phase === "ready") more.reset(seedFeed(next.response, !refined));
      });
    }, query ? SEARCH_DEBOUNCE_MS : 0);

    return () => window.clearTimeout(timer);
  }, [query, filtersKey, attempt, more, enabled]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      more.dispose();
    },
    [more],
  );

  return { state, retry, feed, more, loadedFor };
}
