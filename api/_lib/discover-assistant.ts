import { z } from "zod";
import { NebiusError, type CompletionOptions } from "../../apps/server/providers/nebius.js";
import { toCandidates, type CatalogueCandidate } from "../../src/catalogue/candidates.js";
import { CATALOGUE_CONFIGURATION } from "../../src/catalogue/domain.js";
import { CONVERSATION_LIMITS, type RankCandidate, type Unavailable, type UnavailableCode } from "../../src/conversation/contract.js";
import { decisionSchema, decisionToTurn, type Interpretation } from "../../src/conversation/decision.js";
import { isEligible } from "../../src/preferences/eligibility.js";
import { PreferenceError } from "../../src/preferences/errors.js";
import { acceptFullRanking } from "../../src/preferences/ranking.js";
import { SHORTLIST_SIZE, type PreferenceState, type RankingEntry } from "../../src/preferences/schema.js";
import { applyTurn } from "../../src/preferences/state.js";
import { INTERPRET_SYSTEM, RANK_SYSTEM, interpretUser, rankUser } from "./discover-prompts.js";

/**
 * The two model calls behind Discover's conversation, each bounded: a token ceiling, a
 * per-attempt timeout inside an overall deadline, and at most one retry. The retry tells the
 * model exactly what was refused. Nothing the model returns is used until the engine accepts
 * it: a decision through `applyTurn`, a ranking through `acceptFullRanking`.
 */

/** One provider completion, injectable so every path runs offline in tests. */
export type Completion = (options: CompletionOptions) => Promise<string>;

export const ASSISTANT_ATTEMPTS = 2;
export const INTERPRET_BUDGET = { maxTokens: 700, timeoutMs: 12_000, deadlineMs: 20_000 } as const;
export const RANK_BUDGET = { maxTokens: 1_200, timeoutMs: 15_000, deadlineMs: 25_000 } as const;
/** Below this much time left, a retry could not finish, so it is not started. */
const MIN_ATTEMPT_MS = 3_000;
const TEMPERATURE = 0.2;

export type AssistantResult<T> = { ok: true; value: T; attempts: number } | { ok: false; unavailable: Unavailable };

const MESSAGES: Record<UnavailableCode, string> = {
  ASSISTANT_DISABLED: "The assistant is not switched on for this deployment.",
  ASSISTANT_MISCONFIGURED: "The assistant is not configured correctly on this server.",
  ASSISTANT_BUSY: "The assistant is busy right now.",
  ASSISTANT_TIMEOUT: "The assistant did not answer in time.",
  ASSISTANT_UNUSABLE: "The assistant's answer could not be used.",
  ASSISTANT_UNGROUNDED: "The assistant claimed something you did not say, so its answer was refused.",
};

export function unavailable(code: UnavailableCode): Unavailable {
  return { status: "unavailable", code, safeMessage: MESSAGES[code] };
}

type Attempt<T> = { ok: true; value: T } | { ok: false; code: UnavailableCode; correction: string };

/** Runs `attempt` up to ASSISTANT_ATTEMPTS times inside `deadlineMs`, feeding back each refusal. */
async function withRetry<T>(
  complete: Completion,
  budget: { maxTokens: number; timeoutMs: number; deadlineMs: number },
  system: string,
  user: string,
  judge: (raw: string) => Attempt<T>,
  now: () => number,
  signal?: AbortSignal,
): Promise<AssistantResult<T>> {
  const deadline = now() + budget.deadlineMs;
  let correction: string | null = null;
  let lastCode: UnavailableCode = "ASSISTANT_UNUSABLE";

  for (let attempt = 1; attempt <= ASSISTANT_ATTEMPTS; attempt += 1) {
    const remaining = deadline - now();
    if (attempt > 1 && remaining < MIN_ATTEMPT_MS) break;
    // Nobody is waiting for the answer any more, so nothing more is paid for.
    if (signal?.aborted) return { ok: false, unavailable: unavailable("ASSISTANT_TIMEOUT") };

    let raw: string;
    try {
      raw = await complete({
        system,
        user: correction ? `${user}\n\n${correction}` : user,
        maxTokens: budget.maxTokens,
        timeoutMs: Math.min(budget.timeoutMs, remaining),
        temperature: TEMPERATURE,
        signal,
      });
    } catch (error) {
      if (!(error instanceof NebiusError)) throw error;
      // A provider that did not answer is not asked again: a second wait would double the
      // delay on screen for a call that is likely to fail the same way.
      return { ok: false, unavailable: unavailable(providerCode(error)) };
    }

    const verdict = judge(raw);
    if (verdict.ok) return { ok: true, value: verdict.value, attempts: attempt };
    lastCode = verdict.code;
    correction = verdict.correction;
  }
  return { ok: false, unavailable: unavailable(lastCode) };
}

function providerCode(error: NebiusError): UnavailableCode {
  if (error.kind === "no_response") return "ASSISTANT_TIMEOUT";
  if (error.kind === "config") return "ASSISTANT_MISCONFIGURED";
  if (error.kind === "rejected" && error.retryable) return "ASSISTANT_BUSY";
  return "ASSISTANT_UNUSABLE";
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const SHAPE_CORRECTION = "Correction required: your previous reply was not a single JSON object in the required shape";
const DECISION_SHAPE =
  'Reply again with exactly {"dimensions":[{"dimension","value","confidence","quote","explicit"}],"setConstraints":[{"slot","minutes" or "year","quote"}],"removeConstraints":[slot names: "runtime.max", "year.min" or "year.max"],"acknowledgement","question"}, listing only what the NEW message changes.';

/**
 * Turn 1: what the viewer said, as a turn the engine has already accepted against `state`.
 * `state` must be valid; the caller checks it before paying for a call.
 */
export function interpretMessage(
  complete: Completion,
  state: PreferenceState,
  message: string,
  previousQuestion: string | null,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<AssistantResult<Interpretation>> {
  return withRetry(complete, INTERPRET_BUDGET, INTERPRET_SYSTEM, interpretUser(state, message, previousQuestion), (raw) => {
    const decision = decisionSchema.safeParse(parseJson(raw));
    if (!decision.success) {
      const issue = decision.error.issues[0];
      const where = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      return { ok: false, code: "ASSISTANT_UNUSABLE", correction: `${SHAPE_CORRECTION}${where}: ${issue.message}. ${DECISION_SHAPE}` };
    }
    const interpretation = decisionToTurn(decision.data, state, message);
    try {
      applyTurn(state, interpretation.turn, CATALOGUE_CONFIGURATION);
      return { ok: true, value: interpretation };
    } catch (error) {
      if (!(error instanceof PreferenceError)) throw error;
      const grounding = error.code === "ungrounded_quote" || error.code === "foreign_source_turn";
      return {
        ok: false,
        code: grounding ? "ASSISTANT_UNGROUNDED" : "ASSISTANT_UNUSABLE",
        correction: `Correction required: your previous reply was refused. ${error.message} Every quote must be an exact substring of the viewer's new message.`,
      };
    }
  }, now, signal);
}

export type Ranked = {
  ranking: RankingEntry[];
  reasons: { candidateId: string; reason: string }[];
};

const rankReplySchema = z.object({
  ranking: z.unknown(),
  reasons: z.array(z.object({ candidateId: z.string(), reason: z.string() })).optional(),
});

/** The rank candidates as engine candidates, keeping only those `state` allows. */
export function eligibleRankCandidates(candidates: readonly RankCandidate[], state: PreferenceState): CatalogueCandidate[] {
  return toCandidates(candidates.map((candidate) => ({ ...candidate, availability: [] }))).filter((candidate) =>
    isEligible(candidate, state),
  );
}

/**
 * Turn 2: the model reorders exactly the candidates it was given. It reads every candidate and
 * scores its best RANKED_COUNT; the rest are not scored at all. Its ranking passes the engine's
 * boundary here, so a ranking that names any id not supplied, or one the state rules out, is
 * refused whole. A ranking too short to fill the top picks is refused as unusable.
 */
export function rankCandidates(
  complete: Completion,
  state: PreferenceState,
  candidates: readonly CatalogueCandidate[],
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<AssistantResult<Ranked>> {
  const records = candidates.map(({ title }) => ({ ...title, synopsis: title.synopsis?.slice(0, CONVERSATION_LIMITS.rankSynopsisChars) }));
  const needed = Math.min(SHORTLIST_SIZE, candidates.length);
  const ids = candidates.map(({ id }) => id).join(", ");

  return withRetry(complete, RANK_BUDGET, RANK_SYSTEM, rankUser(state, records), (raw) => {
    const reply = rankReplySchema.safeParse(parseJson(raw));
    if (!reply.success) return { ok: false, code: "ASSISTANT_UNUSABLE", correction: `${SHAPE_CORRECTION}: {"ranking":[...],"reasons":[...]}.` };
    let accepted: CatalogueCandidate[];
    try {
      accepted = acceptFullRanking(candidates, state, state.stateVersion, reply.data.ranking);
    } catch (error) {
      if (!(error instanceof PreferenceError)) throw error;
      return {
        ok: false,
        code: error.code === "invalid_ranking" ? "ASSISTANT_UNUSABLE" : "ASSISTANT_UNGROUNDED",
        correction: `Correction required: your ranking was refused. ${error.message} Use only these candidateIds, exactly: ${ids}.`,
      };
    }
    if (accepted.length < needed) {
      return { ok: false, code: "ASSISTANT_UNUSABLE", correction: `Correction required: rank your best candidates, at least ${needed}.` };
    }
    // Parsed by the boundary above, so every entry is a known id with a utility in 0..1.
    const entries = reply.data.ranking as RankingEntry[];
    const utility = new Map(entries.map(({ candidateId, utility: value }) => [candidateId, value]));
    const top = new Set(accepted.slice(0, SHORTLIST_SIZE).map(({ id }) => id));
    const reasons = (reply.data.reasons ?? [])
      .filter(({ candidateId, reason }) => top.has(candidateId) && reason.trim().length > 0)
      .filter(({ candidateId }, index, all) => all.findIndex((other) => other.candidateId === candidateId) === index)
      .map(({ candidateId, reason }) => ({ candidateId, reason: reason.trim().slice(0, CONVERSATION_LIMITS.maxReasonChars) }));
    return {
      ok: true,
      value: { ranking: accepted.map(({ id }) => ({ candidateId: id, utility: utility.get(id) ?? 0 })), reasons },
    };
  }, now, signal);
}
