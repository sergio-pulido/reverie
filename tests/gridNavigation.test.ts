import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gridMove, type GridPosition } from "../src/catalog/gridMove";

/** A 3-row grid of 4 columns with a short last row: indices 0–9. */
const grid = (index: number): GridPosition => ({ index, columns: 4, count: 10 });

/** Replays a remote's key presses, following focus moves the way the screen does. */
function press(keys: string[], start = 0) {
  let index = start;
  const intents = keys.map((key) => {
    const intent = gridMove(key, grid(index));
    if (intent?.kind === "focus") index = intent.index;
    return intent;
  });
  return { index, last: intents[intents.length - 1] };
}

describe("gridMove", () => {
  it("moves focus one poster per arrow press, across and between rows", () => {
    assert.deepEqual(gridMove("ArrowRight", grid(0)), { kind: "focus", index: 1 });
    assert.deepEqual(gridMove("ArrowLeft", grid(1)), { kind: "focus", index: 0 });
    assert.deepEqual(gridMove("ArrowDown", grid(1)), { kind: "focus", index: 5 });
    assert.deepEqual(gridMove("ArrowUp", grid(5)), { kind: "focus", index: 1 });
  });

  it("stops at the grid edges instead of wrapping", () => {
    assert.deepEqual(gridMove("ArrowLeft", grid(0)), { kind: "focus", index: 0 });
    assert.deepEqual(gridMove("ArrowRight", grid(9)), { kind: "focus", index: 9 });
  });

  it("lands on the last poster when the row below is short", () => {
    assert.deepEqual(gridMove("ArrowDown", grid(7)), { kind: "focus", index: 9 });
  });

  it("leaves the grid upwards from the top row and downwards from the bottom row", () => {
    assert.deepEqual(gridMove("ArrowUp", grid(2)), { kind: "exitTop" });
    assert.deepEqual(gridMove("ArrowDown", grid(9)), { kind: "exitBottom" });
    assert.deepEqual(gridMove("ArrowDown", grid(8)), { kind: "exitBottom" });
  });

  it("jumps to the row edges with Home and End", () => {
    assert.deepEqual(gridMove("Home", grid(6)), { kind: "focus", index: 4 });
    assert.deepEqual(gridMove("End", grid(4)), { kind: "focus", index: 7 });
    assert.deepEqual(gridMove("End", grid(8)), { kind: "focus", index: 9 });
  });

  it("opens the focused title with Enter, after arrows have moved focus", () => {
    const { index, last } = press(["ArrowRight", "ArrowRight", "ArrowDown", "Enter"]);
    assert.equal(index, 6);
    assert.deepEqual(last, { kind: "activate", index: 6 });
    assert.deepEqual(gridMove(" ", grid(3)), { kind: "activate", index: 3 });
  });

  it("returns with Escape or Back", () => {
    assert.deepEqual(gridMove("Escape", grid(3)), { kind: "back" });
    assert.deepEqual(gridMove("GoBack", grid(3)), { kind: "back" });
  });

  it("ignores other keys and empty grids", () => {
    assert.equal(gridMove("a", grid(3)), null);
    assert.equal(gridMove("ArrowRight", { index: 0, columns: 4, count: 0 }), null);
  });
});
