import { requestCatalogue, type CatalogueRequest, type CatalogueState } from "../discover/catalogueClient";
import type { ShelfResult } from "./shelfLoader";
import { SHELF_PAGE_SIZE, SHELVES, shelfFilters, type ShelfSpec } from "./shelves";

/** One shelf's read: page 1, `SHELF_PAGE_SIZE` titles, the shelf's genre or era, no search text. */
export function shelfRequest(shelf: ShelfSpec): CatalogueRequest {
  return { query: "", page: 1, pageSize: SHELF_PAGE_SIZE, filters: shelfFilters(shelf) };
}

export function toShelfResult(state: CatalogueState): ShelfResult {
  switch (state.phase) {
    case "ready":
      return { phase: "ready", items: state.response.items, attribution: state.response.attribution };
    case "not_configured":
      return { phase: "not_configured", safeMessage: state.safeMessage };
    case "error":
      return { phase: "error", safeMessage: state.safeMessage, retryable: state.retryable };
    case "loading":
      return UNFINISHED;
  }
}

const UNFINISHED: ShelfResult = { phase: "error", safeMessage: "These films could not be loaded.", retryable: true };

/** Shelves that loaded are kept this long, so returning to the home asks the catalogue nothing. */
export const KEEP_SHELF_MS = 5 * 60_000;

type Request = (request: CatalogueRequest, signal: AbortSignal) => Promise<CatalogueState | null>;

/**
 * Where the home's shelves come from. A loaded shelf is kept for `keepMs` and handed back at once
 * (`peek` lets the home start with it on screen). A shelf already being read is joined, not read
 * twice, even by a home that has been closed and opened again meanwhile. A read is never aborted
 * by the home going away: its answer still fills the store for the next visit. Failures are
 * never kept.
 */
export function createShelfSource({ request = requestCatalogue, now = Date.now, keepMs = KEEP_SHELF_MS }: { request?: Request; now?: () => number; keepMs?: number } = {}) {
  const kept = new Map<string, { at: number; result: ShelfResult }>();
  const reading = new Map<string, Promise<ShelfResult>>();
  const keyOf = (shelf: ShelfSpec) => JSON.stringify(shelfRequest(shelf));

  function peek(index: number): ShelfResult | null {
    const shelf = SHELVES[index];
    const hit = shelf ? kept.get(keyOf(shelf)) : undefined;
    return hit && now() - hit.at < keepMs ? hit.result : null;
  }

  function load(index: number): Promise<ShelfResult> {
    const shelf = SHELVES[index];
    if (!shelf) return Promise.resolve({ phase: "error", safeMessage: "This shelf does not exist.", retryable: false });
    const hit = peek(index);
    if (hit) return Promise.resolve(hit);
    const key = keyOf(shelf);
    const joined = reading.get(key);
    if (joined) return joined;
    const read = request(shelfRequest(shelf), new AbortController().signal)
      .then((state) => (state ? toShelfResult(state) : UNFINISHED))
      .then((result) => {
        if (result.phase === "ready") kept.set(key, { at: now(), result });
        return result;
      })
      .finally(() => reading.delete(key));
    reading.set(key, read);
    return read;
  }

  return { load, peek };
}

export type ShelfSource = ReturnType<typeof createShelfSource>;

const sources = new WeakMap<Request, ShelfSource>();

/** The one source for a given catalogue read, so every visit to the home shares what it keeps. */
export function shelfSourceFor(request: Request): ShelfSource {
  let source = sources.get(request);
  if (!source) {
    source = createShelfSource({ request });
    sources.set(request, source);
  }
  return source;
}

