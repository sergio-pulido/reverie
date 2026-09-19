import { z } from "zod";
import { GENRES, type GenreSlug } from "./genres.js";

/**
 * Catalogue contract shared by the privileged catalogue adapter and the Discover UI.
 * It is provider-free and must stay independent of React, browser APIs and provider SDKs.
 */

export const CATALOGUE_LIMITS = {
  queryMaxLength: 120,
  pageMin: 1,
  pageMax: 100,
  pageSizeMin: 1,
  pageSizeMax: 48,
  pageSizeDefault: 24,
  maxItemsPerResponse: 48,
  /** A refined Discover reads one ranked shortlist of this many rows instead of paging. */
  shortlistSize: 48,
  maxExcludedIds: 100,
  runtimeMin: 1,
  runtimeMax: 1_200,
  yearMin: 1870,
  yearMax: 2200,
  maxUpstreamBytes: 512_000,
  timeoutMsMin: 1_000,
  timeoutMsMax: 15_000,
  timeoutMsDefault: 6_000,
} as const;

/** Catalogue records are namespaced so they can never collide with generated Jam artifacts. */
export const CATALOGUE_ID_PREFIX = "cat:";

export const availabilityKinds = ["stream", "rent", "buy", "free"] as const;

/** Only absolute https URLs are renderable; every other scheme is dropped, never rendered. */
const httpsUrl = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Only absolute https URLs are allowed.");

export const catalogueAvailabilitySchema = z.object({
  provider: z.string().trim().min(1).max(80),
  kind: z.enum(availabilityKinds),
  url: httpsUrl.optional(),
});

export const catalogueTitleSchema = z.object({
  id: z.string().min(1).max(160),
  title: z.string().trim().min(1).max(240),
  year: z.number().int().min(1870).max(2200).optional(),
  synopsis: z.string().trim().max(1_200).optional(),
  genres: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  runtimeMinutes: z.number().int().min(1).max(1_200).optional(),
  /** ISO 639 code of the original language, when the record states one. */
  originalLanguage: z.string().regex(/^[a-z]{2,3}$/).optional(),
  rating: z.string().trim().max(24).optional(),
  posterUrl: httpsUrl.optional(),
  backdropUrl: httpsUrl.optional(),
  attribution: z.string().trim().max(240).optional(),
  availability: z.array(catalogueAvailabilitySchema).max(12).default([]),
});

/** An OpenSubtitles language code: ISO 639 with an optional region, e.g. "en", "pt-BR". */
export const subtitleLanguageCode = z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/);

/**
 * The full record behind a film's own page. It extends the list title with the fields only that
 * page shows. Every one is optional: a record that does not state a value simply lacks the key.
 */
export const catalogueTitleDetailSchema = catalogueTitleSchema.extend({
  originalTitle: z.string().trim().min(1).max(240).optional(),
  tagline: z.string().trim().min(1).max(400).optional(),
  /** ISO date (YYYY-MM-DD) of the release, when the record states one. */
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** TMDB audience score out of 10, present only when at least one vote stands behind it. */
  voteAverage: z.number().gt(0).max(10).optional(),
  voteCount: z.number().int().positive().optional(),
  spokenLanguages: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  keywords: z.array(z.string().trim().min(1).max(80)).max(60).default([]),
  imdbId: z.string().regex(/^tt\d{5,10}$/).optional(),
  /**
   * Subtitle availability, as metadata only. Absent: never checked. Present with no languages:
   * checked, none found. Never carries subtitle text.
   */
  subtitles: z
    .object({
      languages: z.array(subtitleLanguageCode).max(200),
      count: z.number().int().min(0),
      checkedAt: z.string().datetime({ offset: true }),
    })
    .refine(({ languages, count }) => (languages.length === 0) === (count === 0))
    .optional(),
  /** Absent: unknown, which is its own state and never read as "no". */
  audioDescription: z
    .object({
      available: z.boolean(),
      source: z.string().trim().min(1).max(240),
    })
    .optional(),
});

/** A provider id as it appears in a film's URL: a positive integer, no sign, no leading zero. */
export const catalogueProviderIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,11}$/)
  .transform(Number)
  .refine(Number.isSafeInteger);

export const catalogueTitleOkSchema = z.object({
  status: z.literal("ok"),
  source: z.literal("tmdb"),
  title: catalogueTitleDetailSchema,
  attribution: z.string().optional(),
});

export const catalogueTitleNotFoundSchema = z.object({
  status: z.literal("not_found"),
  code: z.literal("CATALOGUE_TITLE_NOT_FOUND"),
  safeMessage: z.string(),
});

const GENRE_SLUGS = GENRES.map(({ slug }) => slug) as [GenreSlug, ...GenreSlug[]];
const genreSlugListSchema = z.array(z.enum(GENRE_SLUGS)).min(1).max(GENRES.length);
const runtimeBoundSchema = z.coerce.number().int().min(CATALOGUE_LIMITS.runtimeMin).max(CATALOGUE_LIMITS.runtimeMax);
const yearBoundSchema = z.coerce.number().int().min(CATALOGUE_LIMITS.yearMin).max(CATALOGUE_LIMITS.yearMax);

/**
 * Hard limits Discover pushes into the catalogue query so rows that could never be shown are
 * filtered in the database. Bounds are inclusive. `includeGenres` restricts the shortlist to
 * titles carrying at least one wanted genre; `excludeIds` are provider ids the viewer turned down.
 */
export const catalogueFiltersSchema = z.object({
  minRuntime: runtimeBoundSchema.optional(),
  maxRuntime: runtimeBoundSchema.optional(),
  minYear: yearBoundSchema.optional(),
  maxYear: yearBoundSchema.optional(),
  includeGenres: genreSlugListSchema.optional(),
  excludeGenres: genreSlugListSchema.optional(),
  excludeIds: z.array(z.coerce.number().int().positive()).min(1).max(CATALOGUE_LIMITS.maxExcludedIds).optional(),
});

export const catalogueQuerySchema = catalogueFiltersSchema.extend({
  query: z.string().trim().max(CATALOGUE_LIMITS.queryMaxLength).default(""),
  page: z.coerce
    .number()
    .int()
    .min(CATALOGUE_LIMITS.pageMin)
    .max(CATALOGUE_LIMITS.pageMax)
    .default(CATALOGUE_LIMITS.pageMin),
  pageSize: z.coerce
    .number()
    .int()
    .min(CATALOGUE_LIMITS.pageSizeMin)
    .max(CATALOGUE_LIMITS.pageSizeMax)
    .default(CATALOGUE_LIMITS.pageSizeDefault),
});

export const catalogueOkSchema = z.object({
  status: z.literal("ok"),
  /** Where the records come from. The catalogue is a curated TMDB snapshot; there is no Titan API. */
  source: z.literal("tmdb"),
  items: z.array(catalogueTitleSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  attribution: z.string().optional(),
});

export const catalogueNotConfiguredSchema = z.object({
  status: z.literal("catalogue_not_configured"),
  code: z.literal("CATALOGUE_NOT_CONFIGURED"),
  safeMessage: z.string(),
  missing: z.array(z.string()),
});

export const catalogueErrorSchema = z.object({
  status: z.literal("error"),
  code: z.string(),
  safeMessage: z.string(),
  retryable: z.boolean(),
});

export const catalogueResponseSchema = z.discriminatedUnion("status", [
  catalogueOkSchema,
  catalogueNotConfiguredSchema,
  catalogueErrorSchema,
]);

export const catalogueTitleResponseSchema = z.discriminatedUnion("status", [
  catalogueTitleOkSchema,
  catalogueTitleNotFoundSchema,
  catalogueNotConfiguredSchema,
  catalogueErrorSchema,
]);

export type CatalogueAvailability = z.infer<typeof catalogueAvailabilitySchema>;
export type CatalogueTitle = z.infer<typeof catalogueTitleSchema>;
export type CatalogueQuery = z.infer<typeof catalogueQuerySchema>;
export type CatalogueFilters = z.infer<typeof catalogueFiltersSchema>;
export type CatalogueOk = z.infer<typeof catalogueOkSchema>;
export type CatalogueNotConfigured = z.infer<typeof catalogueNotConfiguredSchema>;
export type CatalogueError = z.infer<typeof catalogueErrorSchema>;
export type CatalogueResponse = z.infer<typeof catalogueResponseSchema>;
export type CatalogueTitleDetail = z.infer<typeof catalogueTitleDetailSchema>;
export type CatalogueTitleOk = z.infer<typeof catalogueTitleOkSchema>;
export type CatalogueTitleNotFound = z.infer<typeof catalogueTitleNotFoundSchema>;
export type CatalogueTitleResponse = z.infer<typeof catalogueTitleResponseSchema>;

export function namespaceCatalogueId(providerId: string) {
  return providerId.startsWith(CATALOGUE_ID_PREFIX) ? providerId : `${CATALOGUE_ID_PREFIX}${providerId}`;
}

export function isCatalogueId(id: string) {
  return id.startsWith(CATALOGUE_ID_PREFIX);
}

/** The provider id inside a namespaced catalogue id, the form a film's URL carries. */
export function providerIdOf(id: string) {
  return id.startsWith(CATALOGUE_ID_PREFIX) ? id.slice(CATALOGUE_ID_PREFIX.length) : id;
}

const FILTER_SCALARS = ["minRuntime", "maxRuntime", "minYear", "maxYear"] as const;
const FILTER_LISTS = ["includeGenres", "excludeGenres", "excludeIds"] as const;

/** Writes filters as URL parameters; lists are comma-separated and absent filters are omitted. */
export function writeCatalogueFilters(params: URLSearchParams, filters: CatalogueFilters): void {
  for (const name of FILTER_SCALARS) {
    const value = filters[name];
    if (value !== undefined) params.set(name, String(value));
  }
  for (const name of FILTER_LISTS) {
    const values = filters[name];
    if (values && values.length > 0) params.set(name, values.join(","));
  }
}

/** The raw, unvalidated form of the filters in `params`, ready for `catalogueQuerySchema`. */
export function readCatalogueFilters(params: URLSearchParams): Record<string, string | string[]> {
  const raw: Record<string, string | string[]> = {};
  for (const name of FILTER_SCALARS) {
    const value = params.get(name);
    if (value !== null) raw[name] = value;
  }
  for (const name of FILTER_LISTS) {
    const value = params.get(name);
    if (value !== null) raw[name] = value.split(",");
  }
  return raw;
}
