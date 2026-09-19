import { cleanup, click, focused, loseFocus, press, render } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { App } from "../src/App";
import type { Jam } from "../src/core/jam";
import { ScriptScreen } from "../src/ScriptScreen";
import { Studio } from "../src/screens/Studio";
import { liveTopBar } from "../src/shell/topBarFocus";
import { buildScript } from "./helpers";

afterEach(cleanup);

const FROM = "reverie:from";

/** What a viewer can see of the top bar on the current screen. */
function readBar() {
  const bars = Array.from(document.querySelectorAll<HTMLElement>('nav[aria-label="Primary"]'));
  const live = bars.filter((bar) => !bar.closest("[inert]"));
  assert.equal(live.length, 1, "exactly one top bar can be reached");
  const bar = live[0];
  const links = Array.from(bar.querySelectorAll<HTMLAnchorElement>("a[data-top-bar-item]"));
  return {
    bar,
    labels: links.map((link) => link.getAttribute("aria-label") ?? link.textContent?.trim()),
    current: links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent?.trim()),
    fields: bar.querySelectorAll("input, textarea, select").length,
  };
}

/**
 * Controls whose only purpose is going back, which a remote already has a key for, found by what a
 * viewer reads or a screen reader announces. "Leave the room" is a room action and is allowed.
 */
function backButtons() {
  return Array.from(document.querySelectorAll("button, a, [role='button'], [role='link']")).filter((control) => {
    const name = `${control.getAttribute("aria-label") ?? ""} ${control.textContent ?? ""}`.trim();
    return /^(←|back\b|go back|return\b|previous\b)|back to|all films|browse films/i.test(name);
  });
}

const screens: { name: string; at: string | { path: string; state?: unknown }[]; current: string }[] = [
  { name: "the home", at: "/home", current: "Home" },
  { name: "search", at: "/search", current: "Search" },
  { name: "a film page opened from search", at: [{ path: "/search" }, { path: "/discover/603", state: { [FROM]: "/search" } }], current: "Search" },
  { name: "a film page opened from the home", at: [{ path: "/home" }, { path: "/discover/603", state: { [FROM]: "/home" } }], current: "Home" },
  { name: "a film page reached by URL", at: "/discover/603", current: "Search" },
  { name: "the jam registry", at: "/jams", current: "Movie Jam" },
  { name: "the Movie Jam screen", at: "/jams/new", current: "Movie Jam" },
  { name: "joining a jam", at: "/join", current: "Movie Jam" },
  { name: "a jam's studio", at: "/jams/preview-night-shift", current: "Movie Jam" },
];

describe("the top bar", () => {
  for (const { name, at, current } of screens) {
    it(`is on ${name}, with every destination, no text field and no back button`, async () => {
      await render(<App />, at);
      const bar = readBar();
      assert.deepEqual(bar.labels, ["Home", "Search", "Movie Jam"]);
      assert.deepEqual(bar.current, [current]);
      assert.equal(bar.fields, 0, "the bar holds no text field");
      assert.deepEqual(backButtons(), []);
    });
  }

  it("is on the script screen", async () => {
    const jam = { id: "jam-1", source: { kind: "from-scratch", prompt: "A signal" }, format: { totalSeconds: 240, portionMinSeconds: 10, portionMaxSeconds: 20 }, script: buildScript() } as unknown as Jam;
    await render(<ScriptScreen jam={jam} roomTitle="Night shift" onStudio={() => undefined} />, "/jams/night-shift");
    assert.deepEqual(readBar().current, ["Movie Jam"]);
    assert.deepEqual(backButtons(), []);
  });

  it("is on a studio that cannot open, with no way back but the bar and the remote", async () => {
    await render(<Studio slug="night-shift" onLeave={() => undefined} />, "/jams/night-shift");
    assert.deepEqual(readBar().current, ["Movie Jam"]);
    assert.deepEqual(backButtons(), []);
  });

  it("puts the search field in the page, not in the chrome", async () => {
    await render(<App />, "/search");
    const search = document.querySelector('input[type="search"]');
    assert.ok(search, "search has its field");
    assert.equal(search.closest("[data-top-bar]"), null);
  });

  it("marks Search by its lens as well as its name", async () => {
    await render(<App />, "/home");
    const item = searchItem();
    assert.equal(item.getAttribute("href"), "/search");
    assert.ok(item.querySelector("svg[aria-hidden='true']"), "the lens is drawn and hidden from assistive technology");
  });
});

/** The bar's Search destination on the screen showing now. */
function searchItem() {
  const item = Array.from(liveTopBar()!.querySelectorAll<HTMLAnchorElement>("a[data-top-bar-item]")).find((link) => link.textContent?.trim() === "Search");
  assert.ok(item, "the bar has Search");
  return item;
}

describe("Search in the top bar", () => {
  it("opens search with its field focused", async () => {
    await render(<App />, "/home");
    await click(searchItem());
    assert.equal(window.location.pathname, "/search");
    assert.equal(focused().getAttribute("type"), "search");
  });

  it("on search, focuses the field where it is", async () => {
    await render(<App />, "/search");
    await click(searchItem());
    assert.equal(window.location.pathname, "/search");
    assert.equal(focused().getAttribute("type"), "search");
  });

  it("on a film page, closes it and focuses the search field", async () => {
    await render(<App />, [{ path: "/search" }, { path: "/discover/603", state: { [FROM]: "/search" } }]);
    await click(searchItem());
    assert.equal(window.location.pathname, "/search");
    assert.equal(document.querySelector(".film-page"), null, "the film page is closed");
    assert.equal(focused().getAttribute("type"), "search");
  });

  it("lands on the field when OK is pressed on it from another screen", async () => {
    await render(<App />, "/jams");
    await press("ArrowLeft");
    assert.equal(focused().textContent, "Search");
    assert.equal(await press("Enter"), true);
    assert.equal(window.location.pathname, "/search");
    assert.equal(focused().getAttribute("type"), "search");
  });
});

describe("remote focus on arrival", () => {
  it("lands a Movie Jam screen on its top bar, and Down enters the page", async () => {
    await render(<App />, "/jams/new");
    assert.equal(focused().getAttribute("aria-current"), "page");
    assert.equal(focused().textContent, "Movie Jam");
    await press("ArrowDown");
    assert.equal(focused().tagName, "INPUT", "the first field of the form, not the illustration");
  });

  it("gives a remote pressing into nothing the top bar", async () => {
    await render(<App />, "/search");
    await loseFocus();
    assert.equal(document.activeElement, document.body);
    assert.equal(await press("ArrowDown", { allowLost: true }), true);
    assert.equal(focused().closest("[data-top-bar]"), liveTopBar());
  });

  it("goes where OK is pressed on the bar", async () => {
    await render(<App />, "/jams");
    await press("ArrowLeft");
    await press("ArrowLeft");
    assert.equal(focused().textContent, "Home");
    assert.equal(await press("Enter"), true);
    assert.equal(window.location.pathname, "/home");
  });

  it("moves along the bar with Left and Right and stops at its ends", async () => {
    await render(<App />, "/jams");
    assert.equal(focused().textContent, "Movie Jam");
    await press("ArrowRight");
    assert.equal(focused().textContent, "Movie Jam", "Movie Jam is the last item");
    await press("ArrowLeft");
    assert.equal(focused().textContent, "Search");
    await press("ArrowLeft");
    assert.equal(focused().textContent, "Home");
    await press("ArrowLeft");
    assert.equal(focused().textContent, "Home", "Home is the first");
  });
});
