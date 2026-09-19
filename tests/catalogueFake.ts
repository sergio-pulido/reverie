import type { CatalogueTitle } from "../src/catalogue/contract";
import type { CatalogueRequest, CatalogueState } from "../src/discover/catalogueClient";
import type { CatalogueRead } from "../src/discover/CatalogueReadContext";
import { SHELVES } from "../src/home/shelves";

/** Which list a request reads: a title lookup by its words, a home shelf by its genre or era, or a shortlist. */
function listOf(request: CatalogueRequest): { name: string; base: number } {
  const { filters } = request;
  // Each query gets ids of its own, so two lookups never show the same film.
  if (request.query) return { name: request.query, base: 100_000 + ([...request.query].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) % 9_000) * 100 };
  const shelf = SHELVES.findIndex((spec) =>
    spec.kind === "genre" ? filters?.includeGenres?.[0] === spec.genre : filters?.minYear === spec.fromYear && filters?.maxYear === spec.toYear,
  );
  if (shelf >= 0) return { name: SHELVES[shelf].title, base: (shelf + 1) * 1_000 };
  return { name: "Shortlisted", base: 50_000 };
}

/** A year the request's bounds allow, so a filtered read answers with films that pass its filter. */
function yearWithin({ filters }: CatalogueRequest, index: number): number {
  const from = filters?.minYear ?? (filters?.maxYear !== undefined ? filters.maxYear - 9 : 2000);
  const until = filters?.maxYear ?? from + 47;
  return from + (index % (until - from + 1));
}

/**
 * A catalogue that answers every read at once with numbered titles, each with a poster, a backdrop
 * and a synopsis, and records what it was asked. Titles are named after their list: "Comedies 3",
 * "Inception 0" for a lookup, "Shortlisted 12". A query in `unknown` finds nothing.
 */
export function fakeCatalogue({ unknown = [] }: { unknown?: readonly string[] } = {}) {
  const requests: CatalogueRequest[] = [];
  const read: CatalogueRead = async (request) => {
    requests.push(request);
    if (unknown.includes(request.query)) {
      return { phase: "ready", response: { status: "ok", source: "tmdb", items: [], page: 1, pageSize: request.pageSize, total: 0, hasMore: false } };
    }
    const { name, base } = listOf(request);
    const offset = (request.page - 1) * request.pageSize;
    const items: CatalogueTitle[] = Array.from({ length: request.pageSize }, (_, index) => ({
      id: `cat:${base + offset + index + 1}`,
      title: `${name} ${offset + index}`,
      year: yearWithin(request, index),
      genres: ["Drama"],
      availability: [],
      synopsis: `The ${offset + index + 1}th story told here. It goes on from there.`,
      posterUrl: `https://image.tmdb.org/t/p/w500/p${base + offset + index}.jpg`,
      backdropUrl: `https://image.tmdb.org/t/p/w780/b${base + offset + index}.jpg`,
    }));
    const state: CatalogueState = {
      phase: "ready",
      response: { status: "ok", source: "tmdb", items, page: request.page, pageSize: request.pageSize, total: 500, hasMore: true, attribution: "Film data and images from TMDB." },
    };
    return state;
  };
  return { read, requests };
}
