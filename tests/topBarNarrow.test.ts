import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Five destinations plus the account have to fit a 360px phone with no horizontal page scroll.
 * Nothing here has a layout engine — jsdom measures nothing — so this guards the CSS contract
 * that makes it fit, and the widths themselves were measured in a browser at 360px (recorded in
 * `docs/PROJECT_STATE.md`).
 *
 * The contract: the brand and the account are pinned, and the destinations take what is left. A
 * flex item will not shrink below its content unless `min-width: 0` says it may, so without that
 * line the strip would push the page wider than the screen instead of scrolling inside the bar.
 */
const SHELL_CSS = readFileSync(new URL("../src/shell/shell.css", import.meta.url), "utf8");

/** The declarations of the first rule for `selector`, as `{ property: value }`. */
function ruleFor(selector: string): Record<string, string> {
  const pattern = new RegExp(`(^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const match = SHELL_CSS.match(pattern);
  assert.ok(match, `shell.css has a rule for ${selector}`);
  return Object.fromEntries(
    match[2].split(";").map((line) => line.trim()).filter(Boolean).map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
}

describe("the top bar at 360px", () => {
  it("lets the destinations shrink and scroll inside the bar rather than widening the page", () => {
    const destinations = ruleFor(".top-bar-destinations");
    assert.equal(destinations["min-width"], "0", "without this the strip cannot shrink below its content");
    assert.equal(destinations["overflow-x"], "auto", "what does not fit scrolls inside the bar");
    assert.match(destinations["flex"] ?? "", /^1 1 /, "the strip takes the room the pinned items leave");
  });

  it("pins the brand and the account so the destinations never scroll over them", () => {
    assert.equal(ruleFor(".top-bar-brand").flex, "none");
    assert.equal(ruleFor(".top-bar-account").flex, "none");
    assert.equal(ruleFor(".top-bar-destinations > li").flex, "none", "a destination is never squashed to fit");
  });

  it("shrinks the bar's labels and the avatar on a phone", () => {
    const phone = SHELL_CSS.match(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/);
    assert.ok(phone, "there is a phone breakpoint");
    // The label, the lens, the brand's word and the circle all give up room at this width.
    for (const rule of [".top-bar-item", ".top-bar-search-icon", ".top-bar-brand-name", ".account-avatar"]) {
      assert.ok(phone[1].includes(rule), `${rule} is resized for a phone`);
    }
    assert.match(phone[1], /\.top-bar-brand-name \{ display: none; \}/, "the brand shrinks to its mark");
  });
});
