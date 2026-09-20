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

/** The bar's destinations, in the order a remote walks them. */
const DESTINATIONS = ["Home", "Discover", "Catalog", "Create", "Yours"];

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
  { name: "Discover", at: "/discover", current: "Discover" },
  { name: "a film page opened from search", at: [{ path: "/discover" }, { path: "/discover/603", state: { [FROM]: "/discover" } }], current: "Discover" },
  { name: "a film page opened from the home", at: [{ path: "/home" }, { path: "/discover/603", state: { [FROM]: "/home" } }], current: "Home" },
  { name: "a film page reached by URL", at: "/discover/603", current: "Discover" },
  { name: "the catalog", at: "/catalog", current: "Catalog" },
  { name: "the door", at: "/create", current: "Create" },
  { name: "Yours", at: "/jams", current: "Yours" },
  { name: "the jam form", at: "/jams/new", current: "Create" },
  { name: "joining a jam", at: "/join", current: "Yours" },
  { name: "a jam's studio", at: "/jams/preview-night-shift", current: "Yours" },
];

describe("the top bar", () => {
  for (const { name, at, current } of screens) {
    it(`is on ${name}, with every destination, no text field and no back button`, async () => {
      await render(<App />, at);
      const bar = readBar();
      assert.deepEqual(bar.labels, DESTINATIONS);
      assert.deepEqual(bar.current, [current]);
      assert.equal(bar.fields, 0, "the bar holds no text field");
      assert.deepEqual(backButtons(), []);
    });
  }

  it("is on the script screen", async () => {
    const jam = { id: "jam-1", source: { kind: "from-scratch", prompt: "A signal" }, format: { totalSeconds: 240, portionMinSeconds: 10, portionMaxSeconds: 20 }, script: buildScript() } as unknown as Jam;
    await render(<ScriptScreen jam={jam} roomTitle="Night shift" onStudio={() => undefined} />, "/jams/night-shift");
    assert.deepEqual(readBar().current, ["Yours"]);
    assert.deepEqual(backButtons(), []);
  });

  it("is on a studio that cannot open, with no way back but the bar and the remote", async () => {
    await render(<Studio slug="night-shift" onLeave={() => undefined} />, "/jams/night-shift");
    assert.deepEqual(readBar().current, ["Yours"]);
    assert.deepEqual(backButtons(), []);
  });

  it("puts the search field in the page, not in the chrome", async () => {
    await render(<App />, "/discover");
    const search = document.querySelector('input[type="search"]');
    assert.ok(search, "search has its field");
    assert.equal(search.closest("[data-top-bar]"), null);
  });

  it("marks Discover by its lens as well as its name", async () => {
    await render(<App />, "/home");
    const item = searchItem();
    assert.equal(item.getAttribute("href"), "/discover");
    assert.ok(item.querySelector("svg[aria-hidden='true']"), "the lens is drawn and hidden from assistive technology");
  });
});

/** The bar's Discover destination on the screen showing now. */
function searchItem() {
  const item = Array.from(liveTopBar()!.querySelectorAll<HTMLAnchorElement>("a[data-top-bar-item]")).find((link) => link.textContent?.trim() === "Discover");
  assert.ok(item, "the bar has Discover");
  return item;
}

describe("Discover in the top bar", () => {
  it("opens search with its field focused", async () => {
    await render(<App />, "/home");
    await click(searchItem());
    assert.equal(window.location.pathname, "/discover");
    assert.equal(focused().getAttribute("type"), "search");
  });

  it("on search, focuses the field where it is", async () => {
    await render(<App />, "/discover");
    await click(searchItem());
    assert.equal(window.location.pathname, "/discover");
    assert.equal(focused().getAttribute("type"), "search");
  });

  it("on a film page, closes it and focuses the search field", async () => {
    await render(<App />, [{ path: "/discover" }, { path: "/discover/603", state: { [FROM]: "/discover" } }]);
    await click(searchItem());
    assert.equal(window.location.pathname, "/discover");
    assert.equal(document.querySelector(".film-page"), null, "the film page is closed");
    assert.equal(focused().getAttribute("type"), "search");
  });

  it("lands on the field when OK is pressed on it from another screen", async () => {
    await render(<App />, "/jams");
    // Yours is the last of the five: Create, Catalog, Discover.
    for (let step = 0; step < 3; step += 1) await press("ArrowLeft");
    assert.equal(focused().textContent, "Discover");
    assert.equal(await press("Enter"), true);
    assert.equal(window.location.pathname, "/discover");
    assert.equal(focused().getAttribute("type"), "search");
  });
});

describe("remote focus on arrival", () => {
  it("lands the jam form on its top bar, and Down enters the page", async () => {
    await render(<App />, "/jams/new");
    assert.equal(focused().getAttribute("aria-current"), "page");
    assert.equal(focused().textContent, "Create");
    await press("ArrowDown");
    assert.equal(focused().tagName, "INPUT", "the first field of the form, not the illustration");
  });

  it("gives a remote pressing into nothing the top bar", async () => {
    await render(<App />, "/discover");
    await loseFocus();
    assert.equal(document.activeElement, document.body);
    assert.equal(await press("ArrowDown", { allowLost: true }), true);
    assert.equal(focused().closest("[data-top-bar]"), liveTopBar());
  });

  it("goes where OK is pressed on the bar", async () => {
    await render(<App />, "/jams");
    for (let step = 0; step < 4; step += 1) await press("ArrowLeft");
    assert.equal(focused().textContent, "Home");
    assert.equal(await press("Enter"), true);
    assert.equal(window.location.pathname, "/home");
  });

  it("moves along the bar with Left and Right and stops at its ends", async () => {
    await render(<App />, "/jams");
    assert.equal(focused().textContent, "Yours");
    await press("ArrowRight");
    // Past the last destination is the account, which is the bar's own trailing stop.
    assert.equal(focused().className, "account-avatar");
    await press("ArrowLeft");
    assert.equal(focused().textContent, "Yours");
    for (const label of ["Create", "Catalog", "Discover", "Home"]) {
      await press("ArrowLeft");
      assert.equal(focused().textContent, label);
    }
    await press("ArrowLeft");
    assert.equal(focused().textContent, "Home", "Home is the first");
  });
});
