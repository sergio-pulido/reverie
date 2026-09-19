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

/**
 * Reads the catalogue endpoint as the viewer's own Supabase session (anonymous sign-in if
 * needed), because the catalogue table is readable only by signed-in viewers. Every payload
 * is re-validated in the browser, so an unexpected shape becomes an explicit error state
 * instead of a half-rendered title.
 *
 * With `filters`, it reads one shortlist of `CATALOGUE_LIMITS.shortlistSize` rows with every
 * filter applied by the database, instead of a page.
 */
export function useCatalogue(query: string, page: number, filters: CatalogueFilters | null) {
  const [state, setState] = useState<CatalogueState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const filtersKey = filters ? JSON.stringify(filters) : "";

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const refined: CatalogueFilters | null = filtersKey ? JSON.parse(filtersKey) : null;
    const timer = window.setTimeout(() => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setState((current) => {
        const previous = current.phase === "ready" ? current.response : current.phase === "loading" ? current.previous : undefined;
        return refined && previous ? { phase: "loading", previous } : { phase: "loading" };
      });

      const url = new URL("/api/catalogue", window.location.origin);
      url.searchParams.set("query", query.slice(0, CATALOGUE_LIMITS.queryMaxLength));
      url.searchParams.set("page", String(refined ? 1 : page));
      url.searchParams.set("pageSize", String(refined ? CATALOGUE_LIMITS.shortlistSize : CATALOGUE_LIMITS.pageSizeDefault));
      if (refined) writeCatalogueFilters(url.searchParams, refined);

      void ensureAccessToken("Browsing Discover")
        .catch((error: unknown) => {
          throw error instanceof JamError && error.code === "not_configured" ? BROWSER_NOT_CONFIGURED : NOT_SIGNED_IN;
        })
        .then((accessToken) =>
          fetch(url, {
            signal: controller.signal,
            headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
          }),
        )
        .then(async (response) => {
          const parsed = catalogueResponseSchema.safeParse(await response.json());
          if (controller.signal.aborted) return;
          setState(parsed.success ? toState(parsed.data) : UNREADABLE_RESPONSE);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
          if (error === BROWSER_NOT_CONFIGURED) setState(BROWSER_NOT_CONFIGURED);
          else setState(error === NOT_SIGNED_IN ? NOT_SIGNED_IN : NETWORK_FAILURE);
        });
    }, query ? SEARCH_DEBOUNCE_MS : 0);

    return () => window.clearTimeout(timer);
  }, [query, page, filtersKey, attempt]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { state, retry };
}
