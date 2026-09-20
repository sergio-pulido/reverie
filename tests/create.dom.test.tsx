import { cleanup, click, render } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CreateScreen, type CreateWay } from "../src/create/CreateScreen";
import type { ScenarioCard } from "../src/lib/escapeRoom";

afterEach(cleanup);

/**
 * The one door. Making a film alone, making one with a room and playing an escape room are three
 * different experiences; the door offers all three, says what each is, and opens the flow that
 * already exists for it. The escape room's routes are the local Node server's, so where they are
 * absent the door says so rather than leading anywhere dead.
 */

const SCENARIOS: ScenarioCard[] = [
  { id: "night-audit", title: "The Night Audit", logline: "One sealed ledger.", characterName: "Marit Kessel", goal: "Get it out.", locationCount: 3 },
];

function ways() {
  return [...document.querySelectorAll<HTMLElement>(".create-way")];
}

function startButtons() {
  return [...document.querySelectorAll<HTMLButtonElement>(".create-way button")];
}

describe("the door at /create", () => {
  it("offers the three, each saying what the experience is", async () => {
    await render(<CreateScreen scenarios={SCENARIOS} scenariosNotice={null} onChoose={() => {}} />);
    assert.deepEqual(ways().map((card) => card.querySelector("h2")?.textContent), ["Director", "Movie Jam", "Escape Room"]);
    assert.deepEqual(ways().map((card) => card.querySelector(".eyebrow")?.textContent), ["Alone", "With people", "A room solves a place"]);
    for (const card of ways()) {
      const blurb = card.querySelector(".create-way-blurb")?.textContent ?? "";
      assert.ok(blurb.length > 80, "each says what it is, not just what it is called");
    }
  });

  it("reports which was chosen", async () => {
    const chosen: CreateWay[] = [];
    await render(<CreateScreen scenarios={SCENARIOS} scenariosNotice={null} onChoose={(way) => chosen.push(way)} />);
    for (const button of startButtons()) await click(button);
    assert.deepEqual(chosen, ["director", "jam", "escape"]);
  });

  it("says plainly when this deployment has no escape rooms, and still offers the other two", async () => {
    await render(<CreateScreen scenarios={[]} scenariosNotice="This server did not list any escape rooms." onChoose={() => {}} />);
    const escape = ways()[2];
    assert.equal(escape.querySelector("button"), null, "it leads nowhere rather than leading somewhere dead");
    const notice = escape.querySelector(".create-way-notice")?.textContent ?? "";
    assert.match(notice, /not available here/);
    assert.match(notice, /did not list any escape rooms/, "the server's own words");
    assert.match(notice, /Node server, which this deployment does not have/);
    assert.match(document.body.textContent ?? "", /Director and Movie Jam are unaffected/);
    assert.deepEqual(startButtons().length, 2, "the other two are still choosable");
  });

  it("waits, rather than claiming there are none, while the rooms are being read", async () => {
    await render(<CreateScreen scenarios={[]} scenariosNotice={null} onChoose={() => {}} />);
    assert.match(ways()[2].querySelector(".create-way-notice")?.textContent ?? "", /Looking for the rooms/);
    assert.doesNotMatch(document.body.textContent ?? "", /unaffected/, "nothing is concluded yet");
  });
});
