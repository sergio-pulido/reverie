import { useCallback, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { rowMove, type HomeRow } from "../home/rowMove";
import { isEditable } from "./topBarFocus";

/**
 * Remote navigation over a column of rows, the same axis rule as the rest of the app: Up and Down
 * move between rows and land on the item last focused there, Left and Right move within a row and
 * stop at its ends. `rowMove` decides every arrow. OK presses the focused button. A cell is any
 * element carrying `data-row` and `data-index`; in a text field Left and Right belong to the caret.
 *
 * It lives in `shell` because it is the app's axis convention rather than any one screen's:
 * Discover's filter panel and the Director session both walk their rows with it.
 */

export type Row = HomeRow;

type Cell = { row: string; index: number };

type RowsOptions = {
  /** Up from the first row. */
  onExitTop?: () => void;
  /** Entering a row some other way than by its remembered item (a field, say); true when done. */
  enter?: (row: string) => boolean;
};

function cellOf(element: EventTarget | null): Cell | null {
  if (!(element instanceof HTMLElement)) return null;
  const row = element.getAttribute("data-row");
  const index = Number(element.getAttribute("data-index"));
  return row !== null && Number.isInteger(index) ? { row, index } : null;
}

/** Scrolls a sideways track just enough to show `cell` inside its inset; the page does not move. */
function revealInTrack(cell: HTMLElement) {
  const track = cell.closest<HTMLElement>("[data-track]");
  if (!track) return;
  const inset = parseFloat(getComputedStyle(track).paddingLeft) || 0;
  const box = cell.getBoundingClientRect();
  const bounds = track.getBoundingClientRect();
  if (box.left < bounds.left + inset) track.scrollLeft -= bounds.left + inset - box.left;
  else if (box.right > bounds.right - inset) track.scrollLeft += box.right - (bounds.right - inset);
}

export function useRows(rows: readonly Row[], { onExitTop, enter }: RowsOptions = {}) {
  const containerRef = useRef<HTMLElement | null>(null);
  const [memory, setMemory] = useState<ReadonlyMap<string, number>>(() => new Map());
  const memoryRef = useRef(memory);
  memoryRef.current = memory;

  /** Focuses one item, brings it (or the turn it belongs to) on screen, then the item within its track. */
  const focusCell = useCallback((row: string, index: number) => {
    // Row keys are the screen's own ("turn-3", "strip", "composer"): nothing in them needs escaping.
    const cell = containerRef.current?.querySelector<HTMLElement>(`[data-row="${row}"][data-index="${index}"]`);
    if (!cell) return false;
    cell.focus({ preventScroll: true });
    // A turn comes on screen whole where it can; anything else (a panel's row) brings itself.
    (cell.closest("[data-block]") ?? cell).scrollIntoView?.({ block: "nearest" });
    revealInTrack(cell);
    return true;
  }, []);

  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const cell = cellOf(event.target);
    if (!cell) return;
    setMemory((current) => (current.get(cell.row) === cell.index ? current : new Map(current).set(cell.row, cell.index)));
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      const cell = cellOf(event.target);
      const row = cell ? rows.findIndex(({ key }) => key === cell.row) : -1;
      if (!cell || row < 0) return;
      // OK chooses a button once, here: the browser's own Enter activation is replaced, not added to.
      if (event.key === "Enter") {
        if (!(event.target instanceof HTMLButtonElement)) return;
        event.preventDefault();
        event.target.click();
        return;
      }
      const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End";
      if (horizontal && isEditable(event.target as Element)) return;
      const intent = rowMove(event.key, { row, index: cell.index }, rows, rows.map(({ key }) => memoryRef.current.get(key) ?? 0));
      if (!intent) return;
      event.preventDefault();
      if (intent.kind === "focus") {
        const target = rows[intent.row].key;
        if (intent.row !== row && enter?.(target)) return;
        focusCell(target, intent.index);
      } else if (intent.kind === "exitTop") {
        onExitTop?.();
      }
    },
    [rows, focusCell, onExitTop, enter],
  );

  /** Where a remote can land in a row: only its remembered item is in the tab order. */
  const cellProps = useCallback(
    (row: string, index: number) => ({ "data-row": row, "data-index": index, tabIndex: (memory.get(row) ?? 0) === index ? 0 : -1 }),
    [memory],
  );

  return { containerRef, cellProps, onKeyDown, onFocus, focusCell };
}
