import { providerIdOf, type CatalogueFilters, type CatalogueTitle } from "../catalogue/contract";

/**
 * The real catalogue films the public landing page shows.
 *
 * A visitor to the landing has no session, and `catalogue_titles` is readable only by a
 * signed-in viewer, so the landing never reads the catalogue itself. The build reads it once,
 * through the same adapter `/api/catalogue` uses, and this module shapes what it read. Pure: no
 * network, no React, no browser.
 */

export type LandingFilm = {
  /** The provider id, which is also the film's `/discover/:id` page. */
  id: string;
  title: string;
  /** "2023 · Drama": the year and first genre, whichever the record states. */
  meta: string;
  poster: string;
};

export type LandingFilms = {
  /** The hero's poster shelf. */
  shelf: LandingFilm[];
  /** The Discover illustration's shortlist. */
  picks: LandingFilm[];
  /** The real films the Community illustration sets beside the generated shorts. */
  community: LandingFilm[];
};

export const NO_LANDING_FILMS: LandingFilms = Object.freeze({ shelf: [], picks: [], community: [] });

export const LANDING_COUNTS = { shelf: 12, picks: 4, community: 2 } as const;

type GenreFilters = Readonly<Pick<CatalogueFilters, "includeGenres" | "excludeGenres">>;

/**
 * The shelf is the catalogue's own most popular titles, the order Discover opens with, less
 * the genres that should not be the first thing on a front door. Only genres are filtered:
 * the catalogue function exposes no quality signal, and no title is chosen or refused by name.
 */
export const SHELF_FILTERS: GenreFilters = { excludeGenres: ["horror", "thriller"] };

/**
 * The Discover illustration answers "something quiet for a Sunday night… gentle". The
 * catalogue carries genres, not moods, so the shortlist is what Discover itself can filter on:
 * dramas and family films, without the genres that are not gentle.
 */
export const GENTLE_FILTERS: GenreFilters = {
  includeGenres: ["drama", "family"],
  excludeGenres: ["horror", "thriller", "crime", "war", "action", "science_fiction", "mystery"],
};

/** Posters are drawn at most 176 CSS pixels wide; 342 covers that at 2x. */
const TMDB_CATALOGUE_POSTER = /^https:\/\/image\.tmdb\.org\/t\/p\/w500(\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+)$/;
const LANDING_POSTER_BASE = "https://image.tmdb.org/t/p/w342";

/** The catalogue's poster at the landing's width, or `null` when it is not a TMDB poster path. */
export function landingPoster(posterUrl: string | undefined): string | null {
  const match = posterUrl ? TMDB_CATALOGUE_POSTER.exec(posterUrl) : null;
  return match ? `${LANDING_POSTER_BASE}${match[1]}` : null;
}

export function filmMeta(title: CatalogueTitle): string {
  return [title.year, title.genres[0]].filter((part) => part !== undefined).join(" · ");
}

/** A title the landing can show, or `null`: a film without a poster is left out, never blanked. */
export function toLandingFilm(title: CatalogueTitle): LandingFilm | null {
  const poster = landingPoster(title.posterUrl);
  if (!poster) return null;
  return { id: providerIdOf(title.id), title: title.title, meta: filmMeta(title), poster };
}

function showable(titles: readonly CatalogueTitle[]): LandingFilm[] {
  const films = titles.map(toLandingFilm).filter((film): film is LandingFilm => film !== null);
  return films.filter((film, index) => films.findIndex((other) => other.id === film.id) === index);
}

/**
 * `popular` is the catalogue's own unfiltered order (most popular first); `gentle` is its
 * shortlist for `GENTLE_FILTERS`. The community pair follows the shelf, so no film repeats there.
 */
export function selectLandingFilms(popular: readonly CatalogueTitle[], gentle: readonly CatalogueTitle[]): LandingFilms {
  const ranked = showable(popular);
  return {
    shelf: ranked.slice(0, LANDING_COUNTS.shelf),
    picks: showable(gentle).slice(0, LANDING_COUNTS.picks),
    community: ranked.slice(LANDING_COUNTS.shelf, LANDING_COUNTS.shelf + LANDING_COUNTS.community),
  };
}
