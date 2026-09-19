import { z } from "zod";
import {
  CATALOGUE_LIMITS,
  catalogueTitleDetailSchema,
  namespaceCatalogueId,
  type CatalogueTitleDetail,
  type CatalogueTitleNotFound,
  type CatalogueTitleResponse,
} from "../../src/catalogue/contract";
import {
  errorResponse,
  languageOf,
  mapRestError,
  notConfiguredResponse,
  releaseYear,
  SYNOPSIS_MAX_LENGTH,
  TMDB_ATTRIBUTION,
  TMDB_POSTER_BASE,
  tmdbImageUrl,
  truncate,
  UNAUTHENTICATED_RESPONSE,
  type CatalogueAdapterOptions,
} from "./supabase-catalogue";
import { callRpc, readSupabaseConfig } from "./supabase-rest";

/**
 * Serves one film's page from `get_catalogue_title`: exactly one row, by primary key, read as
 * the caller under RLS. The grid query stays lean; only this page pays for the full record.
 *
 * A field the row does not state is left out of the mapped title. Nothing is defaulted: no
 * "unknown" tagline, no zero rating, no zero runtime. Availability stays empty.
 */

export const CATALOGUE_TITLE_RPC = "get_catalogue_title";
/** A film page shows its backdrop full-bleed, so it reads a wider rendition than the grid. */
export const TMDB_DETAIL_BACKDROP_BASE = "https://image.tmdb.org/t/p/w1280";

const KEYWORDS_MAX = 60;
const SPOKEN_LANGUAGES_MAX = 40;
const GENRES_MAX = 12;

const detailRowSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  original_title: z.string().nullable().optional(),
  release_date: z.string().nullable().optional(),
  runtime: z.number().nullable().optional(),
  vote_average: z.number().nullable().optional(),
  vote_count: z.number().nullable().optional(),
  original_language: z.string().nullable().optional(),
  spoken_languages: z.string().nullable().optional(),
  poster_path: z.string().nullable().optional(),
  backdrop_path: z.string().nullable().optional(),
  overview: z.string().nullable().optional(),
  tagline: z.string().nullable().optional(),
  genres: z.string().nullable().optional(),
  keywords: z.string().nullable().optional(),
  imdb_id: z.string().nullable().optional(),
});

export type CatalogueDetailRow = z.infer<typeof detailRowSchema>;

export const TITLE_NOT_FOUND: CatalogueTitleNotFound = {
  status: "not_found",
  code: "CATALOGUE_TITLE_NOT_FOUND",
  safeMessage: "There is no film with that id.",
};

export async function fetchCatalogueTitle(
  providerId: number,
  accessToken: string | null,
  options: CatalogueAdapterOptions = {},
): Promise<CatalogueTitleResponse> {
  const config = readSupabaseConfig(options.environment ?? process.env);
  if (!config) return notConfiguredResponse();
  if (!accessToken) return UNAUTHENTICATED_RESPONSE;
  if (!Number.isSafeInteger(providerId) || providerId <= 0) return TITLE_NOT_FOUND;

  let body: unknown;
  try {
    body = await callRpc(
      config,
      accessToken,
      CATALOGUE_TITLE_RPC,
      { title_id: providerId },
      { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs ?? CATALOGUE_LIMITS.timeoutMsDefault },
    );
  } catch (error) {
    return mapRestError(error);
  }

  if (body === null) return TITLE_NOT_FOUND;
  const title = toCatalogueTitleDetail(body);
  if (!title || title.id !== namespaceCatalogueId(String(providerId))) {
    return errorResponse("CATALOGUE_INVALID_RESPONSE", "The catalogue returned a record Discover could not trust.", false);
  }
  return { status: "ok", source: "tmdb", title, attribution: TMDB_ATTRIBUTION };
}

/** Maps the full row, or returns null: a record that cannot be trusted is never half-rendered. */
export function toCatalogueTitleDetail(raw: unknown): CatalogueTitleDetail | null {
  const row = detailRowSchema.safeParse(raw);
  if (!row.success) return null;
  const detail = catalogueTitleDetailSchema.safeParse(mapDetailRow(row.data));
  return detail.success ? detail.data : null;
}

function mapDetailRow(row: CatalogueDetailRow) {
  const title = row.title.trim();
  const originalTitle = row.original_title?.trim();
  return withoutUndefined({
    id: namespaceCatalogueId(String(row.id)),
    title,
    originalTitle: originalTitle && originalTitle !== title ? originalTitle : undefined,
    tagline: row.tagline?.trim() || undefined,
    year: releaseYear(row.release_date),
    releaseDate: releaseYear(row.release_date) ? row.release_date ?? undefined : undefined,
    synopsis: truncate(row.overview?.trim(), SYNOPSIS_MAX_LENGTH),
    genres: splitList(row.genres, GENRES_MAX),
    runtimeMinutes: row.runtime && row.runtime > 0 ? Math.trunc(row.runtime) : undefined,
    ...scoreOf(row.vote_average, row.vote_count),
    ...languageOf(row.original_language),
    spokenLanguages: splitList(row.spoken_languages, SPOKEN_LANGUAGES_MAX),
    keywords: splitList(row.keywords, KEYWORDS_MAX),
    imdbId: row.imdb_id && /^tt\d{5,10}$/.test(row.imdb_id.trim()) ? row.imdb_id.trim() : undefined,
    posterUrl: tmdbImageUrl(TMDB_POSTER_BASE, row.poster_path),
    backdropUrl: tmdbImageUrl(TMDB_DETAIL_BACKDROP_BASE, row.backdrop_path),
    attribution: TMDB_ATTRIBUTION,
    availability: [],
  });
}

/** A score is shown only with the votes behind it; zero votes means there is no score. */
function scoreOf(average: number | null | undefined, count: number | null | undefined) {
  if (!average || !count || average <= 0 || count <= 0 || average > 10) return {};
  return { voteAverage: average, voteCount: Math.trunc(count) };
}

function splitList(text: string | null | undefined, max: number) {
  if (!text) return [];
  const seen = new Set<string>();
  for (const part of text.split(",")) {
    const value = part.trim();
    if (value.length > 0 && value.length <= 80) seen.add(value);
    if (seen.size === max) break;
  }
  return [...seen];
}

/** Drops absent keys so the mapped record carries only what the row states. */
function withoutUndefined<T extends Record<string, unknown>>(record: T) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
