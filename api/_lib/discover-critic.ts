import { z } from "zod";
import { CONVERSATION_LIMITS, critiqueSchema, type Critique, type RankCandidate } from "../../src/conversation/contract.js";
import type { PreferenceState } from "../../src/preferences/schema.js";
import { SHAPE_CORRECTION, parseJson, withRetry, type AssistantResult, type Attempt, type Budget, type Completion } from "./discover-assistant.js";
import { CRITIC_SYSTEM, criticUser } from "./discover-prompts.js";

/**
 * The third call: a critic over the handful of films the ranking picked. The ranking is given a
 * row and forbidden everything outside it, which is why its reasons read like the genre list
 * read back. This one is sent for what the model knows about these films, and is fenced instead
 * by what can be checked:
 *
 * - it may only write about the picks it was handed, and naming a film held back from it is a
 *   refusal of the whole reply;
 * - it may write no digits but those in a film's own title, its year, and a score the row
 *   states, so a wrong year, a wrong running time and an invented score are all one rule;
 * - it may not speak for critics, audiences or any other crowd, and may not address the viewer;
 * - and every pick needs its reservation. A pick whose reservation is missing or hollow loses
 *   its critique; it never gets a hollow one.
 *
 * Nothing here reaches the preference engine. A critique is prose attached to a poster: it
 * proposes no turn, carries no quote, and cannot move the state by any path.
 */

export const CRITIQUE_BUDGET: Budget = {
  maxTokens: 1_100,
  timeoutMs: 18_000,
  deadlineMs: 28_000,
  // Warmer than the calls that report: criticism with no voice is the thing being replaced.
  temperature: 0.6,
};

/** Below this a reservation is a gesture, not a reservation. */
const MIN_RESERVATION_CHARS = 20;

const criticReplySchema = z.object({ critiques: z.array(z.unknown()).max(CONVERSATION_LIMITS.maxCritiquePicks * 2) });

/** Crowds the critic may not hide behind, and scores it may not borrow from them. */
const CROWD = /\b(critics?|audiences?|reviewers?|viewers|consensus|acclaim(?:ed)?|universally|rotten tomatoes|metacritic|imdb|letterboxd|box office)\b/i;

/** Second person in any form: the critique is about the film, not about who is watching. */
const VIEWER = /\byou(?:'|’)?(?:re|ll|ve|d|rs?)?\b/i;

/** A reservation that reserves nothing. */
const HOLLOW = /\b(nothing (?:much )?(?:to|against|bad|wrong)|no (?:real|major|obvious|true|serious)|hard to fault|little to fault|few flaws|no flaws|no reservations|flawless|faultless|none(?: at all)?\.?$)/i;

const DIGITS = /\d+(?:[.,]\d+)*/g;

/** Every part of a critique, as one body of prose to check. */
function prose(critique: Critique): string {
  return `${critique.why} ${critique.watching} ${critique.reservation}`;
}

/**
 * The digit runs a critique about `film` is allowed: those inside its own title (so a film
 * called "2001" can be named), its year, and a score the row states. Everything else — a
 * running time, an invented rating, a place in some list — contradicts the row or invents.
 */
function allowedDigits(film: RankCandidate): Set<string> {
  const allowed = new Set<string>();
  for (const run of film.title.match(DIGITS) ?? []) allowed.add(run);
  if (film.year !== undefined) allowed.add(String(film.year));
  for (const run of film.rating?.match(DIGITS) ?? []) allowed.add(run);
  return allowed;
}

/**
 * Titles worth searching prose for. A one-word title that is also an ordinary word ("Up",
 * "Heat", "Her") cannot be told from the word, so only multi-word or long titles are checked,
 * and case-sensitively: a critic naming a film capitalises it.
 */
function checkableTitles(withheld: readonly string[]): string[] {
  return withheld.filter((title) => title.includes(" ") || title.length >= 8);
}

function namesWithheld(text: string, titles: readonly string[]): string | null {
  for (const title of titles) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");
    if (pattern.test(text)) return title;
  }
  return null;
}

/**
 * Why a critique is refused, in the critic's own terms, or null when it stands. A fault here
 * refuses the whole reply: these are the rules the critic was told, and a reply that breaks one
 * cannot be trusted on the rest.
 */
export function faultInCritique(critique: Critique, film: RankCandidate, withheld: readonly string[]): string | null {
  const text = prose(critique);

  const named = namesWithheld(text, checkableTitles(withheld));
  if (named) return `your critique of ${film.title} names "${named}", which is not one of the films you were given`;

  const allowed = allowedDigits(film);
  const stray = (text.match(DIGITS) ?? []).find((run) => !allowed.has(run));
  if (stray) return `your critique of ${film.title} writes the number "${stray}", and the only digits allowed are the ones in the film's own title or the score its row states`;

  const crowd = CROWD.exec(text);
  if (crowd) return `your critique of ${film.title} says "${crowd[0]}", and you may not speak for a crowd`;

  const viewer = VIEWER.exec(text);
  if (viewer) return `your critique of ${film.title} says "${viewer[0]}", and you must write about the film, not about the person watching it`;

  return null;
}

/** True when a reservation is missing or says nothing against the film. */
export function isHollow(reservation: string): boolean {
  const trimmed = reservation.trim();
  return trimmed.length < MIN_RESERVATION_CHARS || HOLLOW.test(trimmed);
}

type Judged = { critiques: Critique[] } | { fault: string };

/**
 * The reply as critiques for `picks`, or the one fault that refuses it. Entries in the wrong
 * shape, for a film that was not picked, or repeating one already written are refused; an entry
 * whose reservation is hollow is dropped, because a pick is better off with no critique than
 * with a recommendation that has nothing against it.
 */
export function judgeCritiques(raw: unknown, picks: readonly RankCandidate[], withheld: readonly string[]): Judged {
  const reply = criticReplySchema.safeParse(raw);
  if (!reply.success) return { fault: "your previous reply was not one JSON object with a `critiques` list" };

  const byId = new Map(picks.map((pick) => [pick.id, pick]));
  const critiques: Critique[] = [];
  const written = new Set<string>();
  for (const entry of reply.data.critiques) {
    const parsed = critiqueSchema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { fault: `an entry was not shaped {"candidateId","why","watching","reservation"}: ${issue.message} at ${issue.path.join(".") || "the entry"}` };
    }
    const film = byId.get(parsed.data.candidateId);
    if (!film) return { fault: `you wrote about "${parsed.data.candidateId}", which is not one of the films you were given` };
    if (written.has(film.id)) return { fault: `you wrote about ${film.title} twice` };
    written.add(film.id);

    const fault = faultInCritique(parsed.data, film, withheld);
    if (fault) return { fault };
    // Not a fault of the reply, only of this entry: the pick goes without rather than carrying
    // a reservation that reserves nothing.
    if (!isHollow(parsed.data.reservation)) critiques.push(parsed.data);
  }
  return { critiques };
}

/**
 * Turn 3: the critic over the picks. `picks` are the films it may write about; `withheld` are
 * the shortlist's other titles, which it is not shown and may not name. A reply that breaks a
 * rule is refused once with the reason, and a second refusal leaves the picks with the reasons
 * the ranking already wrote — the screen never empties for want of a critique.
 */
export function writeCritiques(
  complete: Completion,
  state: PreferenceState,
  picks: readonly RankCandidate[],
  withheld: readonly string[],
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<AssistantResult<Critique[]>> {
  const ids = picks.map(({ id }) => id).join(", ");
  const judge = (raw: string): Attempt<Critique[]> => {
    const verdict = judgeCritiques(parseJson(raw), picks, withheld);
    if ("fault" in verdict) {
      const shape = verdict.fault.startsWith("your previous reply was not") ? `${SHAPE_CORRECTION}. ` : "";
      return {
        ok: false,
        code: "ASSISTANT_UNUSABLE",
        correction: `${shape}Correction required: ${verdict.fault}. Write about only these films, by these candidateIds, exactly: ${ids}.`,
      };
    }
    if (verdict.critiques.length === 0) {
      return {
        ok: false,
        code: "ASSISTANT_UNUSABLE",
        correction: `Correction required: not one entry survived, because every reservation was missing or said nothing against the film. Give each of ${ids} a reservation that names a real reason it might not land, or leave that entry out.`,
      };
    }
    return { ok: true, value: verdict.critiques };
  };
  return withRetry(complete, CRITIQUE_BUDGET, CRITIC_SYSTEM, criticUser(state, picks), judge, now, signal);
}
