import { toCandidates, type CatalogueCandidate } from "../../src/catalogue/candidates.js";
import { CATALOGUE_LIMITS, type CatalogueFilters, type CatalogueResponse, type CatalogueTitle } from "../../src/catalogue/contract.js";
import { CATALOGUE_CONFIGURATION } from "../../src/catalogue/domain.js";
import { orderByAssistant, rankShortlist } from "../../src/catalogue/scorer.js";
import { toShortlistRead, type ShortlistRead } from "../../src/catalogue/shortlistFilters.js";
import { CONVERSATION_LIMITS, toRankCandidate, type Critique, type Unavailable } from "../../src/conversation/contract.js";
import { PreferenceError } from "../../src/preferences/errors.js";
import { applyTurn, newState } from "../../src/preferences/state.js";
import type { PreferenceState } from "../../src/preferences/schema.js";
import { critiqueStep, interpretStep, rankStep, type StepOptions } from "./discover-funnel.js";
import { isUnavailable, type Provider } from "./discover-http.js";

/**
 * Discover's whole funnel for one viewer message, in one call: interpret, apply the turn the
 * engine accepted, read the catalogue for the state that produced, rank, critique, and render
 * what the viewer would have seen as text an evaluator can grade.
 *
 * Every step is the step `/api/discover/*` runs — the same modules, in the same order, through
 * the same boundaries. What is different is only who holds the state: the browser keeps it
 * between three requests, and here it lives for the length of one.
 *
 * The fallbacks are the browser's too. A ranking that does not arrive leaves the deterministic
 * scorer's order, and a critique that does not arrive leaves the ranking's reasons, because that
 * is what a viewer would have seen. Only a failure to interpret ends the funnel: there is no
 * turn, so there is nothing to read the catalogue for.
 */

/** Reads one page of the catalogue for one state. The server owns the credential behind it. */
export type CatalogueReader = (read: ShortlistRead) => Promise<CatalogueResponse>;

export type FunnelDeps = StepOptions & {
  provider: Provider;
  readCatalogue: CatalogueReader;
  /** Identifies the throwaway session this evaluation runs in. */
  sessionId: string;
};

export type EvaluatedTitle = {
  id: string;
  title: string;
  year: number | null;
  genres: string[];
};

export type EvaluateOk = {
  status: "ok";
  /** The text an evaluator grades: what was heard, then each pick with the reason for it. */
  output: string;
  acknowledgement: string;
  question: string | null;
  subject: string | null;
  filters: CatalogueFilters;
  titles: EvaluatedTitle[];
  /** By catalogue id, for the picks the critic wrote about. A pick may have none. */
  critiques: Record<string, Critique>;
  /** Titles in the catalogue matching this state, of which `titles` are the picks shown. */
  total: number;
};

export type FunnelFailure = { statusCode: number; code: string; safeMessage: string; retryable: boolean };

export type FunnelResult = { ok: true; value: EvaluateOk } | { ok: false; failure: FunnelFailure };

/** An assistant that could not answer is reported as itself, not flattened into one error. */
function fromUnavailable({ code, safeMessage }: Unavailable): FunnelFailure {
  const retryable = code === "ASSISTANT_BUSY" || code === "ASSISTANT_TIMEOUT";
  return { statusCode: 503, code, safeMessage, retryable };
}

type Heard = { state: PreferenceState; acknowledgement: string; question: string | null };

/**
 * The history and then the message, each interpreted and applied in turn, so a multi-turn case
 * is the same conversation the browser would have had. Only the last turn's lines are kept: the
 * earlier ones were said to a viewer who has already replied.
 */
async function hear(deps: FunnelDeps, messages: readonly string[]): Promise<Heard | FunnelFailure> {
  let state = newState(deps.sessionId);
  let acknowledgement = "";
  let question: string | null = null;

  for (const message of messages) {
    const result = await interpretStep(deps.provider, state, message, question, deps);
    if (isUnavailable(result)) return fromUnavailable(result);
    if (!result.ok) return fromUnavailable(result.unavailable);
    try {
      state = applyTurn(state, result.value.turn, CATALOGUE_CONFIGURATION);
    } catch (error) {
      if (!(error instanceof PreferenceError)) throw error;
      return { statusCode: 422, code: "TURN_REFUSED", safeMessage: "That conversation could not be replayed.", retryable: false };
    }
    acknowledgement = result.value.acknowledgement;
    question = result.value.question;
  }
  return { state, acknowledgement, question };
}

type Ordered = { picks: CatalogueCandidate[]; ordered: CatalogueCandidate[]; reasons: Map<string, string> };

/**
 * The shortlist in the order the viewer would have seen it. The model's order when it arrived
 * and the engine accepted it for exactly these films; the deterministic scorer otherwise.
 */
async function order(deps: FunnelDeps, state: PreferenceState, items: readonly CatalogueTitle[]): Promise<Ordered> {
  const candidates = toCandidates(items);
  if (candidates.length === 0) return { picks: [], ordered: [], reasons: new Map() };

  const result = await rankStep(deps.provider, state, candidates, deps);
  if (isUnavailable(result) || !result.ok) return { ...rankShortlist(candidates, state), reasons: new Map() };
  try {
    const ranked = orderByAssistant(candidates, state, state.stateVersion, result.value.ranking);
    const pickIds = new Set(ranked.picks.map(({ id }) => id));
    const reasons = new Map(
      result.value.reasons.filter(({ candidateId }) => pickIds.has(candidateId)).map(({ candidateId, reason }) => [candidateId, reason]),
    );
    return { ...ranked, reasons };
  } catch (error) {
    if (!(error instanceof PreferenceError)) throw error;
    return { ...rankShortlist(candidates, state), reasons: new Map() };
  }
}

/** The critic on the picks, by id. Nothing when it refused, timed out or is switched off. */
async function critique(
  deps: FunnelDeps,
  state: PreferenceState,
  picks: readonly CatalogueTitle[],
  row: readonly CatalogueTitle[],
): Promise<Record<string, Critique>> {
  if (picks.length === 0) return {};
  const shown = new Set(picks.map(({ id }) => id));
  const withheld = row.filter(({ id }) => !shown.has(id)).map(({ title }) => title);
  const result = await critiqueStep(deps.provider, state, picks.map(toRankCandidate), withheld, deps);
  if (isUnavailable(result) || !result.ok) return {};

  const accepted: Record<string, Critique> = {};
  for (const note of result.value) {
    if (!shown.has(note.candidateId) || accepted[note.candidateId]) continue;
    accepted[note.candidateId] = note;
  }
  return accepted;
}

export async function runEvaluation(deps: FunnelDeps, messages: readonly string[]): Promise<FunnelResult> {
  const heard = await hear(deps, messages);
  if (!("state" in heard)) return { ok: false, failure: heard };
  const { state, acknowledgement, question } = heard;

  const read = toShortlistRead(state);
  const found = await deps.readCatalogue(read);
  if (found.status !== "ok") return { ok: false, failure: fromCatalogue(found) };

  const { picks, ordered, reasons } = await order(deps, state, found.items);
  const shown = picks.slice(0, CONVERSATION_LIMITS.maxCritiquePicks).map(({ title }) => title);
  const critiques = await critique(deps, state, shown, ordered.map(({ title }) => title));

  return {
    ok: true,
    value: {
      status: "ok",
      output: render(acknowledgement, question, shown, reasons, critiques),
      acknowledgement,
      question,
      subject: read.subject === "" ? null : read.subject,
      filters: read.filters,
      titles: shown.map(toEvaluatedTitle),
      critiques,
      total: found.total,
    },
  };
}

function fromCatalogue(found: Exclude<CatalogueResponse, { status: "ok" }>): FunnelFailure {
  if (found.status === "catalogue_not_configured") {
    return { statusCode: 503, code: found.code, safeMessage: found.safeMessage, retryable: false };
  }
  return { statusCode: found.retryable ? 502 : 400, code: found.code, safeMessage: found.safeMessage, retryable: found.retryable };
}

function toEvaluatedTitle(title: CatalogueTitle): EvaluatedTitle {
  return { id: title.id, title: title.title, year: title.year ?? null, genres: [...title.genres] };
}

/** One page of the catalogue for one state: the whole refined shortlist, as Discover reads it. */
export function shortlistQuery({ subject, filters }: ShortlistRead) {
  return { query: subject, page: 1, pageSize: CATALOGUE_LIMITS.shortlistSize, ...filters } as const;
}

/**
 * What the viewer would have seen, as prose. The acknowledgement and any question first, then
 * each pick with the critic's note on it — or, where the critic wrote nothing, the reason the
 * ranking gave. Nothing is added that no step produced: a shortlist with no titles says so.
 */
function render(
  acknowledgement: string,
  question: string | null,
  picks: readonly CatalogueTitle[],
  reasons: ReadonlyMap<string, string>,
  critiques: Readonly<Record<string, Critique>>,
): string {
  const lines: string[] = [acknowledgement];
  if (question) lines.push(question);
  if (picks.length === 0) {
    lines.push("", "No title in the catalogue matches that.");
    return lines.join("\n");
  }

  picks.forEach((film, index) => {
    const genres = film.genres.length > 0 ? ` — ${film.genres.join(", ")}` : "";
    lines.push("", `${index + 1}. ${film.title}${film.year === undefined ? "" : ` (${film.year})`}${genres}`);
    const note = critiques[film.id];
    if (note) {
      lines.push(`   Why this one: ${note.why}`, `   What watching it is like: ${note.watching}`, `   But: ${note.reservation}`);
      return;
    }
    const reason = reasons.get(film.id);
    if (reason) lines.push(`   Why this one: ${reason}`);
  });
  return lines.join("\n");
}
