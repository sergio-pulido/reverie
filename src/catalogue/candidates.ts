import type { Candidate } from "../preferences/schema";
import type { CatalogueTitle } from "./contract";
import { RUNTIME_ATTRIBUTE, YEAR_ATTRIBUTE, languageTag } from "./domain";
import { parseGenres, toGenreDimensions } from "./genres";

/** A catalogue title as the preference engine sees it, still carrying the title it came from. */
export interface CatalogueCandidate extends Candidate {
  readonly label: string;
  readonly title: CatalogueTitle;
}

/**
 * Maps one title to a candidate. An attribute the title does not carry is omitted, never
 * defaulted: the engine excludes a candidate whose value is unknown, and a made-up 0 would let
 * a film of unknown length through "under two hours".
 */
export function toCandidate(title: CatalogueTitle): CatalogueCandidate {
  const genres = parseGenres(title.genres.join(","));
  const attributes: Record<string, number> = {};
  if (title.runtimeMinutes !== undefined) attributes[RUNTIME_ATTRIBUTE] = title.runtimeMinutes;
  if (title.year !== undefined) attributes[YEAR_ATTRIBUTE] = title.year;
  const language = languageTag(title.originalLanguage);

  return {
    id: title.id,
    label: title.title,
    dimensions: toGenreDimensions(genres),
    attributes,
    tags: language ? [...genres, language] : [...genres],
    flags: [],
    title,
  };
}

/** Maps a shortlist, keeping the first of any repeated id so the engine never sees a duplicate. */
export function toCandidates(titles: readonly CatalogueTitle[]): CatalogueCandidate[] {
  const seen = new Set<string>();
  return titles.flatMap((title) => {
    if (seen.has(title.id)) return [];
    seen.add(title.id);
    return [toCandidate(title)];
  });
}
