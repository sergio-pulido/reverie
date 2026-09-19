import { cleanup, click, render } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CreateRoom, type SourceKind } from "../src/screens/CreateRoom";
import type { ScenarioCard } from "../src/lib/escapeRoom";

afterEach(cleanup);

/**
 * The escape room is a third source beside starting from scratch and
 * importing a script — the same screen, the same room, a different world.
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
  sourceKind?: SourceKind;
  scenarioId?: string;
  scenarios?: ScenarioCard[];
  scenariosNotice?: string | null;
  onSourceKind?: (value: SourceKind) => void;
  onScenarioId?: (value: string) => void;
} = {}) {
  return <CreateRoom
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
  return [...document.querySelectorAll<HTMLElement>('.jam-kind [role="radio"]')];
}

function submit(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(".form-submit")!;
}

describe("starting a jam from an escape room", () => {
  it("offers three sources, and asking for the third says so", async () => {
    const chosen: SourceKind[] = [];
    await render(show({ onSourceKind: (value) => chosen.push(value) }));
    assert.deepEqual(sources().map((button) => button.textContent), [
      "From scratch",
      "Import a script",
      "Escape room",
    ]);
    await click(sources()[2]);
    assert.deepEqual(chosen, ["escape-room"]);
  });

  it("the picker lists the rooms the server named, and nothing else", async () => {
    const picked: string[] = [];
    await render(show({ sourceKind: "escape-room", onScenarioId: (id) => picked.push(id) }));
    const cards = [...document.querySelectorAll(".scenario-card")];
    assert.equal(cards.length, 2);
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
    assert.equal(submit().textContent, "Open the room↗");
    assert.equal(submit().disabled, false);
    assert.match(document.querySelector(".room-form .form-note")?.textContent ?? "", /written into this repository/);
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
    assert.equal(submit().textContent, "Write the script↗");
    assert.match(document.querySelector(".room-form .form-note")?.textContent ?? "", /never a copy of an existing film/);
  });
});
