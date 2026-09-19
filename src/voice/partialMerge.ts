/**
 * What is shown while the viewer speaks, built from partial transcripts as they arrive. Pure, so
 * the rule is testable without a microphone. Display only: nothing here is ever sent.
 *
 * A partial either restates the utterance from its start (a speech service that re-sends
 * everything heard so far), revises its last words, or carries on from somewhere inside it (a
 * service that sends each stretch of speech with a little of the last one). Laying partials end
 * to end would repeat those shared words: "I want something" then "something funny" would read
 * "I want something something funny". They are merged where they overlap instead.
 *
 * The rule: the newer partial is trusted from the point where it begins, and everything shown
 * before that point is kept. Words already shown are withdrawn only by a partial that restates
 * the utterance from its first word; a fragment of words already on screen changes nothing.
 * Words are compared ignoring case and surrounding punctuation; the newer partial's own spelling
 * is the one kept.
 */

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function keyOf(word: string): string {
  return word.toLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

/** Where `run` appears as consecutive words inside `words`, or -1. */
function indexOfRun(words: readonly string[], run: readonly string[]): number {
  for (let start = 0; start + run.length <= words.length; start += 1) {
    if (run.every((word, offset) => words[start + offset] === word)) return start;
  }
  return -1;
}

/**
 * How `next` agrees with `shown` read from `start`, for as long as both run: word for word
 * ("exact"), or word for word except that the last word shown was cut short and `next` finishes
 * it ("fun" → "funny"), or not at all.
 */
function agreementFrom(shown: readonly string[], next: readonly string[], start: number): "exact" | "finished" | null {
  const overlap = Math.min(shown.length - start, next.length);
  let finished = false;
  for (let offset = 0; offset < overlap; offset += 1) {
    const said = shown[start + offset];
    const heard = next[offset];
    if (said === heard) continue;
    const cutShort = start + offset === shown.length - 1 && said.length >= 2 && heard.startsWith(said);
    if (!cutShort) return null;
    finished = true;
  }
  return finished ? "finished" : "exact";
}

/**
 * Whether `next` says the utterance again from its start with some words recognised differently:
 * at least half the words both hold in the same place agree, and at least two of them do (or the
 * only one, for a single word).
 */
function restates(shown: readonly string[], next: readonly string[]): boolean {
  const compared = Math.min(shown.length, next.length);
  let agreeing = 0;
  for (let index = 0; index < compared; index += 1) if (shown[index] === next[index]) agreeing += 1;
  return agreeing >= Math.min(2, compared) && agreeing * 2 >= compared;
}

/** The text to show after `incoming` arrives, given what is `shown`. */
export function mergePartial(shown: string, incoming: string): string {
  const prior = wordsOf(shown);
  const next = wordsOf(incoming);
  if (next.length === 0) return prior.join(" ");
  if (prior.length === 0) return next.join(" ");
  const priorKeys = prior.map(keyOf);
  const nextKeys = next.map(keyOf);

  // Everything shown is already inside the newer partial: it restates the whole utterance.
  if (indexOfRun(nextKeys, priorKeys) >= 0) return next.join(" ");

  // The first place the newer partial fits is the longest overlap.
  for (let start = 0; start < prior.length; start += 1) {
    const agreement = agreementFrom(priorKeys, nextKeys, start);
    if (!agreement) continue;
    // From the first word, possibly shorter: a revision of the utterance, and the newer words win.
    if (start === 0) return next.join(" ");
    // A fragment of words already on screen adds nothing and withdraws nothing.
    if (agreement === "exact" && start + next.length <= prior.length) return prior.join(" ");
    return [...prior.slice(0, start), ...next].join(" ");
  }
  if (restates(priorKeys, nextKeys)) return next.join(" ");
  // Nothing in common: a new stretch of speech follows what was heard.
  return [...prior, ...next].join(" ");
}
