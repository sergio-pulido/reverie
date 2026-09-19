import assert from "node:assert/strict";
import { PreferenceError, type PreferenceErrorCode } from "../src/preferences/errors";
import type { Candidate, Configuration, Constraint, Evidence, TurnInput } from "../src/preferences/schema";

export const SESSION = "session-1";

export const CONFIG: Configuration = {
  dimensions: ["genre.drama", "genre.comedy", "pace"],
  attributes: ["runtime", "year"],
  tags: ["genre.horror", "genre.war"],
  flags: ["adult"],
};

export const TRANSCRIPT = "I want something funny, nothing scary, and under 100 minutes please";

export function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    value: 0.9,
    confidence: 0.8,
    sourceTurnId: "t1",
    quote: "something funny",
    explicit: true,
    ...overrides,
  };
}

export function runtimeUnder(value: number, overrides: Partial<Constraint> = {}): Constraint {
  return {
    id: "short",
    predicate: { kind: "number", field: "runtime", operator: "lt", value },
    sourceTurnId: "t1",
    quote: "under 100 minutes",
    ...overrides,
  };
}

export function noHorror(overrides: Partial<Constraint> = {}): Constraint {
  return {
    id: "no-horror",
    predicate: { kind: "excludeTag", tag: "genre.horror" },
    sourceTurnId: "t1",
    quote: "nothing scary",
    ...overrides,
  };
}

export function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    sessionId: SESSION,
    turnId: "t1",
    expectedStateVersion: 0,
    transcript: TRANSCRIPT,
    dimensions: {},
    setConstraints: [],
    removeConstraints: [],
    ...overrides,
  };
}

export function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    dimensions: {},
    attributes: { runtime: 90, year: 2001 },
    tags: [],
    flags: [],
    ...overrides,
  };
}

/** Asserts `fn` throws a PreferenceError with `code`, and that its message names `mentioning`. */
export function assertPreferenceError(fn: () => unknown, code: PreferenceErrorCode, mentioning?: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof PreferenceError, `expected a PreferenceError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (mentioning !== undefined) assert.ok(error.message.includes(mentioning), `"${error.message}" should name "${mentioning}"`);
    return true;
  });
}
