/**
 * Genre vocabulary of the catalogue and its mapping to preference dimensions.
 * Pure and provider-free. Genres are the only descriptive axis the catalogue carries;
 * nothing here infers mood, tone or pace from them.
 */

/** The complete set of values `catalogue_titles.genres` may hold, each with a stable slug. */
export const GENRES = [
  { label: "Drama", slug: "drama" },
  { label: "Comedy", slug: "comedy" },
  { label: "Thriller", slug: "thriller" },
  { label: "Action", slug: "action" },
  { label: "Romance", slug: "romance" },
  { label: "Horror", slug: "horror" },
  { label: "Crime", slug: "crime" },
  { label: "Adventure", slug: "adventure" },
  { label: "Family", slug: "family" },
  { label: "Science Fiction", slug: "science_fiction" },
  { label: "Fantasy", slug: "fantasy" },
  { label: "Animation", slug: "animation" },
  { label: "Mystery", slug: "mystery" },
  { label: "History", slug: "history" },
  { label: "Documentary", slug: "documentary" },
  { label: "Music", slug: "music" },
  { label: "TV Movie", slug: "tv_movie" },
  { label: "War", slug: "war" },
  { label: "Western", slug: "western" },
] as const;

export type GenreLabel = (typeof GENRES)[number]["label"];
export type GenreSlug = (typeof GENRES)[number]["slug"];
export type GenreDimensionKey = `genre.${GenreSlug}`;

/**
 * The genres a title states, as dimensions. Every key is optional and every present value is
 * exactly 1: a missing key means the row says nothing about that genre, never that it scores 0.
 */
export type GenreDimensions = Partial<Readonly<Record<GenreDimensionKey, 1>>>;

const SLUG_BY_LABEL: ReadonlyMap<string, GenreSlug> = new Map(GENRES.map(({ label, slug }) => [label, slug]));

/**
 * Reads a comma-separated genres column into the slugs it names, deduplicated, in first-seen
 * order. Values outside the vocabulary are dropped rather than matched loosely.
 */
export function parseGenres(raw: string | null): GenreSlug[] {
  if (!raw) return [];
  const slugs = raw
    .split(",")
    .map((part) => SLUG_BY_LABEL.get(part.trim()))
    .filter((slug): slug is GenreSlug => slug !== undefined);
  return [...new Set(slugs)];
}

/** One `genre.<slug>: 1` entry per genre the title has, and nothing for the rest. */
export function toGenreDimensions(slugs: readonly GenreSlug[]): GenreDimensions {
  return Object.fromEntries(slugs.map((slug) => [`genre.${slug}`, 1] as const)) as GenreDimensions;
}
