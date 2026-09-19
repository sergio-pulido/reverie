import { cleanup, click, focused, press, render } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { App } from "../src/App";
import { CatalogueReadProvider } from "../src/discover/CatalogueReadContext";
import { ViewerProvider } from "../src/shell/ViewerContext";
import { avatarColour } from "../src/shell/avatar";
import { liveTopBar, topBarItems } from "../src/shell/topBarFocus";
import type { Viewer, ViewerSource } from "../src/shell/viewer";
import { fakeCatalogue } from "./catalogueFake";

afterEach(cleanup);

const ADA = "8f2b1c44-6a2e-4b1f-9a7d-2c0e5f8a1b33";

/** The anonymous session the app signed this visitor in to, and a record of every sign-out. */
function fakeViewer(viewer: Viewer) {
  const signOuts: number[] = [];
  const source: ViewerSource = {
    observe(listener) {
      listener(viewer);
      return () => undefined;
    },
    async signOut() {
      signOuts.push(Date.now());
    },
  };
  return { source, signOuts };
}

async function open(viewer: Viewer, at = "/jams") {
  const seen = fakeViewer(viewer);
  const catalogue = fakeCatalogue();
  await render(
    <CatalogueReadProvider read={catalogue.read}>
      <ViewerProvider source={seen.source}><App /></ViewerProvider>
    </CatalogueReadProvider>,
    at,
  );
  return seen;
}

const avatar = () => liveTopBar()!.querySelector<HTMLButtonElement>(".account-avatar")!;
const menu = () => liveTopBar()!.querySelector<HTMLElement>('[role="menu"]');
const menuItems = () => Array.from(liveTopBar()!.querySelectorAll<HTMLElement>('[role="menuitem"]'));

/** Walks the bar to its trailing end the way a remote does, and answers where it stopped. */
async function walkRight(steps = 8) {
  for (let step = 0; step < steps; step += 1) await press("ArrowRight");
  return focused();
}

describe("the account avatar", () => {
  it("shows the viewer's initials in a colour derived from their Supabase user id", async () => {
    await open({ userId: ADA, displayName: "Ada Lovelace" });
    assert.equal(avatar().textContent, "AL");
    assert.equal(avatar().style.backgroundColor, hexToRgb(avatarColour(ADA)));
    assert.equal(avatar().getAttribute("aria-label"), "Account: Ada Lovelace");
  });

  it("draws the same colour for that id on a later visit", async () => {
    await open({ userId: ADA, displayName: "Ada Lovelace" });
    const first = avatar().style.backgroundColor;
    await open({ userId: ADA, displayName: "Ada Lovelace" }, "/home");
    assert.equal(avatar().style.backgroundColor, first, "the colour is derived from the id, not stored");
  });

  it("draws a different viewer differently", async () => {
    await open({ userId: ADA, displayName: "Ada Lovelace" });
    const first = avatar().style.backgroundColor;
    await open({ userId: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9", displayName: "Grace Hopper" });
    assert.notEqual(avatar().style.backgroundColor, first);
    assert.equal(avatar().textContent, "GH");
  });

  it("shows a neutral mark and no initials when the viewer has given no name", async () => {
    await open({ userId: ADA, displayName: null });
    assert.equal(avatar().textContent, "", "no initials are guessed");
    assert.ok(avatar().querySelector(".account-avatar-neutral"), "a neutral mark instead");
    assert.equal(avatar().getAttribute("aria-label"), "Account", "no name, email or photo is invented");
  });

  it("is the last stop on the bar's Left and Right axis", async () => {
    await open({ userId: ADA, displayName: "Ada Lovelace" });
    assert.equal(await walkRight(), avatar(), "Right from the last destination reaches the avatar and stops there");
    assert.equal(topBarItems(liveTopBar()!).at(-1), avatar());
    await press("ArrowLeft");
    assert.equal(focused().textContent, "Community", "Left goes back to the last destination");
  });
});

describe("the account menu", () => {
  it("opens on OK with the display name above Account and Log out, and focus inside it", async () => {
    await open({ userId: ADA, displayName: "Ada Lovelace" });
    await walkRight();
    assert.equal(await press("Enter"), true);
    assert.equal(avatar().getAttribute("aria-expanded"), "true");
    assert.equal(menu()!.querySelector(".account-menu-name")?.textContent, "Ada Lovelace");
    assert.deepEqual(menuItems().map((item) => item.textContent), ["Account", "Log out"]);
    assert.equal(focused(), menuItems()[0]);
  });

  it("says 'Signed in' when there is no name to show", async () => {
    await open({ userId: ADA, displayName: null });
    await click(avatar());
    assert.equal(menu()!.querySelector(".account-menu-name")?.textContent, "Signed in");
  });

  it("moves through its items with Up and Down, and stops at its ends", async () => {
    await open({ userId: ADA, displayName: "Ada Lovelace" });
    await click(avatar());
    assert.equal(focused().textContent, "Account");
    assert.equal(await press("ArrowUp"), true);
    assert.equal(focused().textContent, "Account", "Account is the first item");
    await press("ArrowDown");
    assert.equal(focused().textContent, "Log out");
    await press("ArrowDown");
    assert.equal(focused().textContent, "Log out", "Log out is the last item");
    await press("ArrowUp");
    assert.equal(focused().textContent, "Account");
  });

  for (const key of ["Escape", "GoBack", "Backspace"]) {
    it(`closes on ${key} and returns focus to the avatar`, async () => {
      await open({ userId: ADA, displayName: "Ada Lovelace" });
      await click(avatar());
      await press("ArrowDown");
      assert.equal(await press(key), true, "the key is taken by the menu, not by the screen behind it");
      assert.equal(menu(), null);
      assert.equal(avatar().getAttribute("aria-expanded"), "false");
      assert.equal(focused(), avatar());
      // Closing the menu did not also leave the screen.
      assert.equal(window.location.pathname, "/jams");
    });
  }

  it("traps focus while it is open", async () => {
    await open({ userId: ADA, displayName: "Ada Lovelace" });
    await click(avatar());
    // Tab cycles inside the menu instead of walking out into the bar or the page.
    for (const expected of ["Log out", "Account", "Log out"]) {
      assert.equal(await press("Tab"), true);
      assert.equal(focused().textContent, expected);
    }
    assert.equal(await press("Tab", { shiftKey: true }), true);
    assert.equal(focused().textContent, "Account");
    // The bar's own axis does not run underneath the open menu either.
    assert.equal(await press("ArrowRight"), true);
    assert.equal(focused().textContent, "Account");
    assert.ok(menu(), "the menu is still open");
  });

  it("has an Account item that is focusable and deliberately does nothing yet", async () => {
    const seen = await open({ userId: ADA, displayName: "Ada Lovelace" });
    await click(avatar());
    const account = menuItems()[0];
    assert.equal(document.activeElement, account, "it is focusable, and a remote lands on it");
    await click(account);
    assert.equal(window.location.pathname, "/jams", "it goes nowhere");
    assert.deepEqual(seen.signOuts, [], "and it signs nobody out");
    assert.ok(menu(), "the menu is still open");
  });

  it("signs out for real on Log out and lands on /", async () => {
    const seen = await open({ userId: ADA, displayName: "Ada Lovelace" });
    await click(avatar());
    await press("ArrowDown");
    assert.equal(focused().textContent, "Log out");
    assert.equal(await press("Enter"), true);
    assert.equal(seen.signOuts.length, 1, "Supabase is asked to end the anonymous session");
    assert.equal(window.location.pathname, "/");
  });
});

/** The style attribute reads back as `rgb(...)`, which is what a browser stores. */
function hexToRgb(hex: string) {
  const [red, green, blue] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${red}, ${green}, ${blue})`;
}
