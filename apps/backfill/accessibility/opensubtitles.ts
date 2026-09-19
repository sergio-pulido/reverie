import { z } from "zod";
import { subtitleLanguageCode } from "../../../src/catalogue/contract";
import { pacedGet, type PacedFetchOptions } from "./pacing";

/**
 * Subtitle availability from the OpenSubtitles REST API, read as metadata only.
 *
 * Designed to the published rules (opensubtitles.stoplight.io, read 2026-09-19):
 * - Every request carries the consumer `Api-Key` and a named, versioned `User-Agent`.
 * - 5 requests per second per IP, and /features asks for no more than 40 per 10 seconds. The
 *   backfill spaces requests 400 ms apart: 2.5 per second, well inside both.
 * - Search and /features are not quota-limited; only /download is. This client can reach
 *   `/features` and nothing else, so it can never spend a download or fetch subtitle text.
 * - Parameters sorted, lowercase, IMDb id without "tt" or leading zeroes: no redirects.
 *
 * One /features call per film returns `subtitles_counts`, a per-language count, so a film's
 * languages cost one request however many subtitle files exist (paging /subtitles for The
 * Matrix would take 17).
 */

export const OPENSUBTITLES_API = "https://api.opensubtitles.com/api/v1";
export const OPENSUBTITLES_USER_AGENT = "Reverie v0.1.0";
export const OPENSUBTITLES_MIN_INTERVAL_MS = 400;
export const OPENSUBTITLES_SOURCE = "opensubtitles.com";

/** "tt0133093" → 133093; anything that is not an IMDb title id → null. */
export function imdbNumber(imdbId: string | null | undefined) {
  const match = /^tt(\d{5,10})$/.exec(imdbId?.trim() ?? "");
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The only URL this client builds. One parameter, so it is already sorted and lowercase. */
export function featuresUrl(imdb: number) {
  return `${OPENSUBTITLES_API}/features?imdb_id=${imdb}`;
}

const featureSchema = z.object({
  attributes: z.object({
    imdb_id: z.union([z.number(), z.string()]).nullable().optional(),
    feature_type: z.string().optional(),
    subtitles_counts: z.record(z.string(), z.number()).nullable().optional(),
  }),
});

const featuresResponseSchema = z.object({ data: z.array(z.unknown()) });

export type SubtitleAnswer =
  | { outcome: "checked"; languages: string[]; count: number }
  | { outcome: "skipped"; reason: string };

/**
 * Reads the film's own feature out of a /features response. No feature at all is a real
 * answer: OpenSubtitles has no subtitles for it. A response naming only other films, or one
 * that cannot be read, is not an answer and is skipped with its reason.
 */
export function subtitleAnswerFrom(body: unknown, imdb: number): SubtitleAnswer {
  const parsed = featuresResponseSchema.safeParse(body);
  if (!parsed.success) return { outcome: "skipped", reason: "unreadable /features response" };
  if (parsed.data.data.length === 0) return { outcome: "checked", languages: [], count: 0 };

  const own = parsed.data.data
    .map((item) => featureSchema.safeParse(item))
    .flatMap((result) => (result.success ? [result.data.attributes] : []))
    .find((feature) => Number(feature.imdb_id) === imdb);
  if (!own) return { outcome: "skipped", reason: "no feature with this IMDb id in the response" };
  if (own.feature_type && own.feature_type.toLowerCase() !== "movie") {
    return { outcome: "skipped", reason: `feature is a ${own.feature_type}, not a movie` };
  }
  if (!own.subtitles_counts) return { outcome: "skipped", reason: "feature carries no subtitles_counts" };

  const languages: string[] = [];
  let count = 0;
  for (const [code, perLanguage] of Object.entries(own.subtitles_counts)) {
    if (!Number.isInteger(perLanguage) || perLanguage <= 0) continue;
    if (!subtitleLanguageCode.safeParse(code).success) continue;
    languages.push(code);
    count += perLanguage;
  }
  return { outcome: "checked", languages: languages.sort(), count };
}

export async function checkSubtitles(
  imdb: number,
  apiKey: string,
  options: PacedFetchOptions,
): Promise<SubtitleAnswer> {
  let response: Response;
  try {
    response = await pacedGet(
      featuresUrl(imdb),
      { Accept: "application/json", "Api-Key": apiKey, "User-Agent": OPENSUBTITLES_USER_AGENT },
      options,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "FatalProviderError") throw error;
    return { outcome: "skipped", reason: error instanceof Error ? error.message : "request failed" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { outcome: "skipped", reason: `HTTP ${response.status}` };
  }
  try {
    return subtitleAnswerFrom(await response.json(), imdb);
  } catch {
    return { outcome: "skipped", reason: "response was not JSON" };
  }
}
