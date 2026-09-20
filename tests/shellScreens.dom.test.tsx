import { cleanup, focused, press, render } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { App } from "../src/App";
import { CatalogueReadProvider } from "../src/discover/CatalogueReadContext";
import { liveTopBar } from "../src/shell/topBarFocus";
import { fakeCatalogue } from "./catalogueFake";

afterEach(cleanup);

/**
 * The screen the shell opened that is still a placeholder. Catalog was the other one and now
 * browses the catalogue (`catalog.dom.test.tsx`); Community is waiting for its own slice. What a
 * placeholder must not do is read anything, so the catalogue is given to it and its requests are
 * counted.
 */
const PLACEHOLDER = { path: "/community", heading: "Community", current: "Community" } as const;

/** Where the bar leads, and what each destination is called on it. */
const DESTINATIONS = [
  { path: "/home", current: "Home" },
  { path: "/discover", current: "Discover" },
  { path: "/catalog", current: "Catalog" },
  { path: "/jams", current: "Movie Jam" },
  { path: "/community", current: "Community" },
] as const;

async function open(path: string) {
  const catalogue = fakeCatalogue();
  await render(<CatalogueReadProvider read={catalogue.read}><App /></CatalogueReadProvider>, path);
  return catalogue;
}

describe("the screens the shell opens", () => {
  it(`${PLACEHOLDER.path} says it is being built, under the shared bar, reading nothing`, async () => {
    const catalogue = await open(PLACEHOLDER.path);
    assert.equal(document.querySelectorAll("h1").length, 1);
    assert.equal(document.querySelector("h1")?.textContent, PLACEHOLDER.heading);
    assert.match(document.querySelector(".placeholder-layout p:not(.eyebrow)")?.textContent ?? "", /being built/i);
    assert.ok(liveTopBar(), "the shared top bar is on the screen");
    assert.equal(liveTopBar()!.querySelector('[aria-current="page"]')?.textContent, PLACEHOLDER.current);
    assert.deepEqual(catalogue.requests, [], "the screen reads no data");
  });

  it(`${PLACEHOLDER.path} lands a remote on its bar, and Back climbs to the home`, async () => {
    await open(PLACEHOLDER.path);
    assert.equal(focused().getAttribute("aria-current"), "page");
    assert.equal(focused().textContent, PLACEHOLDER.current);
    assert.equal(await press("Escape"), true);
    assert.equal(window.location.pathname, "/home");
  });

  it("reaches every destination from the bar of another screen", async () => {
    await open("/home");
    for (const { path, current } of DESTINATIONS) {
      const item = Array.from(liveTopBar()!.querySelectorAll<HTMLAnchorElement>("a[data-top-bar-item]"))
        .find((link) => link.textContent?.trim() === current);
      assert.ok(item, `the bar has ${current}`);
      assert.equal(item.getAttribute("href"), path);
    }
  });
});
