import { cleanup, click, render, focusOn, focused, press } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { CreateWay } from "../src/create/CreateScreen";
import { CreateRoom, type SourceKind } from "../src/screens/CreateRoom";
import type { ScenarioCard } from "../src/lib/escapeRoom";

afterEach(cleanup);

/**
 * The escape room is one of the three ways in, chosen at `/create` — the same registration
 * screen and the same room underneath, a different world.
 */

const SCENARIOS: ScenarioCard[] = [
  {
    id: "night-audit",
    title: "The Night Audit",
    logline: "One sealed ledger, one night, one building that has filed her as gone home.",
    characterName: "Marit Kessel",
    goal: "Get the sealed ledger out through the loading bay.",
    locationCount: 3,
  },
  {
    id: "cold-sill",
    title: "Cold Sill",
    logline: "One ascent bell and a rising wet porch.",
    characterName: "Ozan Rills",
    goal: "Send the core sample up in the ascent bell.",
    locationCount: 3,
  },
];

function show(overrides: {
  way?: CreateWay;
  sourceKind?: SourceKind;
  scenarioId?: string;
  scenarios?: ScenarioCard[];
  scenariosNotice?: string | null;
  onSourceKind?: (value: SourceKind) => void;
  onScenarioId?: (value: string) => void;
} = {}) {
  return <CreateRoom
    way={overrides.way ?? (overrides.sourceKind === "escape-room" ? "escape" : "jam")}
    title="Untitled Movie Jam"
    premise="A signal changes what the room thinks is possible."
    visibility="invite_only"
    sourceKind={overrides.sourceKind ?? "from-scratch"}
    importedScript=""
    scenarios={overrides.scenarios ?? SCENARIOS}
    scenarioId={overrides.scenarioId ?? ""}
    scenariosNotice={overrides.scenariosNotice ?? null}
    onScenarioId={overrides.onScenarioId ?? (() => {})}
    totalSeconds={20}
    portionMinSeconds={5}
    portionMaxSeconds={5}
    onTitle={() => {}}
    onPremise={() => {}}
    onVisibility={() => {}}
    onSourceKind={overrides.onSourceKind ?? (() => {})}
    onImportedScript={() => {}}
    onTotalSeconds={() => {}}
    onPortionMinSeconds={() => {}}
    onPortionMaxSeconds={() => {}}
    onSubmit={(event) => event.preventDefault()}
    isCreating={false}
    notice={null}
  />;
}

function sources(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[aria-label="Story source"] [role="radio"]')];
}

function submit(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(".form-submit")!;
}

describe("starting a jam from an escape room", () => {
  it("offers a written or an imported script, the escape room having its own door now", async () => {
    const chosen: SourceKind[] = [];
    await render(show({ onSourceKind: (value) => chosen.push(value) }));
    assert.deepEqual(sources().map((button) => button.textContent), ["From scratch", "Import a script"]);
    await click(sources()[1]);
    assert.deepEqual(chosen, ["import-script"]);
  });

  it("asks an escape room for no story source at all: the room is the story", async () => {
    await render(show({ way: "escape", sourceKind: "escape-room", scenarioId: "night-audit" }));
    assert.equal(document.querySelector('[aria-label="Story source"]'), null);
    assert.match(document.querySelector(".setup-intro .eyebrow")?.textContent ?? "", /ESCAPE ROOM/);
  });

  it("the picker lists the rooms the server named, and nothing else", async () => {
    const picked: string[] = [];
    await render(show({ sourceKind: "escape-room", onScenarioId: (id) => picked.push(id) }));
    const cards = [...document.querySelectorAll(".scenario-card")];
    assert.equal(cards.length, 2);
    assert.deepEqual(
      cards.map((card) => card.getAttribute("aria-label")),
      ["The Night Audit", "Cold Sill"],
      "a radio with no accessible name is announced as nothing",
    );
    assert.match(cards[0].textContent ?? "", /The Night Audit/);
    assert.match(cards[0].textContent ?? "", /Marit Kessel · 3 locations/);
    assert.match(cards[0].textContent ?? "", /Get the sealed ledger out/);
    await click(cards[1]);
    assert.deepEqual(picked, ["cold-sill"]);
  });

  it("an escape room asks for no script length, and no premise", async () => {
    await render(show({ sourceKind: "escape-room", scenarioId: "night-audit" }));
    assert.equal(document.querySelector(".format-row"), null);
    assert.equal(document.querySelector("textarea"), null);
    assert.equal(submit().textContent, "Open escape room↗");
    assert.equal(submit().disabled, false);
    assert.match(document.querySelector(".room-form .form-note")?.textContent ?? "", /rules resolve your actions/);
  });

  it("nothing can be opened until a room is chosen", async () => {
    await render(show({ sourceKind: "escape-room", scenarioId: "" }));
    assert.equal(submit().disabled, true);
  });

  it("a server that lists no rooms says so instead of offering an empty choice", async () => {
    await render(show({
      sourceKind: "escape-room",
      scenarios: [],
      scenariosNotice: "This server did not list any escape rooms.",
    }));
    assert.equal(document.querySelector(".scenario-card"), null);
    assert.match(document.body.textContent ?? "", /did not list any escape rooms/);
  });

  it("the other two sources are untouched", async () => {
    await render(show({ sourceKind: "from-scratch" }));
    assert.ok(document.querySelector(".format-row"), "a written script still has its length");
    assert.equal(submit().textContent, "Write shared screenplay↗");
    assert.match(document.querySelector(".room-form .form-note")?.textContent ?? "", /original screenplay/);
  });
});

for (const way of ["director", "jam", "escape"] as const) {
  it(`${way} keeps the shared chrome and traverses mode-specific fields`, async () => {
    await render(show({ way, sourceKind: way === "escape" ? "escape-room" : "from-scratch", scenarioId: "night-audit" }));
    assert.ok(document.querySelector("[data-top-bar]"));
    assert.ok(document.querySelector("footer"));
    assert.match(document.querySelector(".discover-attribution")?.textContent ?? "", /TMDB/);
    assert.ok(document.querySelector(`.setup-scene .mode-${way}`));
    assert.equal(Boolean(document.querySelector(".create-admission")), way !== "director");
    await focusOn(document.querySelector('[data-row="title"]'));
    await press("ArrowUp");
    assert.equal(focused().getAttribute("data-destination"), "create");
    await press("ArrowDown");
    assert.equal(focused().getAttribute("data-row"), "title");
    await press("ArrowDown");
    assert.equal(focused().getAttribute("data-row"), way === "escape" ? "scenario-night-audit" : "source");
    if (way !== "escape") {
      await press("ArrowRight");
      assert.equal(focused().getAttribute("data-index"), "1");
      await press("ArrowDown");
      assert.equal(focused().getAttribute("data-row"), "story");
      assert.equal(await press("ArrowLeft"), false, "horizontal arrows belong to the text caret");
      await press("ArrowUp");
      assert.equal(focused().getAttribute("data-index"), "1", "rows remember their last item");
    }
  });
}
it("import labels promise import, not generation", async () => {
  await render(show({ way: "director", sourceKind: "import-script" }));
  assert.equal(submit().textContent, "Import and open Director↗");
  assert.match(document.querySelector(".form-note")?.textContent ?? "", /imported screenplay/);
});
