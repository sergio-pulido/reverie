import type { CatalogueFilters } from "../catalogue/contract";
import { genreLabel } from "../catalogue/domain";
import type { GenreSlug } from "../catalogue/genres";
import { spaced, wordsOf } from "./words";

/**
 * Preferences heard in words the viewer has not sent yet, for display while they speak: a chip
 * for each, and a row of posters previewed against them. Pure and deliberately literal: a word
 * list, not a model. Nothing here is a turn. It never reaches the assistant or the preference
 * engine, which only ever judge the final transcript the viewer sends.
 *
 * Only what the catalogue can filter by is detected: genres, a running-time limit and an era.
 */

export type Detected =
  | { key: string; kind: "genre"; genre: GenreSlug; refused: boolean; label: string }
  | { key: string; kind: "runtime"; underMinutes: number; label: string }
  | { key: string; kind: "era"; fromYear?: number; untilYear?: number; label: string };

/** Phrases that name a genre, as whole words. Words that are common in titles are left out. */
const GENRE_PHRASES: ReadonlyArray<readonly [GenreSlug, readonly string[]]> = [
  ["comedy", ["comedy", "comedies", "comedic", "funny", "hilarious", "laugh", "laughs", "laughing", "lighthearted", "light hearted", "rom com", "romcom"]],
  ["horror", ["horror", "horrors", "scary", "scare", "scares", "frightening", "terrifying", "spooky", "creepy", "slasher"]],
  ["thriller", ["thriller", "thrillers", "suspense", "suspenseful", "edge of my seat"]],
  ["action", ["action", "action packed", "explosions", "martial arts"]],
  ["romance", ["romance", "romances", "romantic", "love story", "love stories", "rom com", "romcom"]],
  ["drama", ["drama", "dramas", "dramatic", "tearjerker", "tear jerker"]],
  ["crime", ["crime", "heist", "heists", "gangster", "gangsters", "mafia"]],
  ["adventure", ["adventure", "adventures", "swashbuckling"]],
  ["family", ["family", "family friendly", "for the kids", "for kids", "kids film", "kids movie"]],
  ["science_fiction", ["sci fi", "scifi", "science fiction", "space", "futuristic", "time travel", "robots"]],
  ["fantasy", ["fantasy", "magic", "magical", "dragons", "wizards", "fairy tale"]],
  ["animation", ["animated", "animation", "cartoon", "cartoons", "anime"]],
  ["mystery", ["mystery", "mysteries", "whodunit", "whodunnit", "detective"]],
  ["history", ["historical", "history", "period piece"]],
  ["documentary", ["documentary", "documentaries", "docuseries"]],
  ["music", ["musical", "musicals", "concert film"]],
  ["war", ["war film", "war films", "war movie", "war movies", "wartime", "world war", "ww2", "wwii"]],
  ["western", ["western", "westerns", "cowboy", "cowboys"]],
];

/** A refusal: one of these within the three words before a genre turns it into "not that". */
const NEGATIONS: ReadonlySet<string> = new Set([
  "no", "not", "nothing", "without", "never", "don't", "dont", "doesn't", "isn't", "avoid", "except", "hate", "none",
]);
const NEGATION_REACH = 3;

const DECADE_WORDS: Readonly<Record<string, number>> = {
  twenties: 1920, thirties: 1930, forties: 1940, fifties: 1950, sixties: 1960, seventies: 1970,
  eighties: 1980, nineties: 1990, noughties: 2000,
};

const RECENT = ["recent", "newer", "latest", "modern", "new release", "new releases"];
const CLASSIC = ["classic", "classics", "old movie", "old movies", "old film", "old films", "older", "oldie", "oldies", "vintage", "black and white", "golden age"];
const SHORT = ["short", "quick", "shorter"];

const LIMIT = String.raw`(?:under|below|less than|shorter than|no longer than|no more than|at most|within|max|maximum)`;
const AMOUNT = String.raw`(an hour and a half|hour and a half|one and a half|two and a half|a hundred|hundred|ninety|an|a|one|two|three|\d+(?:\.\d+)?)`;
const UNIT = String.raw`(hours?|hrs?|h|minutes?|mins?|m)?`;
const RUNTIME_LIMIT = new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${LIMIT}\s+${AMOUNT}\s*${UNIT}(?=$|[^\p{L}\p{N}])`, "u");
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, ninety: 90, hundred: 100, "a hundred": 100,
  "hour and a half": 1.5, "an hour and a half": 1.5, "one and a half": 1.5, "two and a half": 2.5,
};

/** Where `phrase` appears in `words` as whole words (the first time, or the last), or -1. */
function phraseAt(words: readonly string[], phrase: string, which: "first" | "last" = "first"): number {
  const haystack = spaced(words);
  const at = which === "first" ? haystack.indexOf(` ${phrase} `) : haystack.lastIndexOf(` ${phrase} `);
  return at < 0 ? -1 : haystack.slice(0, at).split(" ").filter(Boolean).length;
}

function negated(words: readonly string[], at: number): boolean {
  return words.slice(Math.max(0, at - NEGATION_REACH), at).some((word) => NEGATIONS.has(word));
}

function detectGenres(words: readonly string[]): Detected[] {
  const found = new Map<GenreSlug, { at: number; refused: boolean }>();
  for (const [genre, phrases] of GENRE_PHRASES) {
    for (const phrase of phrases) {
      const at = phraseAt(words, phrase, "last");
      if (at < 0) continue;
      const refused = negated(words, at);
      // A later mention says what the viewer settled on.
      const earlier = found.get(genre);
      if (!earlier || at > earlier.at) found.set(genre, { at, refused });
    }
  }
  return [...found.entries()]
    .sort(([, a], [, b]) => a.at - b.at)
    .map(([genre, { refused }]) => ({
      key: `genre:${genre}`,
      kind: "genre",
      genre,
      refused,
      label: refused ? `No ${genreLabel(genre)}` : genreLabel(genre),
    }));
}

function detectRuntime(text: string, words: readonly string[]): Detected | null {
  const match = RUNTIME_LIMIT.exec(text.toLowerCase().replace(/[’‘]/g, "'"));
  let minutes: number | null = null;
  if (match) {
    const amount = Object.hasOwn(NUMBER_WORDS, match[1]) ? NUMBER_WORDS[match[1]] : Number(match[1]);
    const unit = match[2] ?? "";
    const inHours = unit.startsWith("h") || (!unit.startsWith("m") && amount <= 4);
    minutes = Math.round(inHours ? amount * 60 : amount);
  } else if (SHORT.some((phrase) => phraseAt(words, phrase) >= 0 && !negated(words, phraseAt(words, phrase)))) {
    minutes = 90;
  } else if (phraseAt(words, "not too long") >= 0) {
    minutes = 120;
  }
  if (minutes === null || !Number.isFinite(minutes) || minutes < 20 || minutes > 400) return null;
  return { key: `runtime:${minutes}`, kind: "runtime", underMinutes: minutes, label: `Under ${minutes} min` };
}

function decadeOf(word: string): number | null {
  if (Object.hasOwn(DECADE_WORDS, word)) return DECADE_WORDS[word];
  const twentieth = /^(?:19)?([2-9])0s$/.exec(word);
  if (twentieth) return 1900 + Number(twentieth[1]) * 10;
  const recent = /^20([0-2])0s$/.exec(word);
  return recent ? 2000 + Number(recent[1]) * 10 : null;
}

function detectEra(words: readonly string[]): Detected | null {
  const decadeAt = words.findIndex((word) => decadeOf(word) !== null);
  if (decadeAt >= 0 && !negated(words, decadeAt)) {
    const from = decadeOf(words[decadeAt])!;
    return { key: `era:${from}s`, kind: "era", fromYear: from, untilYear: from + 9, label: `${from}s` };
  }
  const said = (phrases: readonly string[]) => phrases.some((phrase) => {
    const at = phraseAt(words, phrase);
    return at >= 0 && !negated(words, at);
  });
  if (said(RECENT)) return { key: "era:recent", kind: "era", fromYear: 2015, label: "From 2015" };
  if (said(CLASSIC)) return { key: "era:classic", kind: "era", untilYear: 1979, label: "Before 1980" };
  return null;
}

/** Everything the words ask for that the catalogue can filter by, in the order it was said. */
export function detectPreferences(text: string): Detected[] {
  const words = wordsOf(text);
  if (words.length === 0) return [];
  const runtime = detectRuntime(text, words);
  const era = detectEra(words);
  return [...detectGenres(words), ...(runtime ? [runtime] : []), ...(era ? [era] : [])];
}

/**
 * The filters a preview reads with: what is already narrowing the results, with what was just
 * heard laid over it the way the engine would apply it. A genre heard is wanted alongside those
 * already wanted, a refusal excludes it, and a running time or an era replaces the one in effect.
 * Null when nothing was heard.
 */
export function previewFilters(base: CatalogueFilters | null, detected: readonly Detected[]): CatalogueFilters | null {
  if (detected.length === 0) return null;
  const heardGenres = detected.flatMap((item) => (item.kind === "genre" ? [item] : []));
  const refused = new Set(heardGenres.filter(({ refused }) => refused).map(({ genre }) => genre));
  const wanted = new Set(heardGenres.filter(({ refused }) => !refused).map(({ genre }) => genre));
  const runtime = detected.find((item) => item.kind === "runtime");
  const era = detected.find((item) => item.kind === "era");

  const current: CatalogueFilters = base ?? {};

  const include = [...new Set([...(current.includeGenres ?? []), ...wanted])].filter((genre) => !refused.has(genre));
  const exclude = [...new Set([...(current.excludeGenres ?? []).filter((genre) => !wanted.has(genre)), ...refused])];
  const maxRuntime = runtime?.kind === "runtime" ? runtime.underMinutes - 1 : current.maxRuntime;
  const years = era?.kind === "era" ? { minYear: era.fromYear, maxYear: era.untilYear } : { minYear: current.minYear, maxYear: current.maxYear };
  return {
    ...(current.minRuntime !== undefined ? { minRuntime: current.minRuntime } : {}),
    ...(maxRuntime !== undefined ? { maxRuntime } : {}),
    ...(years.minYear !== undefined ? { minYear: years.minYear } : {}),
    ...(years.maxYear !== undefined ? { maxYear: years.maxYear } : {}),
    ...(include.length > 0 ? { includeGenres: include } : {}),
    ...(exclude.length > 0 ? { excludeGenres: exclude } : {}),
    ...(current.excludeIds ? { excludeIds: current.excludeIds } : {}),
  };
}
