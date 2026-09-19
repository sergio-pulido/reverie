import { PreferenceError, parseOrThrow } from "./errors.js";
import {
  MAX_REJECTED_CANDIDATES,
  MAX_TURNS_PER_SESSION,
  PREFERENCE_SCHEMA_VERSION,
  configurationSchema,
  preferenceStateSchema,
  turnInputSchema,
  type Configuration,
  type Constraint,
  type PreferenceState,
  type TurnInput,
} from "./schema.js";

export function newState(sessionId: string): PreferenceState {
  return parseOrThrow(
    preferenceStateSchema,
    {
      schemaVersion: PREFERENCE_SCHEMA_VERSION,
      sessionId,
      stateVersion: 0,
      dimensions: {},
      constraints: {},
      rejectedCandidateIds: [],
      processedTurns: {},
    },
    "invalid_state",
    "session id",
  );
}

const candidateIdSchema = preferenceStateSchema.shape.rejectedCandidateIds.element;

/**
 * Records explicit "not this one" feedback: the candidate is never eligible again in this
 * session. Rejecting an already rejected candidate returns `state` itself; otherwise the result
 * is a new state one version higher, so any ranking made before the rejection goes stale.
 */
export function rejectCandidate(state: PreferenceState, candidateId: unknown): PreferenceState {
  const current = parseOrThrow(preferenceStateSchema, state, "invalid_state", "preference state");
  const id = parseOrThrow(candidateIdSchema, candidateId, "invalid_candidates", "candidate id");
  if (current.rejectedCandidateIds.includes(id)) return state;
  if (current.rejectedCandidateIds.length >= MAX_REJECTED_CANDIDATES) {
    throw new PreferenceError("rejection_limit_reached", `A session rejects at most ${MAX_REJECTED_CANDIDATES} candidates.`);
  }
  return { ...current, stateVersion: current.stateVersion + 1, rejectedCandidateIds: [...current.rejectedCandidateIds, id] };
}

/** Makes every rejected candidate eligible again, when the viewer asks for them back. */
export function restoreRejected(state: PreferenceState): PreferenceState {
  const current = parseOrThrow(preferenceStateSchema, state, "invalid_state", "preference state");
  if (current.rejectedCandidateIds.length === 0) return state;
  return { ...current, stateVersion: current.stateVersion + 1, rejectedCandidateIds: [] };
}

/**
 * Folds one viewer turn into the state. Every check runs before anything is built, so a
 * rejected turn changes nothing; an accepted one returns a new state one version higher.
 * Replaying a processed turn with the same transcript returns `state` itself.
 */
export function applyTurn(state: PreferenceState, input: unknown, config: Configuration): PreferenceState {
  const current = parseOrThrow(preferenceStateSchema, state, "invalid_state", "preference state");
  const vocabulary = parseOrThrow(configurationSchema, config, "invalid_configuration", "configuration");
  const turn = parseOrThrow(turnInputSchema, input, "invalid_turn", "turn");

  if (turn.sessionId !== current.sessionId) {
    throw new PreferenceError("session_mismatch", `Turn ${turn.turnId} belongs to another session.`);
  }
  if (Object.hasOwn(current.processedTurns, turn.turnId)) {
    if (current.processedTurns[turn.turnId] === turn.transcript) return state;
    throw new PreferenceError("turn_replay_conflict", `Turn ${turn.turnId} was already processed with a different transcript.`);
  }
  if (turn.expectedStateVersion !== current.stateVersion) {
    throw new PreferenceError(
      "stale_state_version",
      `Turn ${turn.turnId} expected state version ${turn.expectedStateVersion}, but it is ${current.stateVersion}.`,
    );
  }
  if (Object.keys(current.processedTurns).length >= MAX_TURNS_PER_SESSION) {
    throw new PreferenceError("turn_limit_reached", `A session accepts at most ${MAX_TURNS_PER_SESSION} turns.`);
  }

  assertGrounded(turn);
  assertKnownVocabulary(turn, vocabulary);
  assertConstraintChanges(turn, current);
  assertExplicitKept(turn, current);

  return buildNextState(current, turn);
}

/**
 * Every quote must be a literal substring of this turn's transcript and attributed to this
 * turn. This is what stops a preference the viewer never expressed from entering the state.
 */
function assertGrounded(turn: TurnInput): void {
  const cited = [
    ...Object.entries(turn.dimensions).map(([name, evidence]) => ({ label: `dimension ${name}`, ...evidence })),
    ...turn.setConstraints.map((constraint) => ({ label: `constraint ${constraint.id}`, ...constraint })),
  ];
  for (const { label, sourceTurnId, quote } of cited) {
    if (sourceTurnId !== turn.turnId) {
      throw new PreferenceError(
        "foreign_source_turn",
        `The ${label} cites turn ${sourceTurnId}, but only turn ${turn.turnId} can be cited here.`,
      );
    }
    if (!turn.transcript.includes(quote)) {
      throw new PreferenceError("ungrounded_quote", `The ${label} quotes "${quote}", which turn ${turn.turnId} does not contain.`);
    }
  }
}

function assertKnownVocabulary(turn: TurnInput, vocabulary: Configuration): void {
  const known = (list: readonly string[], name: string) => list.includes(name);

  for (const name of Object.keys(turn.dimensions)) {
    if (!known(vocabulary.dimensions, name)) throw new PreferenceError("unknown_dimension", `Unknown dimension ${name}.`);
  }
  for (const { predicate } of turn.setConstraints) {
    if (predicate.kind === "number" && !known(vocabulary.attributes, predicate.field)) {
      throw new PreferenceError("unknown_attribute", `Unknown attribute ${predicate.field}.`);
    }
    if (predicate.kind === "excludeTag" && !known(vocabulary.tags, predicate.tag)) {
      throw new PreferenceError("unknown_tag", `Unknown tag ${predicate.tag}.`);
    }
    if (predicate.kind === "excludeFlag" && !known(vocabulary.flags, predicate.flag)) {
      throw new PreferenceError("unknown_flag", `Unknown flag ${predicate.flag}.`);
    }
  }
}

function assertConstraintChanges(turn: TurnInput, current: PreferenceState): void {
  const setIds = new Set<string>();
  for (const { id } of turn.setConstraints) {
    if (setIds.has(id)) throw new PreferenceError("duplicate_constraint", `Constraint ${id} is set twice in one turn.`);
    setIds.add(id);
  }
  const removedIds = new Set<string>();
  for (const id of turn.removeConstraints) {
    if (setIds.has(id)) throw new PreferenceError("constraint_conflict", `Constraint ${id} is both set and removed in one turn.`);
    if (removedIds.has(id)) throw new PreferenceError("duplicate_constraint", `Constraint ${id} is removed twice in one turn.`);
    if (!Object.hasOwn(current.constraints, id)) throw new PreferenceError("unknown_constraint", `Constraint ${id} does not exist.`);
    removedIds.add(id);
  }
}

function assertExplicitKept(turn: TurnInput, current: PreferenceState): void {
  for (const [name, evidence] of Object.entries(turn.dimensions)) {
    const existing = Object.hasOwn(current.dimensions, name) ? current.dimensions[name] : undefined;
    if (existing?.explicit && !evidence.explicit) {
      throw new PreferenceError("explicit_overwrite", `Dimension ${name} was stated explicitly and cannot be replaced by an inference.`);
    }
  }
}

function buildNextState(current: PreferenceState, turn: TurnInput): PreferenceState {
  const removed = new Set(turn.removeConstraints);
  const keptConstraints = Object.entries(current.constraints).filter(([id]) => !removed.has(id));
  const setConstraints = turn.setConstraints.map((constraint): [string, Constraint] => [constraint.id, constraint]);

  return {
    ...current,
    stateVersion: current.stateVersion + 1,
    dimensions: Object.fromEntries([...Object.entries(current.dimensions), ...Object.entries(turn.dimensions)]),
    constraints: Object.fromEntries([...keptConstraints, ...setConstraints]),
    rejectedCandidateIds: [...current.rejectedCandidateIds],
    processedTurns: Object.fromEntries([...Object.entries(current.processedTurns), [turn.turnId, turn.transcript]]),
  };
}
