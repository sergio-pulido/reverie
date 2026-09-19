import { useCallback, useEffect, useState } from "react";
import { CATALOGUE_LIMITS, type CatalogueFilters } from "../catalogue/contract";
import type { CatalogueState } from "../discover/catalogueClient";
import { useCatalogueRead } from "../discover/CatalogueReadContext";

type ShortlistOptions = {
  /** Nothing is read until this is true. */
  enabled: boolean;
  pageSize?: number;
  /** Waits this long after the filters settle, for filters that change as someone speaks. */
  debounceMs?: number;
};

/**
 * One shortlist read for one set of filters, with every filter applied by the database. A newer
 * set of filters aborts the older read, and a result is only ever reported for the filters it was
 * read for: `state` is null while the current filters have not been answered yet.
 */
export function useShortlist(filters: CatalogueFilters | null, { enabled, pageSize = CATALOGUE_LIMITS.shortlistSize, debounceMs = 0 }: ShortlistOptions) {
  const read = useCatalogueRead();
  const key = filters ? JSON.stringify(filters) : null;
  const [answer, setAnswer] = useState<{ key: string; attempt: number; state: CatalogueState } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !key) return;
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
  }, [key, enabled, attempt, read, pageSize, debounceMs]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const state = answer && answer.key === key && answer.attempt === attempt ? answer.state : null;
  return { state, key, retry };
}
