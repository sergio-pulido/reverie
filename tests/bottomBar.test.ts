import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * On a phone the five destinations leave the top bar for a fixed bar along the bottom, where a
 * thumb is. It is the same list, the same items and the same keyboard handler — only `shell.css`
 * changes — so nothing here is about the markup: these guard the CSS contract that moves it, and
 * the contract that above the breakpoint nothing moves at all.
 *
 * jsdom measures nothing, so the widths themselves were checked in a browser at 390px and are
 * recorded in `docs/PROJECT_STATE.md`.
 */
const SHELL_CSS = readFileSync(new URL("../src/shell/shell.css", import.meta.url), "utf8");
const SEARCH_CSS = readFileSync(new URL("../src/search/search.css", import.meta.url), "utf8");
const DISCOVER_CSS = readFileSync(new URL("../src/discover/discover.css", import.meta.url), "utf8");

/** The declarations of the first rule for `selector`, as `{ property: value }`. */
function ruleFor(source: string, selector: string): Record<string, string> {
  // Comments are dropped first: one containing a semicolon would otherwise split a declaration.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const pattern = new RegExp(`(^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const match = css.match(pattern);
  assert.ok(match, `there is a rule for ${selector}`);
  return Object.fromEntries(
    match[2].split(";").map((line) => line.trim()).filter(Boolean).map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
}

/** The body of a `@media (max-width: <width>px)` block. */
function phoneBlock(css: string, width = 720): string {
  const match = css.match(new RegExp(`@media \\(max-width: ${width}px\\) \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `there is a ${width}px breakpoint`);
  return match[1];
}

const PHONE = phoneBlock(SHELL_CSS);

describe("above the phone breakpoint, nothing moves", () => {
  it("leaves the destinations in the top bar, in its flow", () => {
    const destinations = ruleFor(SHELL_CSS, ".top-bar-destinations");
    assert.equal(destinations.position, undefined, "they are not taken out of the bar");
    assert.equal(destinations["min-width"], "0", "without this the strip cannot shrink below its content");
    assert.equal(destinations["overflow-x"], "auto", "what does not fit scrolls inside the bar");
    assert.match(destinations.flex ?? "", /^1 1 /, "the strip takes the room the pinned items leave");
  });

  it("pins the brand and the account so the destinations never scroll over them", () => {
    assert.equal(ruleFor(SHELL_CSS, ".top-bar-brand").flex, "none");
    assert.equal(ruleFor(SHELL_CSS, ".top-bar-account").flex, "none");
    assert.equal(ruleFor(SHELL_CSS, ".top-bar-destinations > li").flex, "none", "a destination is never squashed to fit");
  });

  it("shows one mark only: Discover's lens, beside its name", () => {
    assert.equal(ruleFor(SHELL_CSS, ".top-bar-item-icon").display, "none");
    assert.equal(ruleFor(SHELL_CSS, '.top-bar-item[data-destination="discover"] .top-bar-item-icon').display, "block");
  });

  it("reserves nothing for a bottom bar there is none of", () => {
    assert.equal(SHELL_CSS.replace(PHONE, "").includes("--bottom-bar-space"), false, "the variable exists only on a phone");
    assert.equal(ruleFor(SEARCH_CSS, ".search-dock").bottom, "var(--keyboard)", "the dock clears the keyboard and nothing else");
  });
});

describe("on a phone the destinations become a bottom bar", () => {
  it("is fixed along the bottom, above the page, respecting the safe-area inset", () => {
    const bar = ruleFor(PHONE, ".top-bar-destinations");
    assert.equal(bar.position, "fixed");
    assert.equal(bar.bottom, "0");
    assert.equal(bar.left, "0");
    assert.equal(bar.right, "0");
    assert.match(bar.padding ?? "", /env\(safe-area-inset-bottom, 0px\)/, "it stands clear of the home indicator");
    assert.ok(Number(bar["z-index"]) > 5, "it draws over the page it is fixed to");
  });

  it("never sits over the composer: it slides down by whatever the keyboard covers", () => {
    const bar = ruleFor(PHONE, ".top-bar-destinations");
    assert.equal(bar.transform, "translateY(var(--search-keyboard, 0px))", "the screen's own reading of the visual viewport");
    // And the dock stands on whichever is taller, so the two are never both in that space.
    assert.equal(ruleFor(phoneBlock(SEARCH_CSS), ".search-dock").bottom, "max(var(--keyboard), var(--bottom-bar-space))");
  });

  it("hides the copy belonging to a screen a layer has made inert", () => {
    assert.match(PHONE, /\[inert\] \.top-bar-destinations \{ display: none; \}/);
  });

  it("gives every destination a mark and a short label, and every tab a thumb's height", () => {
    assert.match(PHONE, /\.top-bar-item-icon,\s*\n\s*\.top-bar-item\[data-destination="discover"\] \.top-bar-item-icon \{ display: block/);
    const item = ruleFor(PHONE, ".top-bar-item");
    assert.equal(item["flex-direction"], "column", "the mark over its label");
    assert.equal(item["min-height"], "var(--bottom-bar-height)");
    assert.match(ruleFor(PHONE, ":root")["--bottom-bar-height"] ?? "", /^5[0-9]px$/, "at least a thumb, and not a third of the screen");
  });

  it("draws Create as an action rather than a tab", () => {
    const create = ruleFor(PHONE, '.top-bar-item[data-destination="create"] .top-bar-item-icon');
    assert.equal(create["border-radius"], "999px");
    assert.ok(create.background, "it is filled, where the other four are outlines of themselves");
  });

  it("keeps its own height free under every page, the film page included", () => {
    assert.equal(ruleFor(PHONE, "body")["padding-bottom"], "var(--bottom-bar-space)");
    // A film page scrolls inside itself, so the page's padding never reaches it.
    assert.equal(ruleFor(phoneBlock(DISCOVER_CSS), ".film-page")["padding-bottom"], "var(--bottom-bar-space)");
  });

  it("leaves the top bar carrying the brand and the account, and nothing else", () => {
    // Nothing else is in the bar's markup, so what this pins is that neither is taken out of it.
    assert.equal(ruleFor(PHONE, ".top-bar-destinations").position, "fixed");
    assert.equal(ruleFor(PHONE, ".account-avatar").width, "40px", "the circle stays, sized for the width");
    assert.match(PHONE, /\.top-bar-brand-mark \{ font-size: 26px; \}/, "and so does the brand's mark");
  });
});
