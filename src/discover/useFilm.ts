import { useCallback, useEffect, useState } from "react";
import { catalogueTitleResponseSchema, type CatalogueTitleDetail } from "../catalogue/contract";
import { JamError } from "../lib/errors";
import { ensureAccessToken } from "../lib/session";

export type FilmState =
  | { phase: "loading" }
  | { phase: "ready"; film: CatalogueTitleDetail; attribution?: string }
  | { phase: "not_found" }
  | { phase: "not_configured"; safeMessage: string }
  | { phase: "error"; code: string; safeMessage: string; retryable: boolean };

const NOT_REACHABLE: FilmState = { phase: "error", code: "CATALOGUE_REQUEST_FAILED", safeMessage: "This film could not be loaded.", retryable: true };
const UNREADABLE: FilmState = { phase: "error", code: "CATALOGUE_INVALID_RESPONSE", safeMessage: "This film could not be shown.", retryable: false };
const NOT_CONFIGURED: FilmState = { phase: "not_configured", safeMessage: "Discover needs a configured Supabase project to show films." };

/**
 * One film's full record: a single request, for a single row. The answer is re-validated in the
 * browser, so an unexpected shape becomes an explicit error instead of a half-rendered page.
 * Resolves to `null` when aborted.
 */
export async function requestFilm(providerId: string, signal: AbortSignal): Promise<FilmState | null> {
  const url = new URL("/api/catalogue-title", window.location.origin);
  url.searchParams.set("id", providerId);
  try {
    const accessToken = await ensureAccessToken("Browsing Discover");
    const response = await fetch(url, { signal, headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
    const parsed = catalogueTitleResponseSchema.safeParse(await response.json());
    if (signal.aborted) return null;
    if (!parsed.success) return UNREADABLE;
    const body = parsed.data;
    if (body.status === "ok") return { phase: "ready", film: body.title, attribution: body.attribution };
    if (body.status === "not_found") return { phase: "not_found" };
    if (body.status === "catalogue_not_configured") return { phase: "not_configured", safeMessage: body.safeMessage };
    return { phase: "error", code: body.code, safeMessage: body.safeMessage, retryable: body.retryable };
  } catch (error: unknown) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return null;
    if (error instanceof JamError && error.code === "not_configured") return NOT_CONFIGURED;
    return NOT_REACHABLE;
  }
}

/** The film a page shows. An id that is not a film id is "not found" without any request. */
export function useFilm(providerId: string | null) {
  const [state, setState] = useState<FilmState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!providerId) {
      setState({ phase: "not_found" });
      return;
    }
    const controller = new AbortController();
    setState({ phase: "loading" });
    void requestFilm(providerId, controller.signal).then((next) => {
      if (next && !controller.signal.aborted) setState(next);
    });
    return () => controller.abort();
  }, [providerId, attempt]);

  return { state, retry };
}
