import type { CatalogueFilters } from "../catalogue/contract";
import type { GenreSlug } from "../catalogue/genres";

/**
 * The home's shelves. Each is one genre or one era, read through the catalogue's existing
 * search with its genre and year filters and no search text, so every shelf is the same
 * indexed query Discover already makes, ordered by popularity.
 */
export type ShelfSpec =
  | { id: string; title: string; kind: "genre"; genre: GenreSlug }
  | { id: string; title: string; kind: "era"; fromYear: number; toYear: number };

export const SHELVES: readonly ShelfSpec[] = [
  { id: "science-fiction", title: "Science fiction", kind: "genre", genre: "science_fiction" },
  { id: "comedy", title: "Comedies", kind: "genre", genre: "comedy" },
  { id: "nineties", title: "From the nineties", kind: "era", fromYear: 1990, toYear: 1999 },
  { id: "animation", title: "Animation", kind: "genre", genre: "animation" },
  { id: "thriller", title: "Thrillers", kind: "genre", genre: "thriller" },
  { id: "eighties", title: "From the eighties", kind: "era", fromYear: 1980, toYear: 1989 },
  { id: "documentary", title: "Documentaries", kind: "genre", genre: "documentary" },
  { id: "twenty-tens", title: "From the 2010s", kind: "era", fromYear: 2010, toYear: 2019 },
];

/** Shelves read as soon as the home opens. The rest wait until they approach the viewport. */
export const EAGER_SHELVES = 2;

/** Titles per shelf: enough to fill a TV-wide row and keep going, and no more. */
export const SHELF_PAGE_SIZE = 12;

/** The Movie Jam spotlight sits after this many shelves. */
export const SPOTLIGHT_AFTER = 2;

export function shelfFilters(shelf: ShelfSpec): CatalogueFilters {
  return shelf.kind === "genre" ? { includeGenres: [shelf.genre] } : { minYear: shelf.fromYear, maxYear: shelf.toYear };
}
