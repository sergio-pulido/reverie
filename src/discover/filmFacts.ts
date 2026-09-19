import type { CatalogueTitle, CatalogueTitleDetail } from "../catalogue/contract";

/**
 * What a film's page says about it, derived only from fields the record carries. A field the
 * record lacks produces no line at all: there is no "unknown", no "0" and no dash standing in
 * for a value. Pure, so that rule is testable without rendering.
 */

export type FilmFact = { label: string; value: string };

/** The film as far as it is known: the grid's title at first, the full record once it arrives. */
export type FilmRecord = CatalogueTitle & Partial<Omit<CatalogueTitleDetail, keyof CatalogueTitle>>;

export function formatRuntime(minutes: number | undefined) {
  if (!minutes || minutes <= 0) return undefined;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "8.4 / 10", present only when the record holds a score with votes behind it. */
export function formatScore(film: FilmRecord) {
  if (!film.voteAverage || !film.voteCount) return undefined;
  return `${film.voteAverage.toFixed(1)} / 10`;
}

export function formatVotes(count: number | undefined) {
  if (!count || count <= 0) return undefined;
  return `${count.toLocaleString("en")} ${count === 1 ? "vote" : "votes"}`;
}

/** A full release date in words; the date is a calendar date, so it is read as UTC. */
export function formatReleaseDate(isoDate: string | undefined) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return undefined;
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

/** The language's English name, or the code itself when the browser has no name for it. */
export function languageName(code: string | undefined) {
  if (!code) return undefined;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The short line under the title: year, running time and score, each only when known. */
export function filmHeadline(film: FilmRecord): string[] {
  return [film.year ? String(film.year) : undefined, formatRuntime(film.runtimeMinutes), formatScore(film)].filter(
    (part): part is string => part !== undefined,
  );
}

/** The labelled facts beside the synopsis, in reading order, each only when known. */
export function filmFacts(film: FilmRecord): FilmFact[] {
  const facts: Array<[string, string | undefined]> = [
    ["Original title", film.originalTitle],
    ["Released", formatReleaseDate(film.releaseDate)],
    ["Running time", formatRuntime(film.runtimeMinutes)],
    ["Audience score", formatScore(film) && [formatScore(film), formatVotes(film.voteCount)].filter(Boolean).join(" · ")],
    ["Original language", languageName(film.originalLanguage)],
    ["Spoken languages", film.spokenLanguages && film.spokenLanguages.length > 0 ? film.spokenLanguages.join(", ") : undefined],
  ];
  return facts.filter((fact): fact is [string, string] => typeof fact[1] === "string" && fact[1].length > 0).map(([label, value]) => ({ label, value }));
}

export function imdbUrl(imdbId: string | undefined) {
  return imdbId && /^tt\d{5,10}$/.test(imdbId) ? `https://www.imdb.com/title/${imdbId}/` : undefined;
}
