import { cleanup, focusOn, focused, press, render, settle } from "./render";
import { scrollCalls } from "./dom";
import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import { afterEach, describe, it } from "node:test";
import { App } from "../src/App";
import { CatalogueReadProvider } from "../src/discover/CatalogueReadContext";
import { FilmPage } from "../src/discover/FilmPage";
import { liveTopBar } from "../src/shell/topBarFocus";
import { useRemoteConventions } from "../src/shell/useRemoteConventions";
import { fakeCatalogue } from "./catalogueFake";

afterEach(cleanup);

const FROM = "reverie:from";
const current = () => (focused().closest("[data-top-bar]") === liveTopBar() ? focused().textContent : null);
const rowOf = (element: Element) => `${element.getAttribute("data-row")}:${element.getAttribute("data-index")}`;

/** The whole app over a catalogue that always has films. */
async function openApp(at: string | { path: string; state?: unknown }[] = "/home") {
  const catalogue = fakeCatalogue();
  await render(
    <CatalogueReadProvider read={catalogue.read}>
      <App />
    </CatalogueReadProvider>,
    at,
  );
  return catalogue;
}

async function historyStep(step: () => void) {
  await act(async () => step());
  await settle();
}

describe("the app's home", () => {
  it("reads two shelves on opening and lands on the hero", async () => {
    const catalogue = await openApp("/home");
    assert.equal(catalogue.requests.length, 2);
    assert.deepEqual(catalogue.requests.map(({ pageSize, query }) => [pageSize, query]), [[12, ""], [12, ""]]);
    assert.equal(rowOf(focused()), "hero:0");
  });

  it("keeps the home mounted under a film opened from it, and returns focus to its card", async () => {
    await openApp("/home");
    const home = document.querySelector(".home-shell");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowRight");
    const opener = focused();
    assert.equal(opener.querySelector(".home-card-title")?.textContent, "Comedies 1");
    const entries = window.history.length;

    await press("Enter");
    assert.equal(window.location.pathname, "/discover/2002");
    assert.equal(document.querySelector(".home-shell"), home, "the same home, not a new one");
    assert.ok(home!.hasAttribute("inert"));
    assert.equal(current(), "Home", "the film names the home as where it came from");
    assert.equal(document.querySelector(".film-page h1")?.textContent, "Comedies 1");

    await press("Escape");
    await settle();
    assert.equal(window.location.pathname, "/home");
    assert.equal(document.querySelector(".home-shell"), home);
    assert.equal(home!.hasAttribute("inert"), false);
    assert.equal(focused(), opener, "focus is back on the card that opened the film");
    assert.equal(window.history.length, entries + 1, "closing stepped back instead of adding an entry");
  });

  it("is still the home under a film when it was served at another path", async () => {
    await openApp("/elsewhere");
    await press("ArrowDown");
    await press("Enter");
    assert.ok(document.querySelector(".home-shell")?.hasAttribute("inert"));
    assert.equal(current(), "Home");
  });

  it("never shows one film's details under another film's address", async () => {
    await openApp("/home");
    await press("ArrowDown");
    await press("Enter");
    const first = window.location.pathname;
    assert.equal(document.querySelector(".film-page h1")?.textContent, "Science fiction 1");

    // Leave the film for Movie Jam, come home with Back, open a second film and close it.
    await focusOn(liveTopBar()!.querySelectorAll<HTMLElement>("[data-top-bar-item]")[2]);
    await press("Enter");
    assert.equal(window.location.pathname, "/jams");
    await press("Escape");
    assert.equal(window.location.pathname, "/home");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("Enter");
    assert.equal(document.querySelector(".film-page h1")?.textContent, "Comedies 0");
    await press("Escape");
    await settle();

    // The browser's own Back reaches the first film again.
    await historyStep(() => window.history.back());
    assert.equal(window.location.pathname, first);
    assert.equal(document.querySelector(".film-page h1")?.textContent ?? null, null, "no title but its own, which has not loaded");
  });
});

describe("the app's Discover grid", () => {
  it("answers Back from a poster by scrolling to the top and focusing the bar", async () => {
    await openApp("/discover");
    assert.ok(focused().classList.contains("discover-card"), "the first poster has focus");
    await press("ArrowDown");
    await press("ArrowDown");
    scrollCalls.length = 0;
    assert.equal(await press("Escape"), true);
    assert.equal(current(), "Discover");
    assert.deepEqual(scrollCalls.at(-1), { top: 0 });
  });

  it("opens a poster with OK, but never with a held OK's repeats", async () => {
    await openApp("/discover");
    assert.equal(await press("Enter", { repeat: true }), true);
    assert.equal(window.location.pathname, "/discover", "a repeat opens nothing");
    await press("Enter");
    assert.match(window.location.pathname, /^\/discover\/\d+$/);
  });

  it("closes a film reopened with Forward to the grid, even after the grid's entry was replaced", async () => {
    await openApp("/discover");
    await press("Enter");
    const film = window.location.pathname;
    await historyStep(() => window.history.back());
    assert.equal(window.location.pathname, "/discover");

    // Back twice from the grid leaves Discover: its entry is replaced by the home.
    await press("Escape");
    await press("Escape");
    assert.equal(window.location.pathname, "/home");

    await historyStep(() => window.history.forward());
    assert.equal(window.location.pathname, film);
    assert.equal(current(), "Discover");
    await press("Escape");
    await settle();
    assert.equal(window.location.pathname, "/discover", "the grid, not the entry that replaced it");
  });
});

describe("a film page with nothing to act on", () => {
  function Page({ children }: { children: ReactNode }) {
    useRemoteConventions(() => true);
    return <>{children}</>;
  }

  it("still moves down the page when Down is pressed on its bar", async () => {
    await render(
      <Page>
        <FilmPage providerId="603" seed={{ id: "cat:603", title: "Plain", genres: [], availability: [] }} origin="home" attributionFallback="TMDB" />
      </Page>,
      [{ path: "/home" }, { path: "/discover/603", state: { [FROM]: "/home" } }],
    );
    const layer = document.querySelector<HTMLElement>(".film-page")!;
    Object.defineProperty(layer, "clientHeight", { configurable: true, value: 1000 });
    assert.equal(current(), "Home");
    assert.equal(await press("ArrowDown"), true);
    assert.equal(current(), "Home", "there is nothing to focus");
    assert.equal(layer.scrollTop, 600, "the page moved a step instead");
  });
});
