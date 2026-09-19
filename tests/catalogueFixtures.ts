import type { CatalogueTitle } from "../src/catalogue/contract";

/** A catalogue title with every optional field present unless overridden. */
export function title(id: number, overrides: Partial<CatalogueTitle> = {}): CatalogueTitle {
  return {
    id: `cat:${id}`,
    title: `Film ${id}`,
    year: 2010,
    genres: ["Drama"],
    runtimeMinutes: 100,
    originalLanguage: "en",
    availability: [],
    ...overrides,
  };
}
