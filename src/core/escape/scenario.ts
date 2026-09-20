import { z } from "zod";

/**
 * The escape-room scenario format: an authored world, not a generated one.
 *
 * A scenario is data in this repository. It declares a place, a character, a
 * goal, and the things that stand between them, each with its own states. The
 * rules module (./rules) is the only thing that reads it to decide what
 * happened; no model is consulted about whether the key fits the drawer.
 *
 * Every reason a participant can be told is authored here. A refusal is a
 * sentence someone wrote about this world, not a template the code assembled,
 * because a generic "you cannot do that" is what makes a room feel arbitrary.
 *
 * The format itself is specified in docs/specs/escape-room-scenario.md.
 */

const ID = /^[a-z][a-z0-9-]*$/;

const idSchema = z
  .string()
  .regex(ID, "An id is lowercase letters, digits and hyphens.")
  .min(2)
  .max(48);

/** Words a participant might use for a thing. Matched whole, lowercased. */
const aliasesSchema = z
  .array(z.string().trim().toLowerCase().min(2).max(48))
  .min(1)
  .max(12);

const reasonSchema = z.string().trim().min(8).max(240);

/**
 * One fact about the world that an action needs. `unmet` is what the room is
 * told when it does not hold — the whole point of a "failed for a stated
 * reason" outcome is that the reason came from the author.
 *
 * `not` inverts the fact rather than adding a mirrored vocabulary of kinds:
 * "she is not already carrying it" is the same question as "is she carrying
 * it", asked the other way round, and one flag keeps the two answers from
 * drifting apart.
 */
const negatable = { not: z.boolean().default(false) };

export const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), locationId: idSchema, unmet: reasonSchema, ...negatable }),
  z.object({ kind: z.literal("carrying"), thingId: idSchema, unmet: reasonSchema, ...negatable }),
  z.object({ kind: z.literal("state"), thingId: idSchema, stateId: idSchema, unmet: reasonSchema, ...negatable }),
  z.object({ kind: z.literal("known"), thingId: idSchema, unmet: reasonSchema, ...negatable }),
]);

export type Condition = z.infer<typeof conditionSchema>;

/** What an action does to the world when the rules let it through. */
export const effectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set-state"), thingId: idSchema, stateId: idSchema }),
  z.object({ kind: z.literal("take"), thingId: idSchema }),
  z.object({ kind: z.literal("drop"), thingId: idSchema }),
  z.object({ kind: z.literal("reveal"), thingId: idSchema }),
  z.object({ kind: z.literal("go"), locationId: idSchema }),
]);

export type Effect = z.infer<typeof effectSchema>;

export const locationSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(2).max(64),
  /** Read to the room, and the ground of every prompt shot there. */
  description: z.string().trim().min(16).max(600),
  /**
   * The looping shot generated once per session for this location. It must
   * describe a place doing nothing in particular: it plays while the room
   * argues, so it can never contain the action the room has not chosen yet.
   */
  loopShot: z.string().trim().min(16).max(600),
});

export type EscapeLocation = z.infer<typeof locationSchema>;

export const thingStateSchema = z.object({
  id: idSchema,
  /** How this state reads in the progress panel: "locked", "ajar", "lit". */
  label: z.string().trim().min(2).max(48),
  /**
   * True while this state is something the room still has to get past. The
   * progress panel counts these; nothing else infers "shut" from a name.
   */
  barrier: z.boolean().default(false),
});

export const thingSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(2).max(64),
  aliases: aliasesSchema,
  description: z.string().trim().min(8).max(400),
  /** Where it is. `null` means it exists only in the character's hands. */
  locationId: idSchema.nullable(),
  states: z.array(thingStateSchema).min(1).max(8),
  initialStateId: idSchema,
  /** False for something the room has to find before it can be addressed. */
  known: z.boolean().default(true),
  carried: z.boolean().default(false),
});

export type Thing = z.infer<typeof thingSchema>;
export type ThingStateDefinition = z.infer<typeof thingStateSchema>;

export const actionSchema = z.object({
  id: idSchema,
  /** Every way a participant might say it. Matched as whole words. */
  verbs: aliasesSchema,
  /** What the verb is done to. Presence is checked by the rules, not authored. */
  targetId: idSchema,
  /** What it is done with, if anything. Must be carried; that is checked too. */
  instrumentId: idSchema.optional(),
  requires: z.array(conditionSchema).max(8).default([]),
  effects: z.array(effectSchema).min(1).max(8),
  /** The camera. Handed to the model as the shot it must not contradict. */
  shot: z.string().trim().min(16).max(600),
  /** What happened, in the author's words. The film's fallback narration. */
  tell: z.string().trim().min(8).max(400),
  /** How long this beat wants to run. Clamped to the model's band at generation time. */
  seconds: z.number().int().min(5).max(15).default(15),
});

export type EscapeAction = z.infer<typeof actionSchema>;

export const goalSchema = z.object({
  description: z.string().trim().min(8).max(240),
  requires: z.array(conditionSchema).min(1).max(8),
  /** The closing line when the room gets there. */
  tell: z.string().trim().min(8).max(400),
});

export const scenarioSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(2).max(72),
    logline: z.string().trim().min(16).max(400),
    character: z.object({
      name: z.string().trim().min(2).max(64),
      description: z.string().trim().min(16).max(400),
    }),
    /** Held for the whole session and prefixed to every prompt. */
    look: z.string().trim().min(16).max(400),
    startLocationId: idSchema,
    locations: z.array(locationSchema).min(1).max(8),
    things: z.array(thingSchema).min(1).max(32),
    actions: z.array(actionSchema).min(1).max(48),
    goal: goalSchema,
  })
  .superRefine(assertScenarioIsWhole);

export type Scenario = z.infer<typeof scenarioSchema>;

/**
 * Every id a scenario names must exist. An author who mistypes a state id
 * would otherwise ship a room with an action that can never fire, and the
 * first sign of it would be a paid generation of a beat that resolves wrong.
 */
function assertScenarioIsWhole(scenario: {
  startLocationId: string;
  locations: { id: string }[];
  things: { id: string; locationId: string | null; states: { id: string }[]; initialStateId: string }[];
  actions: {
    id: string;
    targetId: string;
    instrumentId?: string;
    requires: Condition[];
    effects: Effect[];
  }[];
  goal: { requires: Condition[] };
}, context: z.RefinementCtx) {
  const locations = new Set(scenario.locations.map((location) => location.id));
  const things = new Map(scenario.things.map((thing) => [thing.id, thing]));
  const fail = (path: (string | number)[], message: string) =>
    context.addIssue({ code: "custom", path, message });

  if (!locations.has(scenario.startLocationId)) {
    fail(["startLocationId"], "The starting location is not one of this scenario's locations.");
  }
  assertUnique(scenario.locations.map((location) => location.id), ["locations"], fail);
  assertUnique(scenario.things.map((thing) => thing.id), ["things"], fail);
  assertUnique(scenario.actions.map((action) => action.id), ["actions"], fail);

  scenario.things.forEach((thing, index) => {
    if (thing.locationId !== null && !locations.has(thing.locationId)) {
      fail(["things", index, "locationId"], `${thing.id} is in a location that does not exist.`);
    }
    assertUnique(thing.states.map((state) => state.id), ["things", index, "states"], fail);
    if (!thing.states.some((state) => state.id === thing.initialStateId)) {
      fail(["things", index, "initialStateId"], `${thing.id} starts in a state it does not have.`);
    }
  });

  const checkCondition = (condition: Condition, path: (string | number)[]) => {
    if (condition.kind === "at" && !locations.has(condition.locationId)) {
      fail(path, `A condition names the location ${condition.locationId}, which does not exist.`);
      return;
    }
    if (condition.kind === "at") return;
    const thing = things.get(condition.thingId);
    if (!thing) {
      fail(path, `A condition names the thing ${condition.thingId}, which does not exist.`);
      return;
    }
    if (condition.kind === "state" && !thing.states.some((state) => state.id === condition.stateId)) {
      fail(path, `${condition.thingId} has no state ${condition.stateId}.`);
    }
  };

  scenario.actions.forEach((action, index) => {
    if (!things.has(action.targetId)) {
      fail(["actions", index, "targetId"], `${action.id} acts on a thing that does not exist.`);
    }
    if (action.instrumentId && !things.has(action.instrumentId)) {
      fail(["actions", index, "instrumentId"], `${action.id} uses a thing that does not exist.`);
    }
    action.requires.forEach((condition, conditionIndex) =>
      checkCondition(condition, ["actions", index, "requires", conditionIndex]),
    );
    action.effects.forEach((effect, effectIndex) => {
      const path = ["actions", index, "effects", effectIndex];
      if (effect.kind === "go") {
        if (!locations.has(effect.locationId)) fail(path, `${action.id} moves to a location that does not exist.`);
        return;
      }
      const thing = things.get(effect.thingId);
      if (!thing) {
        fail(path, `${action.id} changes a thing that does not exist.`);
        return;
      }
      if (effect.kind === "set-state" && !thing.states.some((state) => state.id === effect.stateId)) {
        fail(path, `${effect.thingId} has no state ${effect.stateId}.`);
      }
    });
  });

  scenario.goal.requires.forEach((condition, index) =>
    checkCondition(condition, ["goal", "requires", index]),
  );
}

function assertUnique(
  ids: string[],
  path: (string | number)[],
  fail: (path: (string | number)[], message: string) => void,
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail(path, `${id} is declared twice.`);
    seen.add(id);
  }
}
