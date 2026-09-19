import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Roving focus for a TV remote or a keyboard: arrows traverse the grid, Home/End jump to the
 * row edges, and the column count is read from the live grid layout instead of assumed.
 */
export function useGridNavigation(itemCount: number, onExitTop?: () => void, onActivate?: (index: number) => void) {
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
    target?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (itemCount === 0) return;
      const last = itemCount - 1;
      const rowStart = activeIndex - (activeIndex % columns);
      const moves: Record<string, number | undefined> = {
        ArrowRight: Math.min(activeIndex + 1, last),
        ArrowLeft: Math.max(activeIndex - 1, 0),
        ArrowDown: Math.min(activeIndex + columns, last),
        ArrowUp: activeIndex - columns >= 0 ? activeIndex - columns : undefined,
        Home: rowStart,
        End: Math.min(rowStart + columns - 1, last),
      };

      if ((event.key === "Enter" || event.key === " ") && onActivate) {
        event.preventDefault();
        onActivate(activeIndex);
        return;
      }

      if (event.key === "ArrowUp" && moves.ArrowUp === undefined && onExitTop) {
        event.preventDefault();
        onExitTop();
        return;
      }

      const next = moves[event.key];
      if (next === undefined) return;
      event.preventDefault();
      focusItem(next);
    },
    [activeIndex, columns, focusItem, itemCount, onActivate, onExitTop],
  );

  return { gridRef, activeIndex, setActiveIndex, handleKeyDown, focusItem };
}
