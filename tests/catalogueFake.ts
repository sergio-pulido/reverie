import type { CatalogueTitle } from "../src/catalogue/contract";
import type { CatalogueRequest, CatalogueState } from "../src/discover/catalogueClient";
import type { CatalogueRead } from "../src/discover/CatalogueReadContext";
import { SHELVES } from "../src/home/shelves";

/** Which list a request reads: a home shelf by its genre or era, or the Discover grid. */
function listOf(request: CatalogueRequest): { name: string; base: number } {
  const { filters } = request;
  const shelf = SHELVES.findIndex((spec) =>
    spec.kind === "genre" ? filters?.includeGenres?.[0] === spec.genre : filters?.minYear === spec.fromYear && filters?.maxYear === spec.toYear,
  );
  if (shelf >= 0) return { name: SHELVES[shelf].title, base: (shelf + 1) * 1_000 };
  return { name: "Grid film", base: 50_000 };
}

/**
 * A catalogue that answers every read at once with numbered titles, each with a poster and a
 * backdrop, and records what it was asked. Titles are named after their list: "Comedies 3",
 * "Grid film 12".
 */
export function fakeCatalogue() {
  const requests: CatalogueRequest[] = [];
  const read: CatalogueRead = async (request) => {
    requests.push(request);
    const { name, base } = listOf(request);
    const offset = (request.page - 1) * request.pageSize;
    const items: CatalogueTitle[] = Array.from({ length: request.pageSize }, (_, index) => ({
      id: `cat:${base + offset + index + 1}`,
      title: `${name} ${offset + index}`,
      year: 2000 + index,
      genres: ["Drama"],
      availability: [],
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
