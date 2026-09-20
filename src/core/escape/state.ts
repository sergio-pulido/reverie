import type { Condition, Scenario, Thing } from "./scenario";

/**
 * The scenario's state, and the only record of how it got there.
 *
 * Every field is readonly and every transition returns a new value: this is
 * the artifact a whole room reasons about, and a mutation anywhere would mean
 * two participants could be told different things about the same world.
 *
 * `log` is the load-bearing part. It holds the ids of the actions that
 * actually advanced the world, in order, so the goal can never be reached by
 * a state that was assembled rather than played into.
 */

export interface ThingState {
  readonly stateId: string;
  readonly carried: boolean;
  /** Whether it exists as far as this scenario is concerned: not hidden. */
  readonly known: boolean;
  /**
   * Whether the character has actually been in a position to see it.
   *
   * Distinct from `known`, and the difference matters twice. The progress
   * panel lists what the room has *found*, so a door two rooms away must not
   * appear in it before anybody has been there; and a proposal can only name
   * what has been seen, so guessing a word cannot confirm that the thing it
   * names is in the building. Once true it stays true.
   */
  readonly seen: boolean;
}

export interface EscapeState {
  readonly scenarioId: string;
  readonly at: string;
  readonly things: Readonly<Record<string, ThingState>>;
  /** Action ids, in the order they advanced the world. */
  readonly log: readonly string[];
}

export function openScenario(scenario: Scenario): EscapeState {
  const things: Record<string, ThingState> = {};
  for (const thing of scenario.things) {
    things[thing.id] = {
      stateId: thing.initialStateId,
      carried: thing.carried,
      known: thing.known,
      seen: false,
    };
  }
  return {
    scenarioId: scenario.id,
    at: scenario.startLocationId,
    things: observe(scenario, scenario.startLocationId, things),
    log: [],
  };
}

/**
 * Marks everything the character can see from where they now stand.
 *
 * Run after every transition, so arriving in a room is what puts its contents
 * on the record — nothing else has to remember to. Monotonic: leaving a room
 * does not unsee it.
 */
export function observe(
  scenario: Scenario,
  at: string,
  things: Readonly<Record<string, ThingState>>,
): Record<string, ThingState> {
  const observed: Record<string, ThingState> = { ...things };
  for (const thing of scenario.things) {
    const current = observed[thing.id];
    if (!current || current.seen || !current.known) continue;
    if (current.carried || thing.locationId === at) {
      observed[thing.id] = { ...current, seen: true };
    }
  }
  return observed;
}

export function thingStateOf(state: EscapeState, thingId: string): ThingState | null {
  return state.things[thingId] ?? null;
}

/**
 * Whether the character can address this thing at all: it has been found, and
 * it is either in the room or in their hands.
 *
 * Presence is derived rather than authored, so an author cannot forget to
 * require it and ship an action that reaches through a wall.
 */
export function isPresent(
  scenario: Scenario,
  state: EscapeState,
  thingId: string,
): boolean {
  const thing = scenario.things.find((candidate) => candidate.id === thingId);
  const current = state.things[thingId];
  if (!thing || !current || !current.known) return false;
  return current.carried || thing.locationId === state.at;
}

export function holds(state: EscapeState, condition: Condition): boolean {
  return condition.not ? !isTrue(state, condition) : isTrue(state, condition);
}

function isTrue(state: EscapeState, condition: Condition): boolean {
  if (condition.kind === "at") return state.at === condition.locationId;
  const thing = state.things[condition.thingId];
  if (!thing) return false;
  if (condition.kind === "carrying") return thing.carried;
  if (condition.kind === "known") return thing.known;
  return thing.stateId === condition.stateId;
}

/** The first condition that does not hold, or null when they all do. */
export function firstUnmet(
  state: EscapeState,
  conditions: readonly Condition[],
): Condition | null {
  for (const condition of conditions) {
    if (!holds(state, condition)) return condition;
  }
  return null;
}

export function goalReached(scenario: Scenario, state: EscapeState): boolean {
  return firstUnmet(state, scenario.goal.requires) === null;
}

/**
 * What the room has found and what is still shut.
 *
 * Every number here is counted from the state above. Nothing is estimated and
 * nothing is a fraction of an invented total: `found` is the things whose
 * existence the room has actually established, `shut` the ones sitting in a
 * state their author marked as a barrier.
 */
export interface EscapeProgress {
  readonly locationId: string;
  readonly locationName: string;
  readonly found: readonly FoundThing[];
  readonly shut: readonly FoundThing[];
  readonly carrying: readonly FoundThing[];
  readonly stepsTaken: number;
  readonly goalReached: boolean;
  readonly goalDescription: string;
}

export interface FoundThing {
  readonly id: string;
  readonly name: string;
  readonly stateLabel: string;
  readonly here: boolean;
}

export function readProgress(scenario: Scenario, state: EscapeState): EscapeProgress {
  const found: FoundThing[] = [];
  const shut: FoundThing[] = [];
  const carrying: FoundThing[] = [];
  for (const thing of scenario.things) {
    const current = state.things[thing.id];
    if (!current || !current.seen) continue;
    const entry = describe(thing, state);
    found.push(entry);
    if (current.carried) carrying.push(entry);
    const definition = thing.states.find((candidate) => candidate.id === current.stateId);
    if (definition?.barrier) shut.push(entry);
  }
  const location = scenario.locations.find((candidate) => candidate.id === state.at);
  return {
    locationId: state.at,
    locationName: location?.name ?? state.at,
    found,
    shut,
    carrying,
    stepsTaken: state.log.length,
    goalReached: goalReached(scenario, state),
    goalDescription: scenario.goal.description,
  };
}

function describe(thing: Thing, state: EscapeState): FoundThing {
  const current = state.things[thing.id];
  const definition = thing.states.find((candidate) => candidate.id === current?.stateId);
  return {
    id: thing.id,
    name: thing.name,
    stateLabel: definition?.label ?? current?.stateId ?? "unknown",
    here: Boolean(current?.carried) || thing.locationId === state.at,
  };
}
