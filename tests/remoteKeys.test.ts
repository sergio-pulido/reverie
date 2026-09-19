import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Screen } from "../src/lib/routes";
import { backAction, isBackKey, leaveAction, parentPath } from "../src/shell/keys";

describe("isBackKey", () => {
  it("knows a remote's Back by name and by the codes TV sets send without a usable name", () => {
    for (const key of ["Escape", "GoBack", "BrowserBack", "XF86Back"]) assert.equal(isBackKey(key), true, key);
    assert.equal(isBackKey("Unidentified", false, 461), true, "a set that sends only 461");
    assert.equal(isBackKey("Unidentified", false, 10009), true, "a set that sends only 10009");
    assert.equal(isBackKey("Unidentified", false, 10182), false, "an Exit key is not Back");
    assert.equal(isBackKey("ArrowUp"), false);
  });

  it("treats Backspace as Back only outside a text field", () => {
    assert.equal(isBackKey("Backspace", false), true);
    assert.equal(isBackKey("Backspace", true), false);
  });
});

describe("backAction", () => {
  const press = (overrides: Partial<Parameters<typeof backAction>[0]>) =>
    backAction({ key: "Escape", editable: false, handled: false, inTopBar: false, ...overrides });

  it("returns to the top bar from anywhere on a page, and leaves from the bar", () => {
    assert.equal(press({}), "focus-top-bar");
    assert.equal(press({ inTopBar: true }), "leave");
  });

  it("stands aside when the page has already taken the press", () => {
    assert.equal(press({ handled: true }), null);
    assert.equal(press({ key: "Backspace", editable: true }), null);
    assert.equal(press({ key: "Enter" }), null);
  });

  it("never leaves on a held Back, only on a fresh press", () => {
    assert.equal(press({ inTopBar: true, repeat: true }), null);
    assert.equal(press({ repeat: true }), "focus-top-bar");
  });
});

describe("leaving a screen", () => {
  it("climbs to each screen's parent and stops at the home", () => {
    const parents: [Screen, string | null][] = [
      ["landing", null],
      ["home", null],
      ["discover", "/home"],
      ["jams", "/home"],
      ["join", "/home"],
      ["create", "/jams"],
      ["studio", "/jams"],
      ["script", "/jams/new"],
    ];
    for (const [screen, parent] of parents) assert.equal(parentPath(screen, false, "/somewhere"), parent, screen);
  });

  it("closes a film page to wherever it was opened from, or to the grid when reached by URL", () => {
    assert.equal(parentPath("discover", true, "/home"), "/home");
    assert.equal(parentPath("discover", true, "/discover"), "/discover");
    assert.equal(parentPath("discover", true, null), "/discover");
  });

  it("steps back through history only when the entry behind is the parent", () => {
    assert.deepEqual(leaveAction({ screen: "discover", filmOpen: false, from: "/home" }), { kind: "history-back" });
    assert.deepEqual(leaveAction({ screen: "discover", filmOpen: true, from: "/home" }), { kind: "history-back" });
    assert.deepEqual(leaveAction({ screen: "create", filmOpen: false, from: "/jams" }), { kind: "history-back" });
  });

  it("replaces the entry instead of replaying screens the viewer has left", () => {
    // Discover, then Movie Jam, then Discover again: Back goes home, not through Movie Jam.
    assert.deepEqual(leaveAction({ screen: "discover", filmOpen: false, from: "/jams" }), { kind: "replace", path: "/home" });
    assert.deepEqual(leaveAction({ screen: "create", filmOpen: false, from: "/home" }), { kind: "replace", path: "/jams" });
    assert.deepEqual(leaveAction({ screen: "discover", filmOpen: true, from: null }), { kind: "replace", path: "/discover" });
  });

  it("replaces instead of stepping back once the entry behind has itself been replaced", () => {
    assert.deepEqual(leaveAction({ screen: "discover", filmOpen: true, from: "/discover", behindIntact: false }), { kind: "replace", path: "/discover" });
    assert.deepEqual(leaveAction({ screen: "jams", filmOpen: false, from: "/home", behindIntact: false }), { kind: "replace", path: "/home" });
  });

  it("leaves Back on the home to the platform", () => {
    assert.equal(leaveAction({ screen: "home", filmOpen: false, from: "/discover" }), null);
    assert.equal(leaveAction({ screen: "home", filmOpen: false, from: null }), null);
  });
});
