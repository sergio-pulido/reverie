import { z } from "zod";

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
  rating: z.string().trim().max(24).optional(),
  posterUrl: httpsUrl.optional(),
  backdropUrl: httpsUrl.optional(),
  attribution: z.string().trim().max(240).optional(),
  availability: z.array(catalogueAvailabilitySchema).max(12).default([]),
});

export const catalogueQuerySchema = z.object({
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
  source: z.literal("titan"),
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

export type CatalogueAvailability = z.infer<typeof catalogueAvailabilitySchema>;
export type CatalogueTitle = z.infer<typeof catalogueTitleSchema>;
export type CatalogueQuery = z.infer<typeof catalogueQuerySchema>;
export type CatalogueOk = z.infer<typeof catalogueOkSchema>;
export type CatalogueNotConfigured = z.infer<typeof catalogueNotConfiguredSchema>;
export type CatalogueError = z.infer<typeof catalogueErrorSchema>;
export type CatalogueResponse = z.infer<typeof catalogueResponseSchema>;

export function namespaceCatalogueId(providerId: string) {
  return providerId.startsWith(CATALOGUE_ID_PREFIX) ? providerId : `${CATALOGUE_ID_PREFIX}${providerId}`;
}

export function isCatalogueId(id: string) {
  return id.startsWith(CATALOGUE_ID_PREFIX);
}
