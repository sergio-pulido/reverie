// Offline backfill of subtitle and audio-description availability. Never runs during a request:
// nothing under api/ or src/ imports it (a test enforces that).
//
//   pnpm backfill:accessibility subtitles [--limit N]   OpenSubtitles /features, 1 request per film
//   pnpm backfill:accessibility audio-description        Audio Description Project directory
//   pnpm backfill:accessibility sql [--out FILE]         ledgers → SQL upserts for Sergio to apply
//
// Both checks are resumable: every answer is appended to a ledger under .backfill/ the moment
// it is known, and a rerun asks only about what has no answer yet. Skips are logged with why.
// It prints counts and reasons, never keys.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ADP_MAX_PAGES, ADP_MIN_INTERVAL_MS, fetchAdpPage } from "./accessibility/adp";
import { adpPageLineSchema, appendLedger, latestSubtitleAnswers, readLedger, subtitleLineSchema } from "./accessibility/ledger";
import { checkSubtitles, imdbNumber, OPENSUBTITLES_MIN_INTERVAL_MS } from "./accessibility/opensubtitles";
import { createPacer, FatalProviderError } from "./accessibility/pacing";
import { audioDescriptionUpserts, audioDescriptionYeses, sqlFile, subtitleUpserts, type CatalogueRef } from "./accessibility/sql";

const DIR = join(process.cwd(), ".backfill", "accessibility");
const CATALOGUE_CACHE = join(DIR, "catalogue.json");
const SUBTITLE_LEDGER = join(DIR, "subtitles.jsonl");
const ADP_LEDGER = join(DIR, "adp-pages.jsonl");
const CATALOGUE_PAGE = 1_000;

type CatalogueRow = { titleId: number; imdbId: string | null };
const catalogueCacheSchema = z.array(z.object({ titleId: z.number().int().positive(), imdbId: z.string().nullable() }));

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Catalogue ids and IMDb ids, most popular first, read once as an anonymous viewer and cached. */
async function readCatalogue(): Promise<CatalogueRow[]> {
  if (existsSync(CATALOGUE_CACHE) && !process.argv.includes("--refresh-catalogue")) {
    return catalogueCacheSchema.parse(JSON.parse(readFileSync(CATALOGUE_CACHE, "utf8")));
  }
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Set SUPABASE_URL and SUPABASE_ANON_KEY to read the catalogue.");
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInAnonymously();
  if (signInError) throw new Error(`Anonymous sign-in failed: ${signInError.message}`);

  const rows: CatalogueRow[] = [];
  for (let from = 0; ; from += CATALOGUE_PAGE) {
    const { data, error } = await client
      .from("catalogue_titles")
      .select("id, imdb_id")
      .order("popularity", { ascending: false, nullsFirst: false })
      .order("id")
      .range(from, from + CATALOGUE_PAGE - 1);
    if (error) throw new Error(`Catalogue read failed: ${error.message}`);
    rows.push(...data.map((row) => ({ titleId: Number(row.id), imdbId: typeof row.imdb_id === "string" ? row.imdb_id.trim() : null })));
    if (data.length < CATALOGUE_PAGE) break;
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CATALOGUE_CACHE, JSON.stringify(rows));
  return rows;
}

function tally(reasons: Map<string, number>, reason: string) {
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}

function printTally(title: string, reasons: Map<string, number>) {
  if (reasons.size === 0) return;
  console.log(title);
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(6)}  ${reason}`);
}

async function backfillSubtitles() {
  const apiKey = process.env.OPENSUBTITLES_API_KEY?.trim();
  if (!apiKey) throw new Error("Set OPENSUBTITLES_API_KEY (an opensubtitles.com API consumer key) in .env.local.");
  const limit = Number(flag("--limit") ?? Number.POSITIVE_INFINITY);

  const catalogue = await readCatalogue();
  const answered = latestSubtitleAnswers(readLedger(SUBTITLE_LEDGER, subtitleLineSchema));
  const pace = createPacer(OPENSUBTITLES_MIN_INTERVAL_MS);
  const skipped = new Map<string, number>();
  let asked = 0;
  let found = 0;

  for (const { titleId, imdbId } of catalogue) {
    if (answered.has(titleId)) continue;
    const imdb = imdbNumber(imdbId);
    if (imdb === null) {
      tally(skipped, imdbId ? "imdb_id is not a title id" : "no imdb_id: cannot be checked");
      continue;
    }
    if (asked >= limit) break;
    asked += 1;
    const answer = await checkSubtitles(imdb, apiKey, { pace });
    const at = new Date().toISOString();
    if (answer.outcome === "checked") {
      appendLedger(SUBTITLE_LEDGER, { outcome: "checked", titleId, imdbId, languages: answer.languages, count: answer.count, checkedAt: at });
      if (answer.count > 0) found += 1;
    } else {
      appendLedger(SUBTITLE_LEDGER, { outcome: "skipped", titleId, imdbId, reason: answer.reason, at });
      tally(skipped, answer.reason);
    }
    if (asked % 100 === 0) console.log(`  … ${asked} asked`);
  }

  console.log(`Subtitles: ${answered.size} already answered, ${asked} asked now, ${found} with subtitles.`);
  printTally("Skipped, by reason:", skipped);
}

async function backfillAudioDescription() {
  const done = new Map(readLedger(ADP_LEDGER, adpPageLineSchema).map((line) => [line.page, line]));
  const pace = createPacer(ADP_MIN_INTERVAL_MS);
  let lastPage = done.get(0)?.lastPage ?? null;
  const failures = new Map<string, number>();

  for (let page = 0; page <= (lastPage ?? 0) && page <= ADP_MAX_PAGES; page += 1) {
    if (done.has(page)) continue;
    try {
      const result = await fetchAdpPage(page, { pace });
      if (page === 0) lastPage = result.lastPage;
      appendLedger(ADP_LEDGER, { page, fetchedAt: new Date().toISOString(), lastPage: result.lastPage, entries: result.entries });
      if (page % 20 === 0) console.log(`  … page ${page} of ${lastPage ?? "?"}: ${result.entries.length} films`);
    } catch (error) {
      if (error instanceof FatalProviderError) throw error;
      tally(failures, `page ${page}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  const pages = readLedger(ADP_LEDGER, adpPageLineSchema);
  const films = new Set(pages.flatMap((line) => line.entries.map((entry) => entry.imdbId)));
  console.log(`Audio description: ${pages.length} of ${(lastPage ?? 0) + 1} directory pages read, ${films.size} distinct IMDb ids listed.`);
  printTally("Pages skipped, retried next run:", failures);
}

async function emitSql() {
  const out = flag("--out") ?? join(DIR, "accessibility-upserts.sql");
  const catalogue = await readCatalogue();
  const refs: CatalogueRef[] = catalogue.flatMap((row) => (row.imdbId ? [{ titleId: row.titleId, imdbId: row.imdbId }] : []));
  const subtitles = [...latestSubtitleAnswers(readLedger(SUBTITLE_LEDGER, subtitleLineSchema)).values()];
  const yeses = audioDescriptionYeses(readLedger(ADP_LEDGER, adpPageLineSchema), refs);
  const statements = [...subtitleUpserts(subtitles), ...audioDescriptionUpserts(yeses)];
  writeFileSync(out, sqlFile(statements, `${subtitles.length} subtitle answers, ${yeses.length} audio-description yeses`));
  console.log(`Wrote ${out}: ${subtitles.length} subtitle answers, ${yeses.length} audio-description yeses of ${catalogue.length} films.`);
}

const commands: Record<string, () => Promise<void>> = {
  subtitles: backfillSubtitles,
  "audio-description": backfillAudioDescription,
  sql: emitSql,
};

const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error("Usage: backfill:accessibility <subtitles [--limit N] | audio-description | sql [--out FILE]> [--refresh-catalogue]");
  process.exit(2);
}
command().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Backfill failed.");
  process.exit(1);
});
