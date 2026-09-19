import { useCallback, useEffect, useState } from "react";
import { CATALOGUE_LIMITS, type CatalogueFilters } from "../catalogue/contract";
import type { CatalogueState } from "../discover/catalogueClient";
import { useCatalogueRead } from "../discover/CatalogueReadContext";

/** A read another hook is making, for exactly these filters, that this one can use instead of its own. */
export type SharedRead = { key: string | null; state: CatalogueState | null };

type ShortlistOptions = {
  /** Nothing is read until this is true. */
  enabled: boolean;
  pageSize?: number;
  /** Waits this long after the filters settle, for filters that change as someone speaks. */
  debounceMs?: number;
  /** When it is for the same filters, its answer is used and nothing more is read. */
  shared?: SharedRead;
};

/** The same filters always make the same key, whatever order they were built in. */
export function shortlistKey(filters: CatalogueFilters | null): string | null {
  return filters ? JSON.stringify(filters) : null;
}

/**
 * One shortlist read for one set of filters, with every filter applied by the database. A newer
 * set of filters aborts the older read, and a result is only ever reported for the filters it was
 * read for: `state` is null while the current filters have not been answered yet.
 */
export function useShortlist(filters: CatalogueFilters | null, { enabled, pageSize = CATALOGUE_LIMITS.shortlistSize, debounceMs = 0, shared }: ShortlistOptions) {
  const read = useCatalogueRead();
  const key = shortlistKey(filters);
  const borrowed = shared !== undefined && key !== null && shared.key === key;
  const [answer, setAnswer] = useState<{ key: string; attempt: number; state: CatalogueState } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !key || borrowed) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void read({ query: "", page: 1, pageSize, filters: JSON.parse(key) as CatalogueFilters }, controller.signal).then((state) => {
        if (state && !controller.signal.aborted) setAnswer({ key, attempt, state });
      });
    }, debounceMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, enabled, borrowed, attempt, read, pageSize, debounceMs]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const own = answer && answer.key === key && answer.attempt === attempt ? answer.state : null;
  return { state: borrowed ? shared.state : own, key, retry };
}
