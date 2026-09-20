import { cleanup, focused, press, render } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { App } from "../src/App";
import { CatalogueReadProvider } from "../src/discover/CatalogueReadContext";
import { COMMUNITY_PATH, HOME_PATH } from "../src/lib/routes";
import { liveTopBar } from "../src/shell/topBarFocus";
import { fakeCatalogue } from "./catalogueFake";

afterEach(cleanup);

/** Where the bar leads, and what each destination is called on it. */
const DESTINATIONS = [
  { path: "/home", current: "Home" },
  { path: "/discover", current: "Discover" },
  { path: "/catalog", current: "Catalog" },
  { path: "/create", current: "Create" },
  { path: "/jams", current: "Yours" },
] as const;

async function open(path: string) {
  const catalogue = fakeCatalogue();
  await render(<CatalogueReadProvider read={catalogue.read}><App /></CatalogueReadProvider>, path);
  return catalogue;
}

describe("the screens the shell opens", () => {
  it("reaches every destination from the bar of another screen", async () => {
    await open("/home");
    for (const { path, current } of DESTINATIONS) {
      const item = Array.from(liveTopBar()!.querySelectorAll<HTMLAnchorElement>("a[data-top-bar-item]"))
        .find((link) => link.textContent?.trim() === current);
      assert.ok(item, `the bar has ${current}`);
      assert.equal(item.getAttribute("href"), path);
    }
  });

  it("has no Community destination: what is made here is a shelf and a filter now", async () => {
    await open("/home");
    const labels = Array.from(liveTopBar()!.querySelectorAll<HTMLAnchorElement>("a[data-top-bar-item]")).map((link) => link.textContent?.trim());
    assert.deepEqual(labels, DESTINATIONS.map(({ current }) => current));
  });

  it("lands a shared /community link on the home, and says so in the URL", async () => {
    await open(COMMUNITY_PATH);
    assert.equal(window.location.pathname, HOME_PATH, "the link still lands");
    assert.equal(liveTopBar()!.querySelector('[aria-current="page"]')?.textContent, "Home");
  });

  it("lands a remote on the door's bar, and Back climbs to the home", async () => {
    await open("/create");
    assert.equal(focused().getAttribute("aria-current"), "page");
    assert.equal(focused().textContent, "Create");
    assert.equal(await press("Escape"), true);
    assert.equal(window.location.pathname, "/home");
  });
});
