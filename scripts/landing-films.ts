// Build-time read of the films the public landing page shows.
//
// A landing visitor has no session and the catalogue is readable only by a signed-in viewer.
// Rather than loosen that, the build becomes a viewer once: it signs in anonymously with the
// public anon key, exactly as a browser opening Discover does, and reads through the same
// `fetchCatalogue` adapter `/api/catalogue` uses, under the same RLS. No service key is held,
// nothing about the catalogue's policies changes, and the page ships with its films already in
// it, so it makes no catalogue request of its own.

import { z } from "zod";
import { fetchCatalogue } from "../api/_lib/supabase-catalogue";
import { readSupabaseConfig, type SupabaseConfig } from "../api/_lib/supabase-rest";
import { catalogueQuerySchema, type CatalogueResponse } from "../src/catalogue/contract";
import { GENTLE_FILTERS, SHELF_FILTERS, selectLandingFilms, type LandingFilms } from "../src/landing/films";

export type LandingFilmsRead = { status: "ok"; films: LandingFilms } | { status: "unavailable"; reason: string };

export type LandingFilmsOptions = { fetchImpl?: typeof fetch; timeoutMs?: number };

const DEFAULT_TIMEOUT_MS = 8_000;
/** Read past what is shown, so a row the adapter refuses does not leave the shelf short. */
const POPULAR_PAGE_SIZE = 24;
const GENTLE_PAGE_SIZE = 8;

const signInSchema = z.object({ access_token: z.string().min(16).max(4_096) });

class ReadError extends Error {}

export async function readLandingFilms(
  env: NodeJS.ProcessEnv,
  options: LandingFilmsOptions = {},
): Promise<LandingFilmsRead> {
  const config = readSupabaseConfig(env);
  if (!config) return { status: "unavailable", reason: "Supabase is not configured (SUPABASE_URL / SUPABASE_ANON_KEY)" };

  try {
    const token = await signInAnonymously(config, options);
    const adapter = { environment: env, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };
    const [popular, gentle] = await Promise.all([
      fetchCatalogue(catalogueQuerySchema.parse({ pageSize: POPULAR_PAGE_SIZE, ...SHELF_FILTERS }), token, adapter),
      fetchCatalogue(catalogueQuerySchema.parse({ pageSize: GENTLE_PAGE_SIZE, ...GENTLE_FILTERS }), token, adapter),
    ]);
    const films = selectLandingFilms(itemsOf(popular), itemsOf(gentle));
    if (films.shelf.length === 0) return { status: "unavailable", reason: "the catalogue returned no films with posters" };
    return { status: "ok", films };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof ReadError ? error.message : "the catalogue could not be reached" };
  }
}

function itemsOf(response: CatalogueResponse) {
  if (response.status === "ok") return response.items;
  throw new ReadError(`the catalogue read failed: ${response.safeMessage}`);
}

/** A fresh anonymous viewer's access token. The token is never logged or returned in a reason. */
async function signInAnonymously(config: SupabaseConfig, options: LandingFilmsOptions): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${config.url}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: config.anonKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ data: {} }),
      signal: controller.signal,
    });
    if (!response.ok) throw new ReadError(`anonymous sign-in was refused (HTTP ${response.status})`);
    const body = signInSchema.safeParse(await response.json().catch(() => null));
    if (!body.success) throw new ReadError("anonymous sign-in returned no usable session");
    return body.data.access_token;
  } finally {
    clearTimeout(timeout);
  }
}
