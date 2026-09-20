import { useSyncExternalStore } from "react";

/**
 * Whether the screen is a phone's. The stylesheet turns at the same width, and the few things a
 * stylesheet cannot decide — the words in the placeholder, whether the preview needs a control to
 * close it by thumb — ask here so that the two never disagree.
 */

/** The width the phone layout begins at, in step with `search.css`. */
export const PHONE = "(max-width: 720px)";

const query = () => (typeof window.matchMedia === "function" ? window.matchMedia(PHONE) : null);

function subscribe(onChange: () => void) {
  const media = query();
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

/** False where no media query can be asked (an older browser, a test document): the wide layout. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => query()?.matches ?? false,
    () => false,
  );
}
