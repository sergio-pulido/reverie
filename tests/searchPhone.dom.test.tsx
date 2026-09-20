import { cards, field, openSearch, say } from "./searchScreen";
import { cleanup, click, focusOn, focused } from "./render";
import { declared, mediaMatches, stylesAt, widerThanScreen } from "./styleAt";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { keyboardInset } from "../src/search/useViewport";

/**
 * The search screen on a phone: a 360-pixel screen held in one hand, with a software keyboard
 * over its bottom half.
 *
 * The test document lays nothing out, so these tests do not claim to measure the page. They read
 * the real stylesheet at the phone's width and state what it tells the browser to draw — which
 * rows scroll sideways, what fills the screen, whether anything declares itself wider than the
 * screen — and they press and focus the page as a viewer would for everything that is behaviour.
 * The measured behaviour of a real browser at 360×800 and 390×844 is reported in the branch's
 * notes, not here.
 */

const SHEETS = ["src/search/search.css", "src/shell/shell.css"];
const PHONE = 360;
const TELEVISION = 1920;

/** A screen `width` pixels wide, as far as anything that asks a media query is concerned. */
function screenOf(width: number) {
  window.matchMedia = ((query: string) => ({
    matches: mediaMatches(query, width),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return stylesAt(SHEETS, width);
}

afterEach(async () => {
  await cleanup();
  delete (window as Partial<Window>).matchMedia;
});

const page = () => document.querySelector<HTMLElement>(".search-shell")!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe("the resting state on a phone", () => {
  it("stands high on the screen, where a keyboard cannot cover it, and the field takes focus", async () => {
    const styles = screenOf(PHONE);
    await openSearch();

    const stage = document.querySelector(".search-stage");
    assert.equal(declared(styles, stage, "justify-content"), "flex-start", "the resting block is not centred in the screen");
    assert.match(declared(styles, stage, "padding") ?? "", /^8dvh /, "its distance from the top is measured against what the screen actually shows");
    assert.equal(declared(styles, page(), "min-height"), "100dvh", "the page is as tall as the screen, not as tall as a hidden viewport");

    // A keyboard does not shrink the page, so what it covers is subtracted where the field docks.
    // Nothing else is subtracted: the TMDB credit is the page's own footer, below the stage.
    assert.equal(declared(styles, document.querySelector(".search-dock"), "bottom"), "var(--keyboard)");
    assert.equal(declared(styles, page(), "--keyboard"), "var(--search-keyboard,0px)", "nothing moves until the screen has read the visual viewport");

    assert.deepEqual(widerThanScreen(page(), styles, PHONE), [], "nothing on the resting screen is wider than the screen");

    await focusOn(field());
    assert.equal(focused(), field(), "the field takes focus");
    assert.equal(field().closest("[data-track]"), null, "and it is not inside a row that has to be scrolled to reach it");
    assert.equal(field().placeholder, "A film, or a mood…", "the phone's own invitation, short enough to be read whole");
    assert.equal(declared(styles, field(), "font-size"), "17px", "at least 16px, or a phone zooms the page when it is tapped");
  });

  it("keeps the television's longer invitation on a television", async () => {
    screenOf(TELEVISION);
    await openSearch();
    assert.equal(field().placeholder, "Name a film, or say what you’re in the mood for…");
  });
});

describe("a turn's row on a phone", () => {
  it("scrolls sideways under the finger instead of widening the page, and leaves the field reachable", async () => {
    const styles = screenOf(PHONE);
    await openSearch();
    await say("Inception");

    const track = document.querySelector(".search-track");
    assert.equal(cards(0).length, 12, "the turn still carries its films");
    assert.equal(declared(styles, track, "overflow-x"), "auto", "the row scrolls rather than pushing the page sideways");
    assert.equal(declared(styles, track, "overscroll-behavior-x"), "contain", "and a drag along it stays in it");
    assert.equal(declared(styles, track, "scroll-snap-type"), "x proximity");
    assert.equal(declared(styles, page(), "--card-width"), "132px", "two posters and the edge of a third, on a 360-pixel screen");

    assert.deepEqual(widerThanScreen(page(), styles, PHONE), [], "nothing outside the row is wider than the screen");

    await focusOn(field());
    assert.equal(focused(), field(), "the field is still reachable under a turn");
  });

  it("opens a preview from a card without a passing touch opening one", async () => {
    screenOf(PHONE);
    await openSearch();
    await say("Inception");
    const card = cards(0)[1];

    card.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerType: "touch" }));
    assert.equal(dialog(), null, "a finger passing over a card opens nothing: the dwell rule is for pointers");

    await click(card);
    assert.ok(dialog(), "pressing it does open the preview");
  });
});

describe("the preview on a phone", () => {
  async function openPreview(width: number) {
    const styles = screenOf(width);
    await openSearch();
    await say("Inception");
    const card = cards(0)[1];
    await click(card);
    return { styles, card };
  }

  it("fills the screen as a sheet, keeps both actions, and closes by thumb", async () => {
    const { styles, card } = await openPreview(PHONE);
    const sheet = dialog();
    assert.ok(sheet?.classList.contains("search-preview-sheet"), "the preview is drawn as a sheet");
    assert.equal(declared(styles, sheet, "height"), "var(--screen)", "as tall as the screen is, keyboard or no keyboard");
    assert.equal(declared(styles, sheet, "width"), "100%");
    assert.equal(declared(styles, document.querySelector(".search-overlay"), "place-items"), "end stretch", "it stands on the bottom of the screen");
    assert.equal(declared(styles, document.querySelector(".search-preview-body"), "overflow-y"), "auto", "its body is what scrolls");

    assert.deepEqual(
      Array.from(sheet!.querySelectorAll(".search-preview-actions button")).map((action) => action.textContent),
      ["Open the film page", "Start a Jam from this"],
      "both actions, and still nothing that plays the film",
    );
    assert.deepEqual(widerThanScreen(sheet!, styles, PHONE), [], "the sheet holds nothing wider than the screen");

    const close = sheet!.querySelector<HTMLButtonElement>(".search-preview-close");
    assert.equal(close?.getAttribute("aria-label"), "Close the preview", "a full-height sheet leaves no backdrop to press, so it carries a way out");
    await click(close);
    assert.equal(dialog(), null, "it closes");
    assert.equal(focused(), card, "and focus goes back to the card it opened from");
  });

  it("stays a centred dialog with no close control on a television", async () => {
    const { styles } = await openPreview(TELEVISION);
    const preview = dialog();
    assert.equal(preview?.classList.contains("search-preview-sheet"), false);
    assert.equal(preview?.querySelector(".search-preview-close"), null, "a remote closes it with Back and needs no control of its own");
    assert.equal(declared(styles, document.querySelector(".search-overlay"), "place-items"), "center");
  });
});

describe("what a keyboard covers, read from the visual viewport", () => {
  it("is what the screen has lost at the bottom of the page", () => {
    assert.equal(keyboardInset({ layoutHeight: 800, visibleHeight: 464, offsetTop: 0, scale: 1 }), 336);
    assert.equal(keyboardInset({ layoutHeight: 844, visibleHeight: 508, offsetTop: 0, scale: 1 }), 336);
  });

  it("counts what the page has scrolled under the keyboard as still covered", () => {
    assert.equal(keyboardInset({ layoutHeight: 800, visibleHeight: 464, offsetTop: 100, scale: 1 }), 236);
  });

  it("is nothing with no keyboard, and nothing a browser's own chrome explains", () => {
    assert.equal(keyboardInset({ layoutHeight: 800, visibleHeight: 800, offsetTop: 0, scale: 1 }), 0);
    assert.equal(keyboardInset({ layoutHeight: 800, visibleHeight: 760, offsetTop: 0, scale: 1 }), 0, "40px is a toolbar retracting, not a keyboard");
  });

  it("is nothing while the viewer has pinched in: a small visible area is not a keyboard", () => {
    assert.equal(keyboardInset({ layoutHeight: 800, visibleHeight: 400, offsetTop: 0, scale: 2 }), 0);
  });
});
