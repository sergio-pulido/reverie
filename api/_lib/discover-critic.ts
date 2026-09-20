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
  // Longer than the ranking's, because nothing is waiting on this one: the posters are already
  // on screen by the time it is asked, and a wait costs the viewer nothing but the wait.
  timeoutMs: 24_000,
  deadlineMs: 36_000,
  // Warmer than the calls that report: criticism with no voice is the thing being replaced.
  temperature: 0.6,
};

/** Below this a reservation is a gesture, not a reservation. */
const MIN_RESERVATION_CHARS = 20;

const criticReplySchema = z.object({ critiques: z.array(z.unknown()).max(CONVERSATION_LIMITS.maxCritiquePicks * 2) });

/** A reply's parts before they are cut to length; the shape is checked again after. */
const looseCritiqueSchema = z.object({
  candidateId: z.string(),
  why: z.string(),
  watching: z.string(),
  reservation: z.string(),
});

/**
 * Crowds the critic may not hide behind. What is refused is a verdict borrowed from other
 * people — "audiences loved it", "an acclaimed performance", a score site's name. Saying that
 * some viewers may bounce off a film is not borrowing a verdict; it is having one, and a
 * reservation is often exactly that shape.
 */
const CROWD =
  /\b(critics?|reviewers?|consensus|universally|acclaim(?:ed)?|rotten tomatoes|metacritic|imdb|letterboxd|box office|audiences?\s+(?:loved|adored|hated|embraced|flocked|made|turned)|widely\s+(?:loved|praised|regarded|considered|held)|cult\s+(?:classic|favou?rite|following|hit)|fan\s+favou?rite|beloved\s+by)\b/i;

/**
 * The viewer's preferences, turned to and written about. Not every "you": "a twist you do not
 * see coming" is ordinary criticism, and refusing it only costs good prose. What is refused is
 * the critique facing the person to tell them what they asked for or what they will feel, which
 * is the advertisement this whole pass exists to replace.
 */
const VIEWER =
  /\byou(?:'|\u2019)?(?:re|ve|d)?\s+(?:asked|said|want|wanted|requested|told|are looking|were looking)\b|\byou(?:(?:'|\u2019)?(?:ll|re))?\s+(?:will|wo|won(?:'|\u2019)?t|might|may|should|are going to)?\s*(?:love|like|enjoy|adore|be disappointed|regret)\b|\bfor you\b|\bwhat you\b|\byour\s+(?:taste|tastes|mood|evening|night|request|preference|preferences|criteria|list|kind|sort|thing)\b/i;

/** A reservation that reserves nothing. */
const HOLLOW =
  /\b(nothing (?:much )?(?:to|against|bad|wrong)|no (?:real|major|obvious|true|serious|complaints?|notes?|quarrel)|not a single (?:flaw|misstep|wasted|false)|hard to fault|little to fault|few flaws|no flaws|no reservations|(?:close to |nearly |almost )?(?:flawless|faultless|perfect)|none(?: at all)?\.?$)/i;

/**
 * A running time claimed in the prose, a score claimed in it, and a year claimed as this film's
 * release. These three are what the row can contradict, and a contradiction is a refusal.
 *
 * Nothing else about a number is refused. A first pass banned digits outright, and live it
 * refused "16-bit sprites", "the 1990 game" and a running time the row itself states — true
 * things, and exactly the knowledge this pass exists to get. What must hold is that the critique
 * never disagrees with the record beside it, not that it never counts.
 */
/**
 * A running time claimed for the film, in the shapes that claim one and no others. A critic
 * writes in minutes constantly — "the first thirty minutes", "forty minutes of the best farce
 * in it" — and those are stretches of the film, not its length. Reading every figure as a
 * running time refused true sentences live, so only the idioms that state a length are checked:
 * "at N minutes" opening a sentence, "runs N minutes", "an N-minute film", "N minutes long".
 * Each capture is a value followed by its unit, which is how `claimed` reads them.
 */
const RUNTIME_CLAIM = new RegExp(
  [
    String.raw`(?:^|[.;!?]\s+)at\s+(\d{1,3})\s*-?\s*(minutes?|mins?|hours?|hrs?)\b`,
    String.raw`\b(?:runs|lasts|clocks in at|running time of)\s+(?:for\s+)?(\d{1,3})\s*-?\s*(minutes?|mins?|hours?|hrs?)\b`,
    String.raw`\b(\d{1,3})\s*-\s*(minute|min|hour|hr)\b`,
    String.raw`\b(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\s+long\b`,
  ].join("|"),
  "gi",
);
const SCORE_CLAIM =
  /\b(\d{1,3}(?:\.\d)?)\s*(?:\/|out of)\s*(?:5|10|100|five|ten)\b|\b(\d{1,3}(?:\.\d)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:stars?\b|percent\b|%)|\b(\d\.\d)\b/gi;
const YEAR_CLAIM =
  /\b(?:released|made|shot|filmed|premiered|came out|dates? from)\s+(?:in\s+)?(\d{4})\b|\b(?:a|an|the|this)\s+(\d{4})\s+(?:film|movie|picture|feature|release|comedy|drama|horror|thriller|romance|western|musical|animation)\b|\bof\s+(\d{4})\b/gi;

const DIGITS = /\d+(?:[.,]\d+)*/g;

/**
 * The first number one of those patterns finds, with its unit. Every pattern captures a value
 * and, where a unit matters, the group straight after it, so the first group that matched names
 * the claim whichever alternative caught it.
 */
function claimed(text: string, pattern: RegExp): { value: string; unit: string } | null {
  for (const match of text.matchAll(pattern)) {
    const groups = match.slice(1);
    const at = groups.findIndex((group) => group !== undefined);
    if (at >= 0) return { value: groups[at], unit: groups[at + 1] ?? "" };
  }
  return null;
}

/** Whether a claim of hours or minutes is this running time, hours read to the nearest hour. */
function matchesRuntime(claim: { value: string; unit: string }, runtimeMinutes: number): boolean {
  const value = Number(claim.value);
  if (!/^h/i.test(claim.unit)) return value === runtimeMinutes;
  return value === Math.floor(runtimeMinutes / 60) || value === Math.round(runtimeMinutes / 60);
}

/**
 * As many whole sentences of `text` as fit, or null when even the first will not. Length is the
 * one thing a critique is cut for rather than refused over: running long is not a claim that can
 * be wrong, and refusing a true critique because it overruns by a dozen characters loses the
 * viewer a note to gain nothing. Only whole sentences are kept, so a trimmed note says less than
 * the critic wrote and never something else.
 */
export function toWholeSentences(text: string, max: number): string | null {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  let kept = "";
  for (const sentence of trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)/g) ?? []) {
    if ((kept + sentence).trim().length > max) break;
    kept += sentence;
  }
  return kept.trim() || null;
}

/** Every part of a critique, as one body of prose to check. */
function prose(critique: Critique): string {
  return `${critique.why} ${critique.watching} ${critique.reservation}`;
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

  const runtime = claimed(text, RUNTIME_CLAIM);
  if (runtime && film.runtimeMinutes !== undefined && !matchesRuntime(runtime, film.runtimeMinutes)) {
    return `your critique of ${film.title} makes it "${runtime.value} ${runtime.unit}" long, and its row says ${film.runtimeMinutes} minutes`;
  }

  // The list rows carry no score today, so in practice every score is one the critic invented.
  const score = claimed(text, SCORE_CLAIM);
  const stated: string[] = film.rating?.match(DIGITS) ?? [];
  if (score && !stated.includes(score.value)) {
    const row = film.rating ? `its row says ${film.rating}` : "its row states no score, so there is none to cite";
    return `your critique of ${film.title} scores it "${score.value}", and ${row}`;
  }

  const year = claimed(text, YEAR_CLAIM);
  if (year && String(film.year) !== year.value) {
    return `your critique of ${film.title} dates it to "${year.value}", and its row says ${film.year ?? "no year at all"}`;
  }

  const crowd = CROWD.exec(text);
  if (crowd) return `your critique of ${film.title} says "${crowd[0]}", and you may not speak for a crowd`;

  const viewer = VIEWER.exec(text);
  if (viewer) return `your critique of ${film.title} says "${viewer[0]}", and you must write about the film, not about what the viewer asked for`;

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
    const loose = looseCritiqueSchema.safeParse(entry);
    if (!loose.success) {
      const issue = loose.error.issues[0];
      return { fault: `an entry was not shaped {"candidateId","why","watching","reservation"}: ${issue.message} at ${issue.path.join(".") || "the entry"}` };
    }
    const max = CONVERSATION_LIMITS.maxCritiquePartChars;
    const parsed = critiqueSchema.safeParse({
      candidateId: loose.data.candidateId,
      why: toWholeSentences(loose.data.why, max),
      watching: toWholeSentences(loose.data.watching, max),
      reservation: toWholeSentences(loose.data.reservation, max),
    });
    if (!parsed.success) {
      return { fault: `an entry ran past what one sentence of it may be: keep every part to two sentences of about forty words` };
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
