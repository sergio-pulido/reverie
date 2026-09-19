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

/**
 * One read of `/api/catalogue`, shared by search and the home. Every caller goes through the
 * same request, validation and failure mapping, so a shelf and an answer can never disagree about
 * what a response means.
 */

export type CatalogueState =
  /** While a refined shortlist reloads, the previous one stays on screen instead of a spinner. */
  | { phase: "loading"; previous?: CatalogueOk }
  | { phase: "ready"; response: CatalogueOk }
  | { phase: "not_configured"; missing: string[]; safeMessage: string }
  | { phase: "error"; code: string; safeMessage: string; retryable: boolean };

const NETWORK_FAILURE: Extract<CatalogueState, { phase: "error" }> = {
  phase: "error",
  code: "CATALOGUE_REQUEST_FAILED",
  safeMessage: "The film service could not be reached.",
  retryable: true,
};

const NOT_SIGNED_IN: Extract<CatalogueState, { phase: "error" }> = {
  phase: "error",
  code: "CATALOGUE_UNAUTHENTICATED",
  safeMessage: "A session to read films could not be started.",
  retryable: true,
};

const BROWSER_NOT_CONFIGURED: Extract<CatalogueState, { phase: "not_configured" }> = {
  phase: "not_configured",
  missing: ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"],
  safeMessage: "Films need a configured Supabase project to be read. No catalogue data is invented.",
};

const UNREADABLE_RESPONSE: Extract<CatalogueState, { phase: "error" }> = {
  phase: "error",
  code: "CATALOGUE_INVALID_RESPONSE",
  safeMessage: "The film service sent a response that could not be trusted, so nothing is shown.",
  retryable: false,
};

function toState(response: CatalogueResponse): CatalogueState {
  if (response.status === "ok") return { phase: "ready", response };
  if (response.status === "catalogue_not_configured") {
    return { phase: "not_configured", missing: response.missing, safeMessage: response.safeMessage };
  }
  return { phase: "error", code: response.code, safeMessage: response.safeMessage, retryable: response.retryable };
}

export type CatalogueRequest = { query: string; page: number; pageSize: number; filters: CatalogueFilters | null };

/** The `/api/catalogue` URL for one request, on `origin`. */
export function catalogueUrl({ query, page, pageSize, filters }: CatalogueRequest, origin: string): URL {
  const url = new URL("/api/catalogue", origin);
  url.searchParams.set("query", query.slice(0, CATALOGUE_LIMITS.queryMaxLength));
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  if (filters) writeCatalogueFilters(url.searchParams, filters);
  return url;
}

/**
 * One catalogue request as the viewer's own Supabase session (anonymous sign-in if needed),
 * because the catalogue table is readable only by signed-in viewers. The payload is
 * re-validated in the browser, so an unexpected shape becomes an explicit error state instead
 * of a half-rendered title. Resolves to `null` when aborted.
 */
export async function requestCatalogue(request: CatalogueRequest, signal: AbortSignal): Promise<CatalogueState | null> {
  const url = catalogueUrl(request, window.location.origin);
  try {
    const accessToken = await ensureAccessToken("Browsing films").catch((error: unknown) => {
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
