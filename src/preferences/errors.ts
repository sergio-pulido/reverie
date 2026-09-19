import type { z } from "zod";

export type PreferenceErrorCode =
  | "invalid_state"
  | "invalid_configuration"
  | "invalid_turn"
  | "session_mismatch"
  | "ungrounded_quote"
  | "foreign_source_turn"
  | "explicit_overwrite"
  | "turn_replay_conflict"
  | "stale_state_version"
  | "turn_limit_reached"
  | "unknown_dimension"
  | "unknown_attribute"
  | "unknown_tag"
  | "unknown_flag"
  | "constraint_conflict"
  | "duplicate_constraint"
  | "unknown_constraint"
  | "stale_ranking"
  | "invalid_ranking"
  | "invalid_candidates"
  | "unknown_candidate"
  | "ineligible_candidate"
  | "duplicate_candidate";

/** Every refusal the preference engine makes, each with its own code so callers can branch on it. */
export class PreferenceError extends Error {
  readonly code: PreferenceErrorCode;

  constructor(code: PreferenceErrorCode, message: string) {
    super(message);
    this.name = "PreferenceError";
    this.code = code;
  }
}

/** Parses `input` with `schema`, turning a validation failure into a PreferenceError. */
export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  input: unknown,
  code: PreferenceErrorCode,
  subject: string,
): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  throw new PreferenceError(code, `Invalid ${subject}${path}: ${issue.message}`);
}
