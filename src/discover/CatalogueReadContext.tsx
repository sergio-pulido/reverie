import { createContext, useContext, type ReactNode } from "react";
import { requestCatalogue, type CatalogueRequest, type CatalogueState } from "./catalogueClient";

/** One catalogue read, as the home and search make it. */
export type CatalogueRead = (request: CatalogueRequest, signal: AbortSignal) => Promise<CatalogueState | null>;

const CatalogueReadContext = createContext<CatalogueRead>(requestCatalogue);

/**
 * Where the home's shelves and the search screen read the catalogue from. The app reads
 * `/api/catalogue`; a test renders the same screens over its own titles.
 */
export function CatalogueReadProvider({ read, children }: { read: CatalogueRead; children: ReactNode }) {
  return <CatalogueReadContext.Provider value={read}>{children}</CatalogueReadContext.Provider>;
}

export function useCatalogueRead(): CatalogueRead {
  return useContext(CatalogueReadContext);
}
