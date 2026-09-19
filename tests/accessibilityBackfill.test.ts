import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adpPageUrl, adpSourceLine, parseAdpPage } from "../apps/backfill/accessibility/adp";
import { appendLedger, latestSubtitleAnswers, readLedger, subtitleLineSchema } from "../apps/backfill/accessibility/ledger";
import {
  checkSubtitles,
  featuresUrl,
  imdbNumber,
  OPENSUBTITLES_MIN_INTERVAL_MS,
  subtitleAnswerFrom,
} from "../apps/backfill/accessibility/opensubtitles";
import { createPacer, FatalProviderError, pacedGet, retryDelayMs, type Clock } from "../apps/backfill/accessibility/pacing";
import { audioDescriptionUpserts, audioDescriptionYeses, sqlLiteral, subtitleUpserts } from "../apps/backfill/accessibility/sql";

function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return { clock, sleeps };
}

// ---------- OpenSubtitles ----------

test("IMDb ids lose the tt and leading zeroes; anything else has no number", () => {
  assert.equal(imdbNumber("tt0133093"), 133093);
  assert.equal(imdbNumber(" tt1375666 "), 1375666);
  assert.equal(imdbNumber(null), null);
  assert.equal(imdbNumber(""), null);
  assert.equal(imdbNumber("0133093"), null);
  assert.equal(imdbNumber("tt12"), null);
});

test("the client builds only the /features URL, sorted and lowercase, so it cannot download", () => {
  assert.equal(featuresUrl(133093), "https://api.opensubtitles.com/api/v1/features?imdb_id=133093");
  assert.ok(OPENSUBTITLES_MIN_INTERVAL_MS >= 250, "no more than 4 requests a second (40 per 10 s on /features)");
  const source = readFileSync("apps/backfill/accessibility/opensubtitles.ts", "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
  assert.equal(/\/download|\/subtitles\?|\/login/.test(source), false, "no download, search-paging or login call exists");
});

const matrixFeatures = {
  data: [
    {
      id: "646193",
      type: "feature",
      attributes: {
        title: "The Matrix",
        feature_type: "Movie",
        imdb_id: 133093,
        subtitles_counts: { en: 120, es: 60, "pt-BR": 20, ea: 9, fr: 0, "<b>": 3 },
      },
    },
    { id: "1", type: "feature", attributes: { title: "The Matrix Reloaded", feature_type: "Movie", imdb_id: 234215, subtitles_counts: { de: 5 } } },
  ],
};

test("a film's languages and count come from its own feature, ignoring junk and zero counts", () => {
  assert.deepEqual(subtitleAnswerFrom(matrixFeatures, 133093), { outcome: "checked", languages: ["ea", "en", "es", "pt-BR"], count: 209 });
});

test("no feature at all is a real answer: checked, none found", () => {
  assert.deepEqual(subtitleAnswerFrom({ data: [] }, 133093), { outcome: "checked", languages: [], count: 0 });
});

test("a response that is not about this film, or unreadable, is skipped with a reason, not answered", () => {
  assert.equal(subtitleAnswerFrom(matrixFeatures, 999999).outcome, "skipped");
  assert.equal(subtitleAnswerFrom({ errors: ["nope"] }, 133093).outcome, "skipped");
  const show = { data: [{ attributes: { imdb_id: 133093, feature_type: "Tvshow", subtitles_counts: { en: 1 } } }] };
  assert.deepEqual(subtitleAnswerFrom(show, 133093), { outcome: "skipped", reason: "feature is a Tvshow, not a movie" });
  const bare = { data: [{ attributes: { imdb_id: 133093, feature_type: "Movie" } }] };
  assert.equal(subtitleAnswerFrom(bare, 133093).outcome, "skipped");
});

test("every request carries the key and a named User-Agent", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    return Response.json(matrixFeatures);
  }) as unknown as typeof fetch;
  const answer = await checkSubtitles(133093, "consumer-key", { pace: async () => {}, fetchImpl });
  assert.equal(answer.outcome, "checked");
  assert.equal(seen[0].url, featuresUrl(133093));
  assert.equal(seen[0].headers["Api-Key"], "consumer-key");
  assert.match(seen[0].headers["User-Agent"], /^Reverie v\d+\.\d+\.\d+$/);
});

test("a refused key stops the run; a server error becomes a logged skip", async () => {
  const refused = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(checkSubtitles(1, "bad", { pace: async () => {}, fetchImpl: refused }), FatalProviderError);
  const { clock } = fakeClock();
  const failing = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
  const answer = await checkSubtitles(1, "key", { pace: async () => {}, fetchImpl: failing, clock, maxAttempts: 2 });
  assert.equal(answer.outcome, "skipped");
});

// ---------- pacing ----------

test("the pacer never starts two requests closer than its interval", async () => {
  const { clock, sleeps } = fakeClock();
  const pace = createPacer(400, clock);
  await pace();
  await pace();
  await pace();
  assert.deepEqual(sleeps, [400, 400]);
});

test("a 429 waits what the provider asks, then retries", async () => {
  const { clock, sleeps } = fakeClock();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return calls === 1 ? new Response("{}", { status: 429, headers: { "ratelimit-reset": "1" } }) : Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const response = await pacedGet("https://example.test", {}, { pace: async () => {}, fetchImpl, clock });
  assert.equal(response.status, 200);
  assert.deepEqual(sleeps, [1_000]);
  assert.equal(retryDelayMs(new Headers(), 3), 16_000, "without a hint it backs off exponentially");
});

// ---------- Audio Description Project ----------

const ADP_HTML = `
<table><thead><tr><th>Title</th></tr></thead><tbody>
<tr>
  <td headers="view-title-table-column">War of the Worlds</td>
  <td class="priority-medium" headers="view-field-release-year-table-column">2005</td>
  <td class="priority-low" headers="view-type-table-column">Movie</td>
  <td headers="view-nothing-table-column"><a href="https://play.max.com/x" target="_blank">HBO Max</a>, <a href="https://www.primevideo.com/a">Prime Video1</a>, <a href="https://www.primevideo.com/b">Prime Video2</a></td>
  <td headers="view-field-imdb-reference-table-column"><a href="https://www.imdb.com/title/tt0407304" target="_BLANK">IMDb</a></td>
</tr>
<tr>
  <td headers="view-title-table-column">No Link Film</td>
  <td headers="view-nothing-table-column"><a href="https://x.example">DVD</a></td>
  <td headers="view-field-imdb-reference-table-column"></td>
</tr>
<tr>
  <td headers="view-title-table-column">Birdman</td>
  <td headers="view-nothing-table-column"><a href="https://x.example">Apple TV Store &amp; <script>x</script></a></td>
  <td headers="view-field-imdb-reference-table-column"><a href="https://www.imdb.com/title/tt2562232">IMDb</a></td>
</tr>
</tbody></table>
<nav><a href="?type_1=1&amp;page=1">2</a><a href="?type_1=1&amp;page=201">Last</a></nav>`;

test("directory rows become an IMDb id and provider names; rows without IMDb are left out", () => {
  const page = parseAdpPage(ADP_HTML);
  assert.deepEqual(page.entries, [
    { imdbId: "tt0407304", providers: ["HBO Max", "Prime Video"] },
    { imdbId: "tt2562232", providers: ["Apple TV Store & x"] },
  ]);
  assert.equal(page.lastPage, 201);
  assert.equal(adpPageUrl(0), "https://adp.acb.org/adp-search?type_1=1");
  assert.equal(adpPageUrl(3), "https://adp.acb.org/adp-search?type_1=1&page=3");
});

test("a listed film is a sourced yes; an unlisted film gets no row, never a false", () => {
  const pages = [{ page: 0, fetchedAt: "2026-09-19T19:00:00.000Z", lastPage: 1, entries: parseAdpPage(ADP_HTML).entries }];
  const catalogue = [
    { titleId: 74, imdbId: "tt0407304" },
    { titleId: 603, imdbId: "tt0133093" },
  ];
  const yeses = audioDescriptionYeses(pages, catalogue);
  assert.deepEqual(yeses, [
    { titleId: 74, source: adpSourceLine(["HBO Max", "Prime Video"]), checkedAt: "2026-09-19T19:00:00.000Z" },
  ]);
  const sql = audioDescriptionUpserts(yeses).join("\n");
  assert.match(sql, /\(74, true, 'Audio Description Project directory \(adp\.acb\.org\): HBO Max, Prime Video', '2026-09-19T19:00:00\.000Z'::timestamptz\)/);
  assert.equal(/\bfalse\b/.test(sql), false);
  assert.equal(/603/.test(sql), false);
});

// ---------- ledger and SQL ----------

test("the ledger resumes: checked titles are not asked again, a torn line is ignored, skips are retried", () => {
  const path = join(mkdtempSync(join(tmpdir(), "reverie-ledger-")), "subtitles.jsonl");
  appendLedger(path, { outcome: "checked", titleId: 603, imdbId: "tt0133093", languages: ["en"], count: 3, checkedAt: "2026-09-19T19:00:00Z" });
  appendLedger(path, { outcome: "skipped", titleId: 27205, imdbId: "tt1375666", reason: "HTTP 502", at: "2026-09-19T19:00:01Z" });
  writeFileSync(path, `${readFileSync(path, "utf8")}{"outcome":"checked","titleId":`, "utf8");
  const answers = latestSubtitleAnswers(readLedger(path, subtitleLineSchema));
  assert.deepEqual([...answers.keys()], [603]);
});

test("subtitle upserts carry validated values only and keep an empty answer distinct from none", () => {
  const sql = subtitleUpserts([
    { outcome: "checked", titleId: 603, imdbId: "tt0133093", languages: ["en", "pt-BR"], count: 140, checkedAt: "2026-09-19T19:00:00Z" },
    { outcome: "checked", titleId: 11, imdbId: "tt0076759", languages: [], count: 0, checkedAt: "2026-09-19T19:00:00Z" },
  ]).join("\n");
  assert.match(sql, /\(603, array\['en','pt-BR'\]::text\[\], 140, '2026-09-19T19:00:00\.000Z'::timestamptz, 'opensubtitles\.com'\)/);
  assert.match(sql, /\(11, array\[\]::text\[\], 0, /);
  assert.match(sql, /on conflict \(title_id\) do update set subtitle_languages = excluded\.subtitle_languages/);
  assert.equal(/has_audio_description/.test(sql), false, "a subtitle upsert never touches the audio-description answer");
  assert.throws(() =>
    subtitleUpserts([{ outcome: "checked", titleId: 1, imdbId: "tt1", languages: ["en'); drop table x; --"], count: 1, checkedAt: "2026-09-19T19:00:00Z" }]),
  );
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
});

// ---------- boundaries ----------

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("the backfill never runs during a request: nothing the app serves imports it", () => {
  for (const file of [...sourceFiles("api"), ...sourceFiles("src"), ...sourceFiles("apps/server")]) {
    assert.equal(/backfill/.test(readFileSync(file, "utf8")), false, file);
  }
});
