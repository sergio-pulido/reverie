/**
 * How a remote moves through the home: a column of rows (the hero, shelves, the Movie Jam
 * spotlight), each a horizontal run of focusable items. Pure, so the roles are testable without
 * a DOM.
 *
 * The two axes never mix. Left and Right move within the row and stop at its ends; they never
 * wrap into the next row. Up and Down change row and never move along it: they land on the item
 * the viewer last had in that row, or its first item on a first visit. Up from the first row
 * leaves for the top bar.
 */

export type HomeRow = {
  key: string;
  /** Focusable items in the row. A row with none is passed over. */
  count: number;
  /** Still loading (or not yet asked for). Vertical moves wait for it rather than skip it. */
  pending?: boolean;
};

export type RowPosition = { row: number; index: number };

export type RowIntent =
  | { kind: "focus"; row: number; index: number }
  /** The key was taken but focus stays: an edge, or a row still loading. */
  | { kind: "stay" }
  /** Vertical movement is waiting on this row to load. */
  | { kind: "wait"; row: number }
  | { kind: "exitTop" };

/**
 * `memory[r]` is the item last focused in row `r`. It is clamped here, so a row that shrank never
 * sends focus past its end.
 */
export function rowMove(key: string, { row, index }: RowPosition, rows: readonly HomeRow[], memory: readonly number[]): RowIntent | null {
  const current = rows[row];
  if (!current) return null;

  switch (key) {
    case "ArrowLeft":
      return index > 0 ? { kind: "focus", row, index: index - 1 } : { kind: "stay" };
    case "ArrowRight":
      return index < current.count - 1 ? { kind: "focus", row, index: index + 1 } : { kind: "stay" };
    case "Home":
      return { kind: "focus", row, index: 0 };
    case "End":
      return { kind: "focus", row, index: Math.max(0, current.count - 1) };
    case "ArrowUp":
      return vertical(rows, memory, row, -1);
    case "ArrowDown":
      return vertical(rows, memory, row, 1);
    default:
      return null;
  }
}

function vertical(rows: readonly HomeRow[], memory: readonly number[], from: number, step: 1 | -1): RowIntent {
  for (let row = from + step; row >= 0 && row < rows.length; row += step) {
    const target = rows[row];
    if (target.pending) return { kind: "wait", row };
    if (target.count > 0) return { kind: "focus", row, index: Math.min(Math.max(memory[row] ?? 0, 0), target.count - 1) };
  }
  return step === -1 ? { kind: "exitTop" } : { kind: "stay" };
}

/** The first row a viewer can land on, or -1 while none can be focused. */
export function firstFocusableRow(rows: readonly HomeRow[]): number {
  for (let row = 0; row < rows.length; row += 1) {
    if (rows[row].pending) return -1;
    if (rows[row].count > 0) return row;
  }
  return -1;
}
