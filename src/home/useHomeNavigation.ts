import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { focusIsLost, focusTopBar } from "../shell/topBarFocus";
import { firstFocusableRow, rowMove, type HomeRow } from "./rowMove";

type Cell = { row: string; index: number };

/** Scrolls a shelf sideways just enough to show `cell` inside its inset; the page does not move. */
function revealInShelf(cell: HTMLElement) {
  const track = cell.closest<HTMLElement>(".home-shelf-track");
  if (!track) return;
  const inset = parseFloat(getComputedStyle(track).paddingLeft) || 0;
  const box = cell.getBoundingClientRect();
  const bounds = track.getBoundingClientRect();
  if (box.left < bounds.left + inset) track.scrollLeft -= bounds.left + inset - box.left;
  else if (box.right > bounds.right - inset) track.scrollLeft += box.right - (bounds.right - inset);
}

/** A cell a remote can focus: one item of one row. Only a row's remembered item is in the tab order. */
export function cellProps(row: string, index: number, memory: ReadonlyMap<string, number>) {
  return { "data-row": row, "data-index": index, tabIndex: (memory.get(row) ?? 0) === index ? 0 : -1 };
}

function cellOf(element: EventTarget | null): Cell | null {
  if (!(element instanceof HTMLElement)) return null;
  const row = element.getAttribute("data-row");
  const index = Number(element.getAttribute("data-index"));
  return row !== null && Number.isInteger(index) ? { row, index } : null;
}

type Options = {
  /** A film page covers the home: it keeps its place and takes no focus until the page closes. */
  inert: boolean;
  /** A vertical move is waiting on this row, which has not loaded yet. */
  onWait: (row: string) => void;
  /** Focus has entered this row. */
  onRow: (row: string) => void;
};

/**
 * Remote navigation over the home's rows, with `rowMove` deciding every key. Focus lands on the
 * first row that can take it when the home opens, and never moves on its own once the viewer
 * has moved it. When a film page opened from a card closes, focus returns to that card.
 */
export function useHomeNavigation(rows: readonly HomeRow[], { inert, onWait, onRow }: Options) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [memory, setMemory] = useState<ReadonlyMap<string, number>>(() => new Map());
  const memoryRef = useRef(memory);
  memoryRef.current = memory;
  const focused = useRef<Cell | null>(null);
  const landed = useRef(false);
  /** Set while the home places focus itself, which is not the viewer moving into a row. */
  const placing = useRef(false);
  /** A row focus should move into once it has loaded: a shelf whose retry was pressed. */
  const awaited = useRef<string | null>(null);

  /**
   * Focuses one item and brings its whole row on screen (the row keeps clear of the attribution
   * bar), then the item itself within a shelf that scrolls sideways. The page scrolls once, by the
   * row: a second scroll by the item would cut the first short.
   */
  const focusCell = useCallback((row: string, index: number) => {
    const cell = containerRef.current?.querySelector<HTMLElement>(`[data-row="${row}"][data-index="${index}"]`);
    if (!cell) return false;
    cell.focus({ preventScroll: true });
    cell.closest("section")?.scrollIntoView?.({ block: "nearest" });
    revealInShelf(cell);
    return true;
  }, []);

  /** The first row's remembered item, as Down from the top bar or a first landing reaches it. */
  const enterFirstRow = useCallback(() => {
    const first = firstFocusableRow(rows);
    if (first < 0) return false;
    const row = rows[first];
    window.scrollTo({ top: 0 });
    return focusCell(row.key, Math.min(memoryRef.current.get(row.key) ?? 0, row.count - 1));
  }, [rows, focusCell]);

  useEffect(() => {
    if (inert || landed.current) return;
    if (!focusIsLost()) {
      landed.current = true;
      return;
    }
    placing.current = true;
    if (enterFirstRow()) landed.current = true;
    placing.current = false;
  }, [inert, enterFirstRow]);

  /** Back from a film page opened here: focus returns to the card that opened it, in place. */
  const wasInert = useRef(inert);
  useEffect(() => {
    const closed = wasInert.current && !inert;
    wasInert.current = inert;
    if (!closed || !focused.current || !focusIsLost()) return;
    focusCell(focused.current.row, focused.current.index);
  }, [inert, focusCell]);

  /** A retried shelf takes focus back once it has loaded, if nothing else has taken it since. */
  useEffect(() => {
    const row = rows.find(({ key }) => key === awaited.current);
    if (!row || row.pending) return;
    awaited.current = null;
    if (focusIsLost() && row.count > 0) focusCell(row.key, 0);
  }, [rows, focusCell]);

  const onFocus = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const cell = cellOf(event.target);
      if (!cell) return;
      landed.current = true;
      if (!placing.current && focused.current?.row !== cell.row) onRow(cell.row);
      focused.current = cell;
      setMemory((current) => (current.get(cell.row) === cell.index ? current : new Map(current).set(cell.row, cell.index)));
    },
    [onRow],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      const cell = cellOf(event.target);
      const row = cell ? rows.findIndex(({ key }) => key === cell.row) : -1;
      if (!cell || row < 0) return;
      // OK chooses the focused item, once: the browser's own Enter activation is replaced, not added to.
      if (event.key === "Enter") {
        event.preventDefault();
        (event.target as HTMLElement).click();
        return;
      }
      const intent = rowMove(event.key, { row, index: cell.index }, rows, rows.map(({ key }) => memoryRef.current.get(key) ?? 0));
      if (!intent) return;
      event.preventDefault();
      if (intent.kind === "focus") {
        focusCell(rows[intent.row].key, intent.index);
        // The first row brings the whole page back to the top, hero and all.
        if (intent.row === firstFocusableRow(rows)) window.scrollTo({ top: 0 });
      } else if (intent.kind === "exitTop") {
        focusTopBar();
      } else if (intent.kind === "wait") {
        onWait(rows[intent.row].key);
      }
    },
    [rows, focusCell, onWait],
  );

  /** Focus goes to `row`'s first item as soon as it has loaded. */
  const awaitRow = useCallback((row: string) => {
    awaited.current = row;
  }, []);

  return { containerRef, memory, onFocus, onKeyDown, awaitRow, enterFirstRow };
}
