import assert from "node:assert/strict";
import { test } from "node:test";
import { SCENARIOS, findScenario, scenarioCards } from "../src/core/escape/scenarios";
import { scenarioSchema } from "../src/core/escape/scenario";
import { goalReached, openScenario, readProgress } from "../src/core/escape/state";
import { explore, replay, worldKey } from "./escapeSolver";

/**
 * Properties every shipped scenario must hold. These are about the data, not
 * about one puzzle: a scenario that fails any of them is a room that cannot
 * be finished, can be finished by accident, or lies to the progress panel.
 */

test("three scenarios ship, with distinct ids", () => {
  assert.equal(SCENARIOS.length, 3);
  assert.deepEqual(
    [...new Set(SCENARIOS.map((scenario) => scenario.id))].length,
    3,
  );
  for (const card of scenarioCards()) {
    assert.ok(findScenario(card.id), `${card.id} can be looked up`);
  }
  assert.equal(findScenario("no-such-room"), null);
});

test("a scenario naming a state that does not exist is refused", () => {
  const broken = {
    ...structuredClone(SCENARIOS[0]),
    goal: {
      ...SCENARIOS[0].goal,
      requires: [{ kind: "state", thingId: "torch", stateId: "molten", unmet: "The torch is not molten." }],
    },
  };
  const parsed = scenarioSchema.safeParse(broken);
  assert.equal(parsed.success, false);
});

for (const scenario of SCENARIOS) {
  test(`${scenario.id}: the goal does not hold at the start`, () => {
    assert.equal(goalReached(scenario, openScenario(scenario)), false);
  });

  test(`${scenario.id}: the goal is reachable, and only by playing into it`, () => {
    const { goals } = explore(scenario);
    assert.ok(goals.length > 0, "at least one reachable world satisfies the goal");
    for (const state of goals) {
      assert.ok(state.log.length > 0, "a goal world was played into, not started in");
      // Replaying only the steps that were logged reproduces the very same
      // world: nothing was reached that the transitions did not produce.
      assert.equal(worldKey(replay(scenario, state.log)), worldKey(state));
    }
  });

  test(`${scenario.id}: every step of a shortest solution is necessary`, () => {
    const { goals } = explore(scenario);
    const shortest = goals.reduce((best, state) => (state.log.length < best.log.length ? state : best));
    assert.ok(shortest.log.length >= 5, "a scenario worth playing takes several steps");
    for (let index = 0; index < shortest.log.length; index += 1) {
      const without = [...shortest.log.slice(0, index), ...shortest.log.slice(index + 1)];
      assert.equal(
        goalReached(scenario, replay(scenario, without)),
        false,
        `dropping ${shortest.log[index]} must not still reach the goal`,
      );
    }
  });

  test(`${scenario.id}: every location has a loop shot and every barrier a label`, () => {
    for (const location of scenario.locations) {
      assert.ok(location.loopShot.length >= 16, `${location.id} has a loop shot`);
    }
    const barriers = scenario.things.flatMap((thing) => thing.states.filter((state) => state.barrier));
    assert.ok(barriers.length > 0, "something in the room is shut");
    for (const state of barriers) assert.ok(state.label.length >= 2);
  });

  test(`${scenario.id}: progress starts honest and ends reached`, () => {
    const start = readProgress(scenario, openScenario(scenario));
    assert.equal(start.stepsTaken, 0);
    assert.equal(start.goalReached, false);
    assert.equal(start.locationId, scenario.startLocationId);
    for (const found of start.found) {
      const thing = scenario.things.find((candidate) => candidate.id === found.id);
      assert.equal(thing?.known, true, "only things declared known are listed at the start");
    }
    const { goals } = explore(scenario);
    const end = readProgress(scenario, goals[0]);
    assert.equal(end.goalReached, true);
    assert.equal(end.goalDescription, scenario.goal.description);
  });
}
