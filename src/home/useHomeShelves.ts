import { useCallback, useEffect, useRef, useState } from "react";
import { createShelfLoader, type ShelfLoad, type ShelfLoader, type ShelfResult, type ShelfState } from "./shelfLoader";
import { EAGER_SHELVES, SHELVES } from "./shelves";

/** How far below the viewport a shelf counts as approaching: about one shelf ahead of the viewer. */
export const APPROACH_MARGIN = "0px 0px 480px 0px";

export type ShelfSourceLike = { load: ShelfLoad; peek?: (index: number) => ShelfResult | null };

/**
 * The home's shelves as React state. The first `EAGER_SHELVES` are read once the home is
 * `enabled`; every other shelf is read when its section comes within `APPROACH_MARGIN` of the
 * viewport (`observe`), or when focus is about to move into it (`approach`). A shelf that has
 * been read is not watched. Shelves the source already holds start on screen, unread.
 *
 * A home that is not enabled (mounted under a film page opened by URL) reads nothing until it is.
 */
export function useHomeShelves({ load, peek }: ShelfSourceLike, enabled = true) {
  const [states, setStates] = useState<readonly ShelfState[]>(() => SHELVES.map((_, index) => peek?.(index) ?? { phase: "idle" }));
  const loaderRef = useRef<ShelfLoader | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const sections = useRef(new Map<Element, number>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const loader = createShelfLoader({ count: SHELVES.length, eager: EAGER_SHELVES, load, onChange: setStates, initial: peek });
    loaderRef.current = loader;
    setStates(loader.states);
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [load, peek]);

  useEffect(() => {
    if (!enabled) return;
    loaderRef.current?.start();
    // Sections that came into reach while the home was disabled are reported again.
    const observer = observerRef.current;
    for (const section of sections.current.keys()) {
      observer?.unobserve(section);
      observer?.observe(section);
    }
  }, [enabled, load, peek]);

  const approach = useCallback((index: number) => {
    if (enabledRef.current) loaderRef.current?.approach(index);
  }, []);

  const retry = useCallback((index: number) => {
    loaderRef.current?.retry(index);
  }, []);

  useEffect(() => {
    const watched = sections.current;
    const reached = (section: Element) => {
      const index = watched.get(section);
      if (index === undefined || !enabledRef.current) return;
      watched.delete(section);
      observerRef.current?.unobserve(section);
      approach(index);
    };

    if (typeof IntersectionObserver === "undefined") return watchByScrolling(watched, reached);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) reached(entry.target);
      },
      { rootMargin: APPROACH_MARGIN },
    );
    observerRef.current = observer;
    for (const section of watched.keys()) observer.observe(section);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [approach]);

  /** One ref per shelf section, stable across renders. Eager shelves are never watched. */
  const [observe] = useState(() =>
    SHELVES.map((_, index) => (section: HTMLElement | null) => {
      if (!section || index < EAGER_SHELVES || sections.current.has(section)) return;
      if (loaderRef.current && loaderRef.current.states[index]?.phase !== "idle") return;
      sections.current.set(section, index);
      observerRef.current?.observe(section);
    }),
  );

  return { states, approach, retry, observe };
}

/** Without IntersectionObserver, the same rule measured on scroll. */
function watchByScrolling(watched: Map<Element, number>, reached: (section: Element) => void) {
  const check = () => {
    const horizon = window.innerHeight + 480;
    for (const section of [...watched.keys()]) if (section.getBoundingClientRect().top < horizon) reached(section);
  };
  check();
  window.addEventListener("scroll", check, { passive: true });
  return () => window.removeEventListener("scroll", check);
}
