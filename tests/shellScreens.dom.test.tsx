import { cleanup, focused, press, render } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { App } from "../src/App";
import { CatalogueReadProvider } from "../src/discover/CatalogueReadContext";
import { liveTopBar } from "../src/shell/topBarFocus";
import { fakeCatalogue } from "./catalogueFake";

afterEach(cleanup);

/**
 * The two screens this slice opens for later ones. They are placeholders on purpose: a heading,
 * one sentence, and the shared bar. What they must not do is read anything, so the catalogue is
 * given to them and its requests are counted.
 */
const PLACEHOLDERS = [
  { path: "/catalog", heading: "Catalog", current: "Catalog" },
  { path: "/community", heading: "Community", current: "Community" },
] as const;

async function open(path: string) {
  const catalogue = fakeCatalogue();
  await render(<CatalogueReadProvider read={catalogue.read}><App /></CatalogueReadProvider>, path);
  return catalogue;
}

describe("the screens this slice opens", () => {
  for (const { path, heading, current } of PLACEHOLDERS) {
    it(`${path} says it is being built, under the shared bar, reading nothing`, async () => {
      const catalogue = await open(path);
      assert.equal(document.querySelectorAll("h1").length, 1);
      assert.equal(document.querySelector("h1")?.textContent, heading);
      assert.match(document.querySelector(".placeholder-layout p:not(.eyebrow)")?.textContent ?? "", /being built/i);
      assert.ok(liveTopBar(), "the shared top bar is on the screen");
      assert.equal(liveTopBar()!.querySelector('[aria-current="page"]')?.textContent, current);
      assert.deepEqual(catalogue.requests, [], "the screen reads no data");
    });

    it(`${path} lands a remote on its bar, and Back climbs to the home`, async () => {
      await open(path);
      assert.equal(focused().getAttribute("aria-current"), "page");
      assert.equal(focused().textContent, current);
      assert.equal(await press("Escape"), true);
      assert.equal(window.location.pathname, "/home");
    });
  }

  it("reaches both from the bar of another screen", async () => {
    await open("/home");
    for (const { path, current } of PLACEHOLDERS) {
      const item = Array.from(liveTopBar()!.querySelectorAll<HTMLAnchorElement>("a[data-top-bar-item]"))
        .find((link) => link.textContent?.trim() === current);
      assert.ok(item, `the bar has ${current}`);
      assert.equal(item.getAttribute("href"), path);
    }
  });
});
