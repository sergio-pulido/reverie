import { useCallback, useEffect, useRef, useState } from "react";
import {
  catalogueResponseSchema,
  CATALOGUE_LIMITS,
  type CatalogueResponse,
} from "../catalogue/contract";

export type CatalogueState =
  | { phase: "loading" }
  | { phase: "ready"; response: Extract<CatalogueResponse, { status: "ok" }> }
  | { phase: "not_configured"; missing: string[]; safeMessage: string }
  | { phase: "error"; code: string; safeMessage: string; retryable: boolean };

const SEARCH_DEBOUNCE_MS = 320;

const NETWORK_FAILURE: Extract<CatalogueState, { phase: "error" }> = {
  phase: "error",
  code: "CATALOGUE_REQUEST_FAILED",
  safeMessage: "Discover could not reach the catalogue service.",
  retryable: true,
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
 * Reads the privileged catalogue endpoint. Every payload is re-validated in the browser, so
 * an unexpected shape becomes an explicit error state instead of a half-rendered title.
 */
export function useCatalogue(query: string, page: number) {
  const [state, setState] = useState<CatalogueState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setState({ phase: "loading" });

      const url = new URL("/api/catalogue", window.location.origin);
      url.searchParams.set("query", query.slice(0, CATALOGUE_LIMITS.queryMaxLength));
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(CATALOGUE_LIMITS.pageSizeDefault));

      void fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } })
        .then(async (response) => {
          const parsed = catalogueResponseSchema.safeParse(await response.json());
          if (controller.signal.aborted) return;
          setState(parsed.success ? toState(parsed.data) : UNREADABLE_RESPONSE);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
          setState(NETWORK_FAILURE);
        });
    }, query ? SEARCH_DEBOUNCE_MS : 0);

    return () => window.clearTimeout(timer);
  }, [query, page, attempt]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { state, retry };
}
