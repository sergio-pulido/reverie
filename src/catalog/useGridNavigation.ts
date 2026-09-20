import { useCallback, useEffect, useRef, useState } from "react";
import { gridMove, type GridIntent } from "./gridMove";

export type GridHandlers = {
  onActivate?: (index: number) => void;
  onExitTop?: () => void;
  onExitBottom?: () => void;
  onBack?: () => void;
};

/**
 * Roving focus for a TV remote or a keyboard: arrows traverse the grid, Home/End jump to the
 * row edges, Enter opens and Escape/Back returns. The key mapping lives in `gridMove`; the
 * column count is read from the live grid layout instead of assumed.
 */
export function useGridNavigation(itemCount: number, handlers: GridHandlers) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    setActiveIndex((index) => (itemCount === 0 ? 0 : Math.min(index, itemCount - 1)));
  }, [itemCount]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver === "undefined") return;

    const tracks = grid.querySelector<HTMLElement>("ul") ?? grid;
    const measure = () => {
      const template = window.getComputedStyle(tracks).getPropertyValue("grid-template-columns");
      const count = template.split(" ").filter((part) => part.trim().length > 0).length;
      setColumns(Math.max(1, count));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(tracks);
    return () => observer.disconnect();
  }, [itemCount]);

  const focusItem = useCallback((index: number) => {
    setActiveIndex(index);
    const target = gridRef.current?.querySelector<HTMLElement>(`[data-grid-index="${index}"]`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // A key the app has already taken (a held OK's repeats) opens nothing.
      if (event.defaultPrevented) return;
      const intent = gridMove(event.key, { index: activeIndex, columns, count: itemCount });
      if (!intent) return;
      const run = runIntent(intent, handlers, focusItem);
      if (run) event.preventDefault();
    },
    [activeIndex, columns, focusItem, handlers, itemCount],
  );

  return { gridRef, activeIndex, setActiveIndex, handleKeyDown, focusItem, columns };
}

/** Carries out one grid intent; returns false when nothing handles it, so the key is left alone. */
function runIntent(intent: GridIntent, handlers: GridHandlers, focusItem: (index: number) => void) {
  switch (intent.kind) {
    case "focus":
      focusItem(intent.index);
      return true;
    case "activate":
      return call(handlers.onActivate, intent.index);
    case "exitTop":
      return call(handlers.onExitTop);
    case "exitBottom":
      return call(handlers.onExitBottom);
    case "back":
      return call(handlers.onBack);
  }
}

function call<A extends unknown[]>(handler: ((...args: A) => void) | undefined, ...args: A) {
  if (!handler) return false;
  handler(...args);
  return true;
}
