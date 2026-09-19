import { useCallback, useEffect, useRef, useState } from "react";
import {
  catalogueResponseSchema,
  CATALOGUE_LIMITS,
  writeCatalogueFilters,
  type CatalogueFilters,
  type CatalogueOk,
  type CatalogueResponse,
} from "../catalogue/contract";
import { JamError } from "../lib/errors";
import { createFeedController, EMPTY_FEED, seedFeed, type Feed, type PageResult } from "./pageFeed";
import { ensureAccessToken } from "../lib/session";

export type CatalogueState =
  /** While a refined shortlist reloads, the previous one stays on screen instead of a spinner. */
  | { phase: "loading"; previous?: CatalogueOk }
  | { phase: "ready"; response: CatalogueOk }
  | { phase: "not_configured"; missing: string[]; safeMessage: string }
  | { phase: "error"; code: string; safeMessage: string; retryable: boolean };

const SEARCH_DEBOUNCE_MS = 320;

const NETWORK_FAILURE: Extract<CatalogueState, { phase: "error" }> = {
  phase: "error",
  code: "CATALOGUE_REQUEST_FAILED",
  safeMessage: "Discover could not reach the catalogue service.",
  retryable: true,
};

const NOT_SIGNED_IN: Extract<CatalogueState, { phase: "error" }> = {
  phase: "error",
  code: "CATALOGUE_UNAUTHENTICATED",
  safeMessage: "Discover could not start a session to read the catalogue.",
  retryable: true,
};

const BROWSER_NOT_CONFIGURED: Extract<CatalogueState, { phase: "not_configured" }> = {
  phase: "not_configured",
  missing: ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"],
  safeMessage: "Discover needs a configured Supabase project to read the catalogue. No catalogue data is invented.",
};

const UNREADABLE_RESPONSE: Extract<CatalogueState, { phase: "error" }> = {
  phase: "error",
  code: "CATALOGUE_INVALID_RESPONSE",
  safeMessage: "Discover received a response it could not trust, so nothing is shown.",
  retryable: false,
};

function toState(response: CatalogueResponse): CatalogueState {
  if (response.status === "ok") return { phase: "ready", response };
  if (response.status === "catalogue_not_configured") {
    return { phase: "not_configured", missing: response.missing, safeMessage: response.safeMessage };
  }
  return { phase: "error", code: response.code, safeMessage: response.safeMessage, retryable: response.retryable };
}

/** Identifies one query and set of filters, as `loadedFor` reports them. */
export function catalogueRequestKey(query: string, filters: CatalogueFilters | null): string {
  return `${query}|${filters ? JSON.stringify(filters) : ""}`;
}

type PageRequest = { query: string; page: number; filters: CatalogueFilters | null };

/**
 * One catalogue request as the viewer's own Supabase session (anonymous sign-in if needed),
 * because the catalogue table is readable only by signed-in viewers. The payload is
 * re-validated in the browser, so an unexpected shape becomes an explicit error state instead
 * of a half-rendered title. Resolves to `null` when aborted.
 */
async function requestCatalogue({ query, page, filters }: PageRequest, signal: AbortSignal): Promise<CatalogueState | null> {
  const url = new URL("/api/catalogue", window.location.origin);
  url.searchParams.set("query", query.slice(0, CATALOGUE_LIMITS.queryMaxLength));
  url.searchParams.set("page", String(filters ? 1 : page));
  url.searchParams.set("pageSize", String(filters ? CATALOGUE_LIMITS.shortlistSize : CATALOGUE_LIMITS.pageSizeDefault));
  if (filters) writeCatalogueFilters(url.searchParams, filters);

  try {
    const accessToken = await ensureAccessToken("Browsing Discover").catch((error: unknown) => {
      throw error instanceof JamError && error.code === "not_configured" ? BROWSER_NOT_CONFIGURED : NOT_SIGNED_IN;
    });
    const response = await fetch(url, {
      signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    });
    const parsed = catalogueResponseSchema.safeParse(await response.json());
    if (signal.aborted) return null;
    return parsed.success ? toState(parsed.data) : UNREADABLE_RESPONSE;
  } catch (error: unknown) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return null;
    if (error === BROWSER_NOT_CONFIGURED) return BROWSER_NOT_CONFIGURED;
    if (error === NOT_SIGNED_IN) return NOT_SIGNED_IN;
    return NETWORK_FAILURE;
  }
}

/** A later page for the endless grid, as the feed expects it. */
async function requestNextPage(request: PageRequest, signal: AbortSignal): Promise<PageResult> {
  const state = await requestCatalogue(request, signal);
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
  const feedQuery = useRef<PageRequest>({ query: "", page: 1, filters: null });
  const [more] = useState(() =>
    createFeedController((page, signal) => requestNextPage({ ...feedQuery.current, page }, signal), setFeed),
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

      const request = { query, page: 1, filters: refined };
      void requestCatalogue(request, controller.signal).then((next) => {
        if (!next || controller.signal.aborted) return;
        feedQuery.current = request;
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
