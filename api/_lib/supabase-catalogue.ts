import { z } from "zod";
import {
  CATALOGUE_LIMITS,
  catalogueTitleSchema,
  namespaceCatalogueId,
  type CatalogueError,
  type CatalogueFilters,
  type CatalogueNotConfigured,
  type CatalogueOk,
  type CatalogueQuery,
  type CatalogueResponse,
  type CatalogueTitle,
} from "../../src/catalogue/contract.js";
import { callRpc, readSupabaseConfig, RestError } from "./supabase-rest.js";

/**
 * Serves Discover from `public.catalogue_titles`, a curated snapshot of the TMDB dataset held
 * in Supabase. There is no Titan catalogue API; this table is the whole catalogue.
 *
 * Reads go through `search_catalogue_titles` as the caller, under RLS, and return one page
 * of only the columns mapped below. The snapshot carries no availability, so every title is
 * returned with `availability: []`: nothing is synthesised, inferred or placeholdered.
 */

export const CATALOGUE_RPC = "search_catalogue_titles";
export const TMDB_POSTER_BASE = "https://image.tmdb.org/t/p/w500";
export const TMDB_BACKDROP_BASE = "https://image.tmdb.org/t/p/w780";
export const TMDB_ATTRIBUTION =
  "Film data and images from TMDB (themoviedb.org). This product uses TMDB data but is not endorsed or certified by TMDB.";

export const SYNOPSIS_MAX_LENGTH = catalogueTitleSchema.shape.synopsis.unwrap().maxLength ?? 1_200;
const GENRES_MAX = 12;
/** TMDB image paths are a single slash-led file name. Anything else is not rendered. */
const TMDB_IMAGE_PATH = /^\/[A-Za-z0-9._-]+$/;

const rowSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  release_date: z.string().nullable().optional(),
  runtime: z.number().nullable().optional(),
  poster_path: z.string().nullable().optional(),
  backdrop_path: z.string().nullable().optional(),
  overview: z.string().nullable().optional(),
  genres: z.string().nullable().optional(),
  original_language: z.string().nullable().optional(),
});

const rpcResultSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(z.unknown()).max(CATALOGUE_LIMITS.maxItemsPerResponse),
});

export type CatalogueRow = z.infer<typeof rowSchema>;

export type CatalogueAdapterOptions = {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function notConfiguredResponse(): CatalogueNotConfigured {
  return {
    status: "catalogue_not_configured",
    code: "CATALOGUE_NOT_CONFIGURED",
    safeMessage:
      "The catalogue database is not configured, so Reverie has no real titles to show. No catalogue data is invented.",
    missing: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
  };
}

export function errorResponse(code: string, safeMessage: string, retryable: boolean): CatalogueError {
  return { status: "error", code, safeMessage, retryable };
}

export const UNAUTHENTICATED_RESPONSE = errorResponse(
  "CATALOGUE_UNAUTHENTICATED",
  "Discover needs a signed-in session to read the catalogue.",
  true,
);

export async function fetchCatalogue(
  query: CatalogueQuery,
  accessToken: string | null,
  options: CatalogueAdapterOptions = {},
): Promise<CatalogueResponse> {
  const config = readSupabaseConfig(options.environment ?? process.env);
  if (!config) return notConfiguredResponse();
  if (!accessToken) return UNAUTHENTICATED_RESPONSE;

  let body: unknown;
  try {
    body = await callRpc(
      config,
      accessToken,
      CATALOGUE_RPC,
      { search: query.query, page_number: query.page, page_size: query.pageSize, ...toRpcFilters(query) },
      { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs ?? CATALOGUE_LIMITS.timeoutMsDefault },
    );
  } catch (error) {
    return mapRestError(error);
  }

  const parsed = rpcResultSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("CATALOGUE_INVALID_RESPONSE", "The catalogue returned a response Discover could not trust.", false);
  }

  const items = parsed.data.items
    .slice(0, query.pageSize)
    .map(toCatalogueTitle)
    .filter((title): title is CatalogueTitle => title !== null);
  const ok: CatalogueOk = {
    status: "ok",
    source: "tmdb",
    items,
    page: query.page,
    pageSize: query.pageSize,
    total: parsed.data.total,
    hasMore: query.page * query.pageSize < parsed.data.total,
    attribution: TMDB_ATTRIBUTION,
  };
  return ok;
}

/**
 * The filters as the function's named arguments. Only the ones that are set are sent, so an
 * unrefined search is the same call it always was and the database defaults stay authoritative.
 */
export function toRpcFilters(filters: CatalogueFilters): Record<string, number | readonly (string | number)[]> {
  const rpc: Record<string, number | readonly (string | number)[]> = {};
  if (filters.minRuntime !== undefined) rpc.min_runtime = filters.minRuntime;
  if (filters.maxRuntime !== undefined) rpc.max_runtime = filters.maxRuntime;
  if (filters.minYear !== undefined) rpc.min_year = filters.minYear;
  if (filters.maxYear !== undefined) rpc.max_year = filters.maxYear;
  if (filters.includeGenres) rpc.include_genres = filters.includeGenres;
  if (filters.excludeGenres) rpc.exclude_genres = filters.excludeGenres;
  if (filters.excludeIds) rpc.exclude_ids = filters.excludeIds;
  return rpc;
}

export function mapRestError(error: unknown): CatalogueError {
  if (error instanceof RestError && error.code === "unauthenticated") return UNAUTHENTICATED_RESPONSE;
  if (error instanceof RestError && error.code === "forbidden") {
    return errorResponse("CATALOGUE_FORBIDDEN", "This session is not allowed to read the catalogue.", false);
  }
  return errorResponse("CATALOGUE_UNAVAILABLE", "The catalogue could not be reached right now.", true);
}

/** Maps one row, or drops it: a record that cannot be trusted is never half-rendered. */
export function toCatalogueTitle(raw: unknown): CatalogueTitle | null {
  const row = rowSchema.safeParse(raw);
  if (!row.success) return null;
  const candidate = catalogueTitleSchema.safeParse(mapRow(row.data));
  return candidate.success ? candidate.data : null;
}

function mapRow(row: CatalogueRow) {
  return {
    id: namespaceCatalogueId(String(row.id)),
    title: row.title,
    year: releaseYear(row.release_date),
    synopsis: truncate(row.overview?.trim(), SYNOPSIS_MAX_LENGTH),
    genres: splitGenres(row.genres),
    runtimeMinutes: row.runtime && row.runtime > 0 ? Math.trunc(row.runtime) : undefined,
    posterUrl: tmdbImageUrl(TMDB_POSTER_BASE, row.poster_path),
    backdropUrl: tmdbImageUrl(TMDB_BACKDROP_BASE, row.backdrop_path),
    ...languageOf(row.original_language),
    attribution: TMDB_ATTRIBUTION,
    availability: [],
  };
}

export function releaseYear(releaseDate: string | null | undefined) {
  const match = releaseDate ? /^(\d{4})-\d{2}-\d{2}$/.exec(releaseDate) : null;
  return match ? Number(match[1]) : undefined;
}

export function truncate(text: string | undefined, maxLength: number) {
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function splitGenres(genres: string | null | undefined) {
  if (!genres) return [];
  return genres
    .split(", ")
    .map((genre) => genre.trim())
    .filter((genre) => genre.length > 0)
    .slice(0, GENRES_MAX);
}

/** Present only when the row states a well-formed code; a missing language is never defaulted. */
export function languageOf(code: string | null | undefined) {
  const normalized = code?.trim().toLowerCase();
  return normalized && /^[a-z]{2,3}$/.test(normalized) ? { originalLanguage: normalized } : {};
}

export function tmdbImageUrl(base: string, path: string | null | undefined) {
  return path && TMDB_IMAGE_PATH.test(path) ? `${base}${path}` : undefined;
}
