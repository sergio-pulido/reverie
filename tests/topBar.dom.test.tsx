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
  { name: "the home", at: "/", current: "Home" },
  { name: "Discover", at: "/discover", current: "Discover" },
  { name: "a film page opened from Discover", at: [{ path: "/discover" }, { path: "/discover/603", state: { [FROM]: "/discover" } }], current: "Discover" },
  { name: "a film page opened from the home", at: [{ path: "/" }, { path: "/discover/603", state: { [FROM]: "/" } }], current: "Home" },
  { name: "a film page reached by URL", at: "/discover/603", current: "Discover" },
  { name: "the jam registry", at: "/jams", current: "Movie Jam" },
  { name: "the Movie Jam screen", at: "/jams/new", current: "Movie Jam" },
  { name: "joining a jam", at: "/join", current: "Movie Jam" },
  { name: "a jam's studio", at: "/jams/preview-night-shift", current: "Movie Jam" },
];

describe("the top bar", () => {
  for (const { name, at, current } of screens) {
    it(`is on ${name}, with every destination, a search icon, no text field and no back button`, async () => {
      await render(<App />, at);
      const bar = readBar();
      assert.deepEqual(bar.labels, ["Home", "Discover", "Movie Jam", "Search"]);
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

  it("puts the Discover search field in the page, not in the chrome", async () => {
    await render(<App />, "/discover");
    const search = document.querySelector('input[type="search"]');
    assert.ok(search, "Discover has its search field");
    assert.equal(search.closest("[data-top-bar]"), null);
  });
});

describe("the search icon", () => {
  it("opens Discover with its search field focused", async () => {
    await render(<App />, "/");
    await click(document.querySelector('[data-top-bar] a[aria-label="Search"]'));
    assert.equal(window.location.pathname, "/discover");
    assert.equal(focused().getAttribute("type"), "search");
  });

  it("on Discover, focuses the field where it is", async () => {
    await render(<App />, "/discover");
    await click(document.querySelector('[data-top-bar] a[aria-label="Search"]'));
    assert.equal(window.location.pathname, "/discover");
    assert.equal(focused().getAttribute("type"), "search");
  });

  it("on a film page, closes it and focuses the Discover search", async () => {
    await render(<App />, [{ path: "/discover" }, { path: "/discover/603", state: { [FROM]: "/discover" } }]);
    await click(liveTopBar()!.querySelector('a[aria-label="Search"]'));
    assert.equal(window.location.pathname, "/discover");
    assert.equal(document.querySelector(".film-page"), null, "the film page is closed");
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
    await render(<App />, "/discover");
    await loseFocus();
    assert.equal(document.activeElement, document.body);
    assert.equal(await press("ArrowDown", { allowLost: true }), true);
    assert.equal(focused().closest("[data-top-bar]"), liveTopBar());
  });

  it("goes where OK is pressed on the bar", async () => {
    await render(<App />, "/jams");
    await press("ArrowLeft");
    assert.equal(focused().textContent, "Discover");
    assert.equal(await press("Enter"), true);
    assert.equal(window.location.pathname, "/discover");
  });

  it("moves along the bar with Left and Right and stops at its ends", async () => {
    await render(<App />, "/jams");
    assert.equal(focused().textContent, "Movie Jam");
    await press("ArrowRight");
    assert.equal(focused().getAttribute("aria-label"), "Search");
    await press("ArrowRight");
    assert.equal(focused().getAttribute("aria-label"), "Search");
    await press("ArrowLeft");
    await press("ArrowLeft");
    await press("ArrowLeft");
    await press("ArrowLeft");
    assert.equal(focused().textContent, "Home");
  });
});
