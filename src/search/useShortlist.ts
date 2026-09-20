import { useCallback, useEffect, useState } from "react";
import { CATALOGUE_LIMITS, type CatalogueFilters } from "../catalogue/contract";
import type { ShortlistRead } from "../catalogue/shortlistFilters";
import type { CatalogueState } from "../discover/catalogueClient";
import { useCatalogueRead } from "../discover/CatalogueReadContext";

/** A read another hook is making, for exactly this read, that this one can use instead of its own. */
export type SharedRead = { key: string | null; state: CatalogueState | null; widened: boolean };

type ShortlistOptions = {
  /** Nothing is read until this is true. */
  enabled: boolean;
  pageSize?: number;
  /** Waits this long after the read settles, for filters that change as someone speaks. */
  debounceMs?: number;
  /** When it is for the same read, its answer is used and nothing more is read. */
  shared?: SharedRead;
};

/** The same subject and filters always make the same key, whatever order they were built in. */
export function shortlistKey(read: ShortlistRead | null): string | null {
  return read ? JSON.stringify([read.subject, read.filters]) : null;
}

/**
 * One shortlist read for one subject and one set of filters, with every filter applied by the
 * database. A newer read aborts the older one, and a result is only ever reported for the read
 * it was made for: `state` is null while the current read has not been answered yet.
 *
 * A subject that matches nothing must not empty the screen. When the words find no film at all,
 * the same filters are read again without them and that wider answer is reported, with `widened`
 * set so the screen can say plainly that the words found nothing. The filters are never dropped:
 * only the words are, and only when they would otherwise leave the viewer with nothing.
 */
export function useShortlist(read: ShortlistRead | null, { enabled, pageSize = CATALOGUE_LIMITS.shortlistSize, debounceMs = 0, shared }: ShortlistOptions) {
  const request = useCatalogueRead();
  const key = shortlistKey(read);
  const borrowed = shared !== undefined && key !== null && shared.key === key;
  const [answer, setAnswer] = useState<{ key: string; attempt: number; state: CatalogueState; widened: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !key || borrowed) return;
    const [subject, filters] = JSON.parse(key) as [string, CatalogueFilters];
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const found = await request({ query: subject, page: 1, pageSize, filters }, controller.signal);
        if (!found || controller.signal.aborted) return;
        if (subject !== "" && found.phase === "ready" && found.response.total === 0) {
          const wider = await request({ query: "", page: 1, pageSize, filters }, controller.signal);
          if (wider && !controller.signal.aborted) setAnswer({ key, attempt, state: wider, widened: true });
          return;
        }
        setAnswer({ key, attempt, state: found, widened: false });
      })();
    }, debounceMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, enabled, borrowed, attempt, request, pageSize, debounceMs]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const own = answer && answer.key === key && answer.attempt === attempt ? answer : null;
  return {
    state: borrowed ? shared.state : (own?.state ?? null),
    /** True when the subject found nothing and the filters alone answered instead. */
    widened: borrowed ? shared.widened : (own?.widened ?? false),
    key,
    retry,
  };
}
