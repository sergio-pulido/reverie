import assert from "node:assert/strict";
import { test } from "node:test";
import { interpret, tokenize, aliasMatch } from "../src/core/escape/intent";
import {
  applyOutcome,
  availableActions,
  resolveAction,
  resolveProposal,
  UNREADABLE_REASON,
} from "../src/core/escape/rules";
import { findScenario } from "../src/core/escape/scenarios";
import { goalReached, openScenario, readProgress, type EscapeState } from "../src/core/escape/state";
import { replay } from "./escapeSolver";

/**
 * The three outcomes, and the two invariants the whole design rests on: a
 * non-advancing outcome returns the very state it was given, and an advancing
 * one appends exactly one step to the log.
 */

const scenario = findScenario("night-audit");
assert.ok(scenario, "the night audit scenario ships");

function after(...actionIds: string[]): EscapeState {
  return replay(scenario!, actionIds);
}

test("words that reach nothing in this world are impossible, and change nothing", () => {
  const state = openScenario(scenario!);
  const outcome = resolveProposal(scenario!, state, "call the police and wait outside");
  assert.equal(outcome.kind, "impossible");
  assert.equal(outcome.kind === "impossible" && outcome.reason, UNREADABLE_REASON);
  assert.equal(applyOutcome(scenario!, state, outcome), state, "the same state object comes back");
});

test("a thing the room has not found yet cannot be named into existence", () => {
  const state = openScenario(scenario!);
  // The ledger is real, is in the stacks, and has not been revealed. Naming it
  // must read as meaningless rather than as "it is not here", which would
  // confirm that there is a ledger.
  const outcome = resolveProposal(scenario!, state, "take the sealed ledger");
  assert.equal(outcome.kind, "impossible");
  assert.equal(outcome.kind === "impossible" && outcome.reason, UNREADABLE_REASON);
});

test("a found thing addressed from another room says so, and changes nothing", () => {
  const state = after("open-hatch", "take-torch", "open-fuse-box", "throw-breaker", "light-torch", "enter-stacks");
  const outcome = resolveProposal(scenario!, state, "open the fuse box");
  assert.equal(outcome.kind, "impossible");
  assert.match(outcome.kind === "impossible" ? outcome.reason : "", /not here/);
  assert.equal(applyOutcome(scenario!, state, outcome), state);
});

test("an action whose requirement is unmet fails for the author's stated reason", () => {
  const state = openScenario(scenario!);
  const outcome = resolveProposal(scenario!, state, "push open the stack door");
  assert.equal(outcome.kind, "failed");
  assert.equal(
    outcome.kind === "failed" && outcome.reason,
    "The magnetic lock is still holding the door shut.",
  );
  assert.equal(applyOutcome(scenario!, state, outcome), state, "a failure is not a change");
});

test("an action that works advances the state and logs exactly one step", () => {
  const state = openScenario(scenario!);
  const outcome = resolveProposal(scenario!, state, "lift the counter hatch");
  assert.equal(outcome.kind, "advanced");
  const next = applyOutcome(scenario!, state, outcome);
  assert.notEqual(next, state);
  assert.deepEqual([...next.log], ["open-hatch"]);
  assert.equal(next.things["counter-hatch"].stateId, "open");
  assert.equal(next.things.torch.known, true, "the torch is found");
  assert.equal(state.things.torch.known, false, "the state it came from is untouched");
});

test("replaying a winning action is idempotent", () => {
  const once = after("open-hatch");
  const outcome = resolveProposal(scenario!, once, "open the counter hatch");
  assert.equal(outcome.kind, "failed", "the hatch is already up");
  const twice = applyOutcome(scenario!, once, outcome);
  assert.equal(twice, once);
  assert.deepEqual(twice, once);
});

test("every ordering of a solution reaches the same world", () => {
  const straight = after("open-hatch", "take-torch", "open-fuse-box");
  const swapped = after("open-fuse-box", "open-hatch", "take-torch");
  assert.deepEqual(straight.things, swapped.things);
  assert.equal(straight.at, swapped.at);
  assert.notDeepEqual([...straight.log], [...swapped.log], "the log keeps the order that happened");
});

test("the goal is reached only at the end of a run that actually happened", () => {
  const nearly = after(
    "open-hatch", "take-torch", "open-fuse-box", "throw-breaker", "light-torch",
    "enter-stacks", "wind-shelving", "take-ledger", "take-crowbar", "take-stair",
  );
  assert.equal(goalReached(scenario!, nearly), false);
  const outcome = resolveProposal(scenario!, nearly, "lever the roller door open with the crowbar");
  assert.equal(outcome.kind, "advanced");
  const out = applyOutcome(scenario!, nearly, outcome);
  assert.equal(goalReached(scenario!, out), true);
  assert.equal(out.log.length, 11);
});

test("the room cannot pry the door without the crowbar it never picked up", () => {
  const withoutBar = after(
    "open-hatch", "take-torch", "open-fuse-box", "throw-breaker", "light-torch",
    "enter-stacks", "wind-shelving", "take-ledger", "take-stair",
  );
  const outcome = resolveProposal(scenario!, withoutBar, "force the roller door");
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.kind === "failed" && outcome.reason, "The drop bolt will not move by hand.");
});

test("progress counts what is found and what is still shut, from the state", () => {
  const start = readProgress(scenario!, openScenario(scenario!));
  const shutAtStart = start.shut.map((thing) => thing.id).sort();
  assert.deepEqual(shutAtStart, ["counter-hatch", "stack-door"]);
  assert.equal(start.carrying.length, 0);

  const later = readProgress(scenario!, after("open-hatch", "take-torch"));
  assert.deepEqual(later.carrying.map((thing) => thing.name), ["the torch"]);
  assert.ok(later.found.some((thing) => thing.id === "torch"));
  assert.deepEqual(later.shut.map((thing) => thing.id), ["stack-door"]);
  assert.equal(later.stepsTaken, 2);
});

test("available actions are exactly the ones the rules would let through", () => {
  const state = openScenario(scenario!);
  const ids = availableActions(scenario!, state).map((action) => action.id);
  assert.deepEqual(ids, ["open-hatch", "open-fuse-box"]);
  for (const action of scenario!.actions) {
    const allowed = ids.includes(action.id);
    assert.equal(resolveAction(scenario!, state, action).kind === "advanced", allowed);
  }
});

test("matching is whole words, longest alias first", () => {
  assert.deepEqual(tokenize("Pry the roller-door, please!"), ["pry", "the", "roller", "door", "please"]);
  assert.equal(aliasMatch(tokenize("open the roller door"), "roller door"), 2);
  assert.equal(aliasMatch(tokenize("open the doorway"), "door"), 0, "a word inside a word is not a match");
  assert.equal(aliasMatch(tokenize("open it"), "counter hatch"), 0);
});

test("an empty proposal is unreadable rather than anything else", () => {
  const state = openScenario(scenario!);
  assert.deepEqual(interpret(scenario!, state, "   "), { kind: "unreadable" });
});

test("the same words resolve the same way every time", () => {
  const state = after("open-hatch", "take-torch");
  const first = resolveProposal(scenario!, state, "switch on the torch");
  const second = resolveProposal(scenario!, state, "switch on the torch");
  assert.deepEqual(first, second);
});

test("a room nobody has been in yet cannot be named, and appears in nothing", () => {
  const state = openScenario(scenario!);
  assert.equal(state.things["roller-door"].known, true, "the roller door is not hidden");
  assert.equal(state.things["roller-door"].seen, false, "but nobody has been to the bay");
  const outcome = resolveProposal(scenario!, state, "open the roller door");
  assert.equal(outcome.kind, "impossible");
  assert.equal(outcome.kind === "impossible" && outcome.reason, UNREADABLE_REASON);
  assert.equal(
    readProgress(scenario!, state).found.some((thing) => thing.id === "roller-door"),
    false,
  );
});

test("arriving somewhere is what puts its contents on the record", () => {
  const inTheBay = after(
    "open-hatch", "take-torch", "open-fuse-box", "throw-breaker", "light-torch",
    "enter-stacks", "wind-shelving", "take-stair",
  );
  assert.equal(inTheBay.things["roller-door"].seen, true);
  const progress = readProgress(scenario!, inTheBay);
  assert.ok(progress.found.some((thing) => thing.id === "roller-door"));
  assert.ok(progress.shut.some((thing) => thing.id === "roller-door"));
  assert.equal(progress.locationName, "the loading bay");
});

test("an instrument the author wrote a sentence about fails in the author's words", () => {
  const unarmed = after(
    "open-hatch", "take-torch", "open-fuse-box", "throw-breaker", "light-torch",
    "enter-stacks", "wind-shelving", "take-ledger", "take-stair",
  );
  const outcome = resolveProposal(scenario!, unarmed, "lever the roller door with the crowbar");
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.kind === "failed" && outcome.reason, "The drop bolt will not move by hand.");
});
