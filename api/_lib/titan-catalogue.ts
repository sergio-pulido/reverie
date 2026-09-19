import { z } from "zod";
import {
  availabilityKinds,
  CATALOGUE_LIMITS,
  catalogueTitleSchema,
  namespaceCatalogueId,
  type CatalogueError,
  type CatalogueNotConfigured,
  type CatalogueOk,
  type CatalogueQuery,
  type CatalogueResponse,
  type CatalogueTitle,
} from "../../src/catalogue/contract";

/**
 * Server-side adapter for the authorized Titan catalogue endpoint.
 *
 * The endpoint is operator-supplied. This module never derives, guesses or hardcodes a
 * provider URL, and never returns catalogue records that the upstream did not send.
 * Credentials, the upstream URL and upstream bodies never reach a caller or a log line.
 */

export type TitanConfig = {
  catalogueUrl: string;
  apiKey: string;
  timeoutMs: number;
};

export type TitanConfigResult =
  | { configured: true; config: TitanConfig }
  | { configured: false; missing: string[] };

const environmentSchema = z.object({
  TITAN_CATALOGUE_URL: z.string().trim().min(1).optional(),
  TITAN_API_KEY: z.string().trim().min(1).optional(),
  TITAN_CATALOGUE_TIMEOUT_MS: z.string().trim().optional(),
});

/** Upstream response contract. Documented in docs/specs/discover-titan-catalogue.md. */
const upstreamItemSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    year: z.number().optional(),
    synopsis: z.string().optional(),
    genres: z.array(z.string()).optional(),
    runtimeMinutes: z.number().optional(),
    rating: z.string().optional(),
    posterUrl: z.string().optional(),
    backdropUrl: z.string().optional(),
    attribution: z.string().optional(),
    availability: z
      .array(z.object({ provider: z.string(), kind: z.string(), url: z.string().optional() }))
      .optional(),
  })
  .loose();

const upstreamResponseSchema = z.object({
  items: z.array(z.unknown()).max(CATALOGUE_LIMITS.maxItemsPerResponse * 4),
  total: z.number().int().nonnegative().optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
  attribution: z.string().optional(),
});

export function readTitanConfig(environment: NodeJS.ProcessEnv = process.env): TitanConfigResult {
  const parsed = environmentSchema.safeParse(environment);
  const values = parsed.success ? parsed.data : {};
  const missing: string[] = [];

  const catalogueUrl = values.TITAN_CATALOGUE_URL;
  const apiKey = values.TITAN_API_KEY;
  if (!catalogueUrl || !isAbsoluteHttpsUrl(catalogueUrl)) missing.push("TITAN_CATALOGUE_URL");
  if (!apiKey) missing.push("TITAN_API_KEY");
  if (missing.length > 0 || !catalogueUrl || !apiKey) return { configured: false, missing };

  return {
    configured: true,
    config: { catalogueUrl, apiKey, timeoutMs: readTimeout(values.TITAN_CATALOGUE_TIMEOUT_MS) },
  };
}

function readTimeout(raw: string | undefined) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return CATALOGUE_LIMITS.timeoutMsDefault;
  return Math.min(Math.max(Math.trunc(parsed), CATALOGUE_LIMITS.timeoutMsMin), CATALOGUE_LIMITS.timeoutMsMax);
}

function isAbsoluteHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function notConfiguredResponse(missing: string[]): CatalogueNotConfigured {
  return {
    status: "catalogue_not_configured",
    code: "CATALOGUE_NOT_CONFIGURED",
    safeMessage:
      "The authorized catalogue is not configured, so Reverie has no real titles to show. No catalogue data is invented.",
    missing,
  };
}

function errorResponse(code: string, safeMessage: string, retryable: boolean): CatalogueError {
  return { status: "error", code, safeMessage, retryable };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type CatalogueAdapterOptions = {
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: FetchLike;
};

export async function fetchCatalogue(
  query: CatalogueQuery,
  options: CatalogueAdapterOptions = {},
): Promise<CatalogueResponse> {
  const configResult = readTitanConfig(options.environment ?? process.env);
  if (!configResult.configured) return notConfiguredResponse(configResult.missing);

  const { config } = configResult;
  const doFetch = options.fetchImplementation ?? (globalThis.fetch as FetchLike);
  const requestUrl = buildUpstreamUrl(config.catalogueUrl, query);

  let response: Response;
  try {
    response = await doFetch(requestUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return timedOut
      ? errorResponse("CATALOGUE_TIMEOUT", "The catalogue did not answer in time.", true)
      : errorResponse("CATALOGUE_UNREACHABLE", "The catalogue could not be reached.", true);
  }

  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429;
    const code =
      response.status === 401 || response.status === 403
        ? "CATALOGUE_UNAUTHORIZED"
        : response.status === 429
          ? "CATALOGUE_RATE_LIMITED"
          : retryable
            ? "CATALOGUE_UPSTREAM_ERROR"
            : "CATALOGUE_REQUEST_REJECTED";
    return errorResponse(code, "The catalogue rejected this request.", retryable);
  }

  let rawBody: string;
  try {
    rawBody = await readBoundedText(response, CATALOGUE_LIMITS.maxUpstreamBytes);
  } catch {
    return errorResponse("CATALOGUE_RESPONSE_TOO_LARGE", "The catalogue response was too large to read.", false);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return errorResponse("CATALOGUE_INVALID_RESPONSE", "The catalogue returned an unreadable response.", false);
  }

  const upstream = upstreamResponseSchema.safeParse(parsedJson);
  if (!upstream.success) {
    return errorResponse("CATALOGUE_INVALID_RESPONSE", "The catalogue response did not match the agreed contract.", false);
  }

  const items = normalizeItems(upstream.data.items, query.pageSize);
  const total = upstream.data.total ?? items.length;
  const ok: CatalogueOk = {
    status: "ok",
    source: "titan",
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    hasMore: query.page * query.pageSize < total,
    attribution: upstream.data.attribution,
  };
  return ok;
}

function buildUpstreamUrl(baseUrl: string, query: CatalogueQuery) {
  const url = new URL(baseUrl);
  url.searchParams.set("query", query.query);
  url.searchParams.set("page", String(query.page));
  url.searchParams.set("pageSize", String(query.pageSize));
  return url.toString();
}

/**
 * Validates every upstream record on its own. A record that cannot be trusted is dropped and
 * an untrusted URL is stripped, so a partially valid title is never rendered as if complete.
 */
function normalizeItems(rawItems: unknown[], pageSize: number) {
  const limit = Math.min(pageSize, CATALOGUE_LIMITS.maxItemsPerResponse);
  const normalized: CatalogueTitle[] = [];

  for (const rawItem of rawItems) {
    if (normalized.length >= limit) break;
    const upstreamItem = upstreamItemSchema.safeParse(rawItem);
    if (!upstreamItem.success) continue;
    const raw = upstreamItem.data;

    const candidate = catalogueTitleSchema.safeParse({
      ...raw,
      id: namespaceCatalogueId(String(raw.id)),
      genres: raw.genres ?? [],
      posterUrl: safeHttpsUrl(raw.posterUrl),
      backdropUrl: safeHttpsUrl(raw.backdropUrl),
      availability: (raw.availability ?? [])
        .filter((entry) => (availabilityKinds as readonly string[]).includes(entry.kind))
        .map((entry) => ({ ...entry, url: safeHttpsUrl(entry.url) })),
    });
    if (candidate.success) normalized.push(candidate.data);
  }

  return normalized;
}

function safeHttpsUrl(value: string | undefined) {
  return value && isAbsoluteHttpsUrl(value) ? value : undefined;
}

async function readBoundedText(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("too-large");

  const body = response.body;
  if (!body) return await response.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) throw new Error("too-large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
