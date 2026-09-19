import type { CatalogueTitle } from "../catalogue/contract";

/**
 * Which shelves have been asked for, and what each holds. Nothing here touches React or the DOM,
 * so the cost rule is testable directly: the first `eager` shelves are read when the home opens,
 * and every other shelf only when `approach` reports it near the viewport (or focus is about to
 * reach it). Each shelf is read at most once at a time; asking again while it loads, or after it
 * has loaded, does nothing. A failed shelf is read again only on `retry`.
 */

export type ShelfState =
  | { phase: "idle" }
  /** `retrying` marks a read the viewer asked for again after a failure. */
  | { phase: "loading"; retrying?: boolean }
  | { phase: "ready"; items: readonly CatalogueTitle[]; attribution?: string }
  | { phase: "not_configured"; safeMessage: string }
  | { phase: "error"; safeMessage: string; retryable: boolean };

/** What reading one shelf yields. */
export type ShelfResult = Exclude<ShelfState, { phase: "idle" } | { phase: "loading" }>;

export type ShelfLoad = (index: number, signal: AbortSignal) => Promise<ShelfResult>;

const FAILED: ShelfResult = { phase: "error", safeMessage: "These films could not be loaded.", retryable: true };

type LoaderOptions = {
  count: number;
  eager: number;
  load: ShelfLoad;
  onChange: (states: readonly ShelfState[]) => void;
  /** What each shelf holds already (a kept read), or null for a shelf still to be read. */
  initial?: (index: number) => ShelfResult | null;
};

export function createShelfLoader({ count, eager, load, onChange, initial }: LoaderOptions) {
  let states: readonly ShelfState[] = Array.from({ length: count }, (_, index): ShelfState => initial?.(index) ?? { phase: "idle" });
  const controller = new AbortController();

  function set(index: number, next: ShelfState) {
    states = states.map((state, at) => (at === index ? next : state));
    onChange(states);
  }

  function read(index: number, retrying = false) {
    set(index, retrying ? { phase: "loading", retrying } : { phase: "loading" });
    void load(index, controller.signal)
      .catch((): ShelfResult => FAILED)
      .then((result) => {
        if (!controller.signal.aborted) set(index, result);
      });
  }

  /** Shelf `index` is near the viewport. Returns true when this started a read. */
  function approach(index: number) {
    if (controller.signal.aborted || states[index]?.phase !== "idle") return false;
    read(index);
    return true;
  }

  return {
    get states() {
      return states;
    },
    /** Reads the eager shelves. Safe to call more than once. */
    start() {
      for (let index = 0; index < Math.min(eager, count); index += 1) approach(index);
    },
    approach,
    retry(index: number) {
      const state = states[index];
      if (controller.signal.aborted || state?.phase !== "error" || !state.retryable) return false;
      read(index, true);
      return true;
    },
    dispose() {
      controller.abort();
    },
  };
}

export type ShelfLoader = ReturnType<typeof createShelfLoader>;
