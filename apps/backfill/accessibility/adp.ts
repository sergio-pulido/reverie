import { pacedGet, type PacedFetchOptions } from "./pacing";

/**
 * Audio-description availability from the Audio Description Project's Film and Series Title
 * Directory (American Council of the Blind), read 2026-09-19.
 *
 * What exists: no API and no export. The directory is a public, server-rendered HTML table at
 * /adp-search, 50 rows a page, newest first. "Movies Only" (`type_1=1`) gave 202 pages. Each
 * row names the title, year, type, providers with AD, and links to the title's IMDb page, so
 * it joins the catalogue on imdb_id with no fuzzy title matching. robots.txt does not exclude
 * /adp-search.
 *
 * What it can say: the page lists "films and series currently available with audio
 * description". A listed film is a sourced yes. An unlisted film is NOT a no: the directory
 * is curated and US-centred, so absence is unknown. This reader therefore only ever yields
 * yes; the backfill never writes false from it.
 *
 * Politeness: one page every 3 seconds, a named User-Agent, one pass (~10 minutes).
 */

export const ADP_DIRECTORY = "https://adp.acb.org/adp-search";
export const ADP_USER_AGENT = "Reverie/0.1 catalogue accessibility backfill (HackBarna 2026)";
export const ADP_MIN_INTERVAL_MS = 3_000;
export const ADP_SOURCE = "Audio Description Project directory (adp.acb.org)";
/** Pages past this are refused, so a changed page count cannot turn into an unbounded crawl. */
export const ADP_MAX_PAGES = 600;

export type AdpEntry = { imdbId: string; providers: string[] };
export type AdpPage = { entries: AdpEntry[]; lastPage: number | null };

/** Page 0 is the first page; the site's own `page` parameter is zero-based. */
export function adpPageUrl(page: number) {
  return page === 0 ? `${ADP_DIRECTORY}?type_1=1` : `${ADP_DIRECTORY}?type_1=1&page=${page}`;
}

const ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
const IMDB_CELL = /headers="view-field-imdb-reference-table-column"[^>]*>[\s\S]*?imdb\.com\/title\/(tt\d{5,10})/;
const PROVIDER_CELL = /headers="view-nothing-table-column"[^>]*>([\s\S]*?)<\/td>/;
const ANCHOR_TEXT = /<a\b[^>]*>([\s\S]*?)<\/a>/g;
const PAGE_LINK = /href="\?[^"]*?\bpage=(\d+)"/g;

/** Rows as data: an IMDb id and the provider names, never markup. Rows without an IMDb link are left out. */
export function parseAdpPage(html: string): AdpPage {
  const entries: AdpEntry[] = [];
  for (const [, row] of html.matchAll(ROW)) {
    const imdbId = IMDB_CELL.exec(row)?.[1];
    if (!imdbId) continue;
    const providerCell = PROVIDER_CELL.exec(row)?.[1] ?? "";
    const providers = [...providerCell.matchAll(ANCHOR_TEXT)].map(([, text]) => providerName(text)).filter(Boolean);
    entries.push({ imdbId, providers: [...new Set(providers)] });
  }
  const pages = [...html.matchAll(PAGE_LINK)].map(([, page]) => Number(page));
  return { entries, lastPage: pages.length > 0 ? Math.max(...pages) : null };
}

/** "Prime Video2" → "Prime Video": the directory numbers repeat links to one provider. */
function providerName(anchorText: string) {
  const text = decodeEntities(anchorText.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  return text.replace(/\d+$/, "").trim().slice(0, 40);
}

function decodeEntities(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export async function fetchAdpPage(page: number, options: PacedFetchOptions): Promise<AdpPage> {
  if (!Number.isInteger(page) || page < 0 || page > ADP_MAX_PAGES) throw new Error(`page ${page} is out of range`);
  const response = await pacedGet(adpPageUrl(page), { Accept: "text/html", "User-Agent": ADP_USER_AGENT }, options);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  return parseAdpPage(await response.text());
}

/** The source line stored with a yes: the directory, and the providers it names. */
export function adpSourceLine(providers: string[]) {
  const named = providers.length > 0 ? `: ${providers.join(", ")}` : "";
  return `${ADP_SOURCE}${named}`.slice(0, 240);
}
