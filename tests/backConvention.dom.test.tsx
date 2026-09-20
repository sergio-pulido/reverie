import { cleanup, click, focusOn, focused, press, render, settle } from "./render";
import { scrollCalls } from "./dom";
import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import { afterEach, describe, it } from "node:test";
import { App } from "../src/App";
import type { CatalogueTitle } from "../src/catalogue/contract";
import { FilmPage } from "../src/discover/FilmPage";
import { InvitePanel } from "../src/screens/InvitePanel";
import { liveTopBar } from "../src/shell/topBarFocus";
import { useRemoteConventions } from "../src/shell/useRemoteConventions";

afterEach(cleanup);

const FROM = "reverie:from";
const inBar = () => focused().closest("[data-top-bar]") === liveTopBar() && liveTopBar() !== null;
const current = () => (inBar() ? focused().textContent : null);

/** Types into a field the way a keyboard does, so React sees the change. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
  await act(async () => {
    setter.call(field, text);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle(1);
}

describe("search", () => {
  const field = () => document.querySelector<HTMLInputElement>('.search-field input[type="search"]')!;

  it("goes up from its field, the first row of an empty conversation, into the top bar", async () => {
    await render(<App />, "/discover");
    assert.equal(focused(), field(), "the field has focus on arrival");
    assert.equal(await press("ArrowUp"), true);
    assert.equal(current(), "Discover");
  });

  it("clears what was typed with Escape first, and only then treats Escape as Back", async () => {
    await render(<App />, "/discover");
    await type(field(), "something light");
    assert.equal(await press("Escape"), true);
    assert.equal(field().value, "");
    assert.equal(focused(), field(), "clearing the field keeps focus in it");
    await press("Escape");
    assert.equal(current(), "Discover");
  });

  it("keeps Backspace for the field", async () => {
    await render(<App />, "/discover");
    await type(field(), "heist");
    assert.equal(await press("Backspace"), false);
    assert.equal(focused(), field());
  });

  it("returns from the voice control to the bar on Back", async () => {
    await render(<App />, "/discover");
    await focusOn(document.querySelector(".voice-control"));
    assert.equal(await press("Escape"), true);
    assert.equal(current(), "Discover");
  });

  it("leaves for the home when Back is pressed on the bar", async () => {
    await render(<App />, [{ path: "/home" }, { path: "/discover", state: { [FROM]: "/home" } }]);
    await press("Escape");
    assert.equal(await press("Escape"), true);
    await settle();
    assert.equal(window.location.pathname, "/home");
    assert.ok(document.querySelector(".home-shell"));
  });

  it("goes home even when search was the first page opened", async () => {
    await render(<App />, "/discover");
    await press("Escape");
    await press("Escape");
    assert.equal(window.location.pathname, "/home");
  });
});

describe("a film page", () => {
  it("opens with focus on the bar, so one Back closes it to search", async () => {
    await render(<App />, [{ path: "/discover" }, { path: "/discover/603", state: { [FROM]: "/discover" } }]);
    assert.equal(document.querySelectorAll('nav[aria-label="Primary"]').length, 2, "the search screen's bar is still there, underneath");
    assert.ok(liveTopBar()!.closest(".film-page"), "the live bar is the page's own");
    assert.equal(current(), "Discover");
    assert.equal(await press("Escape"), true);
    await settle();
    assert.equal(window.location.pathname, "/discover");
    assert.equal(document.querySelector(".film-page"), null);
  });

  it("reached by URL, closes to search by replacing itself", async () => {
    await render(<App />, "/discover/603");
    assert.equal(current(), "Discover");
    const entries = window.history.length;
    await press("Escape");
    await settle();
    assert.equal(window.location.pathname, "/discover");
    assert.equal(window.history.length, entries, "no entry was added");
    assert.equal(document.querySelector(".film-page"), null);
    assert.equal(focused().getAttribute("type"), "search", "the field takes focus once the page is uncovered");
  });

  it("closes the same way when its current destination is chosen, without adding history", async () => {
    await render(<App />, [{ path: "/home" }, { path: "/discover/603", state: { [FROM]: "/home" } }]);
    assert.equal(current(), "Home", "opened from the home, the home is where it returns");
    const entries = window.history.length;
    await click(focused());
    assert.equal(window.location.pathname, "/home");
    assert.equal(window.history.length, entries, "no entry was added");
    assert.equal(window.history.state?.[FROM], undefined, "this is the entry the film was opened from");
    assert.equal(document.querySelector(".film-page"), null);
    assert.equal(document.querySelector(".home-shell")!.hasAttribute("inert"), false);
  });

  const seed: CatalogueTitle = { id: "cat:603", title: "The Matrix", year: 1999, genres: ["Action"], availability: [], synopsis: "A hacker learns the truth." };

  function Page({ children }: { children: ReactNode }) {
    useRemoteConventions(() => true);
    return <>{children}</>;
  }

  it("walks from the bar into the page and back up, and Back inside it returns to the bar", async () => {
    const rejected: string[] = [];
    await render(
      <Page>
        <FilmPage providerId="603" seed={seed} origin="discover" attributionFallback="TMDB" onReject={(id) => rejected.push(id)} />
      </Page>,
      "/discover/603",
    );
    assert.equal(current(), "Discover");
    await press("ArrowDown");
    assert.equal(focused().textContent, "Not this one");
    assert.equal(await press("ArrowUp"), true);
    assert.equal(current(), "Discover", "Up from the first control reaches the bar");

    await press("ArrowDown");
    const layer = document.querySelector<HTMLElement>(".film-page")!;
    layer.scrollTop = 400;
    scrollCalls.length = 0;
    assert.equal(await press("Escape"), true);
    assert.equal(current(), "Discover");
    assert.equal(layer.scrollTop, 0, "the page scrolls back to its top");
    assert.deepEqual(scrollCalls, [], "the screen under the page keeps its place");
    assert.deepEqual(rejected, [], "Back never rejects the film");
  });

  it("offers no rejection when opened from the home, which has nothing to remove it from", async () => {
    await render(
      <Page>
        <FilmPage providerId="603" seed={seed} origin="home" attributionFallback="TMDB" />
      </Page>,
      "/discover/603",
    );
    assert.equal(current(), "Home");
    assert.equal(Array.from(document.querySelectorAll("button")).some((button) => button.textContent === "Not this one"), false);
    assert.match(document.querySelector(".discover-attribution")!.textContent!, /TMDB/);
  });
});

describe("the Movie Jam screens", () => {
  it("go up from the first field into the bar, and leave fields their own keys", async () => {
    await render(<App />, "/jams/new");
    await press("ArrowDown");
    const title = focused() as HTMLInputElement;
    assert.equal(title.tagName, "INPUT");

    assert.equal(await press("Backspace"), false, "Backspace edits the field");
    assert.equal(focused(), title);

    const premise = document.querySelector("textarea")!;
    await focusOn(premise);
    assert.equal(await press("ArrowUp"), false, "Up moves the caret in a text area");
    assert.equal(focused(), premise);
    await focusOn(document.querySelector('input[type="number"]'));
    assert.equal(await press("ArrowUp"), false, "Up steps a number");

    await focusOn(title);
    assert.equal(await press("ArrowUp"), true);
    assert.equal(current(), "Movie Jam");
  });

  it("answer Back from any field by focusing the bar", async () => {
    await render(<App />, "/jams/new");
    await focusOn(document.querySelector("textarea"));
    assert.equal(await press("Escape"), true);
    assert.equal(current(), "Movie Jam");
    assert.deepEqual(scrollCalls.at(-1), { top: 0 });
  });

  it("climb to their parents with repeated Back, never replaying screens already left", async () => {
    // The door, then the form: Back climbs form → door → home, never through the jam list.
    await render(<App />, [{ path: "/home" }, { path: "/create", state: { [FROM]: "/home" } }, { path: "/jams/new", state: { [FROM]: "/create" } }]);
    assert.equal(current(), "Movie Jam");
    await press("Escape");
    await settle();
    assert.equal(window.location.pathname, "/create");
    assert.equal(current(), "Movie Jam", "the door lands on its bar");
    await press("Escape");
    await settle();
    assert.equal(window.location.pathname, "/home");
  });

  it("never leave on a held Back", async () => {
    await render(<App />, [{ path: "/home" }, { path: "/jams", state: { [FROM]: "/home" } }]);
    assert.equal(current(), "Movie Jam");
    await press("Escape", { repeat: true });
    await settle();
    assert.equal(window.location.pathname, "/jams");
  });

  it("swallow a held OK, so it cannot press what the next screen focuses", async () => {
    await render(<App />, "/jams");
    assert.equal(await press("Enter", { repeat: true }), true);
    assert.equal(window.location.pathname, "/jams");
  });

  it("leave a held Enter or Space alone in a text field, where it is typing", async () => {
    await render(<App />, "/jams/new");
    await focusOn(document.querySelector("textarea"));
    assert.equal(await press("Enter", { repeat: true }), false);
    assert.equal(await press(" ", { repeat: true }), false);
  });

  it("close the invite panel on Back before anything else", async () => {
    let closed = 0;
    function Room() {
      useRemoteConventions(() => true);
      return <InvitePanel jamId="00000000-0000-0000-0000-000000000000" onClose={() => (closed += 1)} />;
    }
    await render(<Room />, "/jams/night-shift");
    await focusOn(document.querySelector(".invite-panel button"));
    assert.equal(await press("Escape"), true);
    assert.equal(closed, 1);
  });
});
