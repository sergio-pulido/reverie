import { jamOf, openDirector, type FakeServer } from "./directorScreen";
import { cleanup } from "./render";
import { declared, stylesAt, widerThanScreen } from "./styleAt";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildScript } from "./helpers";

/**
 * The three widths the Director session is drawn for: a 1920 television, a
 * 1440 laptop, and a 390 phone.
 *
 * The test document lays nothing out, so nothing here claims to have measured
 * the page. It reads the real stylesheet at each width and states what it
 * tells the browser to do — how many columns, which row scrolls sideways,
 * whether anything declares itself wider than the screen it is on. What a real
 * browser did at these widths is in the branch's notes, not here.
 */

const SHEETS = ["src/director/director.css", "src/styles.css", "src/shell/shell.css"];
const TELEVISION = 1920;
const LAPTOP = 1440;
const PHONE = 390;

let server: FakeServer | null = null;

afterEach(async () => {
  await cleanup();
  server?.restore();
  server = null;
  window.localStorage.clear();
});

const shell = () => document.querySelector<HTMLElement>(".director-shell")!;
const one = (selector: string) => document.querySelector<HTMLElement>(selector);

describe("a desk, at 1920 and at 1440", () => {
  for (const width of [TELEVISION, LAPTOP]) {
    it(`${width}: the stage and its timeline take the width, the direction column keeps its measure`, async () => {
      server = await openDirector();
      const styles = stylesAt(SHEETS, width);
      const columns = declared(styles, one(".director-grid"), "grid-template-columns");
      assert.ok(columns?.includes("clamp("), `${width} gives the direction column a measure of its own`);
      assert.match(columns!, /minmax\(0, ?1fr\)/, "the stage column may shrink to nothing rather than push");
      assert.deepEqual(widerThanScreen(shell(), styles, width), []);
    });
  }

  it("the frame gives up height before the mode switch and the timeline leave the screen", async () => {
    server = await openDirector();
    const styles = stylesAt(SHEETS, TELEVISION);
    assert.equal(declared(styles, one(".director-frame"), "max-height"), "min(44vh, 520px)");
    assert.equal(declared(styles, one(".director-frame"), "aspect-ratio"), "16 / 9");
  });

  it("the composer never puts three controls on one row, because its column is always narrow", async () => {
    server = await openDirector();
    for (const width of [TELEVISION, LAPTOP, PHONE]) {
      const styles = stylesAt(SHEETS, width);
      assert.equal(
        declared(styles, one(".director-composer-row"), "grid-template-columns"),
        "auto minmax(0, 1fr) auto",
        `${width}`,
      );
      assert.equal(declared(styles, one(".director-send"), "grid-column"), "1 / -1", `${width}`);
    }
  });
});

describe("a phone, at 390", () => {
  it("stacks the three zones and keeps the composer in reach of a thumb", async () => {
    server = await openDirector();
    const styles = stylesAt(SHEETS, PHONE);
    assert.equal(declared(styles, one(".director-grid"), "grid-template-columns"), "1fr");
    assert.equal(declared(styles, one(".director-composer"), "position"), "sticky");
    assert.equal(declared(styles, one(".director-composer"), "bottom"), "0px");
  });

  it("nothing on the screen declares itself wider than the screen", async () => {
    server = await openDirector();
    assert.deepEqual(widerThanScreen(shell(), stylesAt(SHEETS, PHONE), PHONE), []);
  });

  it("the beats run off the edge and keep a sideways drag to themselves", async () => {
    server = await openDirector();
    const styles = stylesAt(SHEETS, PHONE);
    assert.equal(declared(styles, one(".director-beats"), "overflow-x"), "auto");
    assert.equal(declared(styles, one(".director-beats"), "touch-action"), "pan-x");
    assert.equal(declared(styles, one(".director-beats"), "overscroll-behavior-x"), "contain");
    // A beat keeps a readable width instead of being divided into a sliver.
    assert.equal(declared(styles, one(".director-beat"), "width"), "132px");
  });

  it("the mode switch takes the full width rather than halving two labels", async () => {
    server = await openDirector();
    assert.equal(
      declared(stylesAt(SHEETS, PHONE), one(".director-modes"), "grid-template-columns"),
      "1fr",
    );
  });
});

describe("whatever the width", () => {
  it("a zone never grows to fit its own row of beats", async () => {
    // Without this the timeline sets the column's width, the column grows past
    // its track, and the shell clips it — so beats are lost rather than scrolled to.
    server = await openDirector();
    for (const width of [TELEVISION, LAPTOP, PHONE]) {
      const styles = stylesAt(SHEETS, width);
      assert.equal(declared(styles, one(".director-timeline"), "min-width"), "0px", `${width}`);
      assert.equal(declared(styles, one(".director-directions"), "min-width"), "0px", `${width}`);
    }
  });

  it("twenty-four beats do not make the page wider than the screen", async () => {
    server = await openDirector({ jam: jamOf(buildScript(5, 4, 6)) });
    assert.equal(document.querySelectorAll(".director-beat").length, 24);
    for (const width of [TELEVISION, LAPTOP, PHONE]) {
      assert.deepEqual(widerThanScreen(shell(), stylesAt(SHEETS, width), width), [], `${width}`);
    }
  });
});
