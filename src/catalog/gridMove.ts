import { isBackKey } from "../shell/keys";

export type GridPosition = { index: number; columns: number; count: number };

export type GridIntent =
  | { kind: "focus"; index: number }
  | { kind: "activate"; index: number }
  | { kind: "exitTop" }
  | { kind: "exitBottom" }
  | { kind: "back" };

const ACTIVATE_KEYS = new Set(["Enter", " "]);

/**
 * Maps one key press on the poster grid to what should happen next. Pure, so the remote's
 * behaviour is testable without a DOM: arrows move one poster and stop at the edges, a short
 * last row is reachable from the row above, and leaving the top or bottom row hands focus on.
 */
export function gridMove(key: string, { index, columns, count }: GridPosition): GridIntent | null {
  if (count === 0) return null;
  if (ACTIVATE_KEYS.has(key)) return { kind: "activate", index };
  if (isBackKey(key)) return { kind: "back" };

  const last = count - 1;
  const width = Math.max(1, columns);
  const rowStart = index - (index % width);

  switch (key) {
    case "ArrowRight":
      return { kind: "focus", index: Math.min(index + 1, last) };
    case "ArrowLeft":
      return { kind: "focus", index: Math.max(index - 1, 0) };
    case "ArrowUp":
      return index - width >= 0 ? { kind: "focus", index: index - width } : { kind: "exitTop" };
    case "ArrowDown":
      return rowStart + width <= last ? { kind: "focus", index: Math.min(index + width, last) } : { kind: "exitBottom" };
    case "Home":
      return { kind: "focus", index: rowStart };
    case "End":
      return { kind: "focus", index: Math.min(rowStart + width - 1, last) };
    default:
      return null;
  }
}
