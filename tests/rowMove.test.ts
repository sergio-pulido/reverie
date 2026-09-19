import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firstFocusableRow, rowMove, type HomeRow } from "../src/home/rowMove";

/** The home's shape: a hero with one action, two shelves, the spotlight with two, one more shelf. */
const rows: HomeRow[] = [
  { key: "hero", count: 1 },
  { key: "shelf:a", count: 11 },
  { key: "shelf:b", count: 12 },
  { key: "jam", count: 2 },
  { key: "shelf:c", count: 12 },
];
const noMemory = rows.map(() => 0);

describe("rowMove: Left and Right stay within the row", () => {
  it("moves one item along the row", () => {
    assert.deepEqual(rowMove("ArrowRight", { row: 1, index: 4 }, rows, noMemory), { kind: "focus", row: 1, index: 5 });
    assert.deepEqual(rowMove("ArrowLeft", { row: 1, index: 4 }, rows, noMemory), { kind: "focus", row: 1, index: 3 });
  });

  it("stops at either end instead of wrapping into another row", () => {
    assert.deepEqual(rowMove("ArrowLeft", { row: 2, index: 0 }, rows, noMemory), { kind: "stay" });
    assert.deepEqual(rowMove("ArrowRight", { row: 1, index: 10 }, rows, noMemory), { kind: "stay" });
    assert.deepEqual(rowMove("ArrowRight", { row: 0, index: 0 }, rows, noMemory), { kind: "stay" });
  });

  it("never changes row, whatever the position", () => {
    for (let row = 0; row < rows.length; row += 1) {
      for (let index = 0; index < rows[row].count; index += 1) {
        for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
          const intent = rowMove(key, { row, index }, rows, noMemory);
          if (intent?.kind === "focus") assert.equal(intent.row, row, `${key} from ${row}:${index}`);
        }
      }
    }
  });
});

describe("rowMove: Up and Down change row", () => {
  it("lands on the item last focused in the target row, not on the same column", () => {
    const memory = [0, 7, 3, 1, 0];
    assert.deepEqual(rowMove("ArrowDown", { row: 1, index: 7 }, rows, memory), { kind: "focus", row: 2, index: 3 });
    assert.deepEqual(rowMove("ArrowUp", { row: 2, index: 3 }, rows, memory), { kind: "focus", row: 1, index: 7 });
    assert.deepEqual(rowMove("ArrowDown", { row: 2, index: 9 }, rows, memory), { kind: "focus", row: 3, index: 1 });
  });

  it("lands on the first item of a row never visited", () => {
    assert.deepEqual(rowMove("ArrowDown", { row: 1, index: 9 }, rows, noMemory), { kind: "focus", row: 2, index: 0 });
  });

  it("clamps a remembered item to a row that has since become shorter", () => {
    const shorter: HomeRow[] = rows.map((row) => (row.key === "jam" ? { ...row, count: 2 } : row));
    assert.deepEqual(rowMove("ArrowUp", { row: 4, index: 0 }, shorter, [0, 0, 0, 9, 0]), { kind: "focus", row: 3, index: 1 });
  });

  it("leaves for the top bar from the first row, and stays put at the last", () => {
    assert.deepEqual(rowMove("ArrowUp", { row: 0, index: 0 }, rows, noMemory), { kind: "exitTop" });
    assert.deepEqual(rowMove("ArrowDown", { row: 4, index: 5 }, rows, noMemory), { kind: "stay" });
  });

  it("passes over a row with nothing to focus", () => {
    const withEmpty: HomeRow[] = [{ key: "hero", count: 0 }, ...rows.slice(1)];
    assert.deepEqual(rowMove("ArrowUp", { row: 1, index: 2 }, withEmpty, noMemory), { kind: "exitTop" });
  });

  it("waits for a row still loading instead of jumping past it", () => {
    const loading: HomeRow[] = rows.map((row) => (row.key === "shelf:b" ? { key: row.key, count: 0, pending: true } : row));
    assert.deepEqual(rowMove("ArrowDown", { row: 1, index: 2 }, loading, noMemory), { kind: "wait", row: 2 });
    assert.deepEqual(rowMove("ArrowUp", { row: 3, index: 0 }, loading, noMemory), { kind: "wait", row: 2 });
  });
});

describe("firstFocusableRow", () => {
  it("is the first row that can take focus, and none while the rows above it load", () => {
    assert.equal(firstFocusableRow(rows), 0);
    assert.equal(firstFocusableRow([{ key: "hero", count: 0 }, ...rows.slice(1)]), 1);
    assert.equal(firstFocusableRow([{ key: "hero", count: 0, pending: true }, ...rows.slice(1)]), -1);
  });
});
