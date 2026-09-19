import { detectPreferences } from "./detect";
import { ANSWERS, type RequestContext } from "./filler";
import { spaced, wordsOf } from "./words";

/**
 * One field takes both a film's name and a request in the viewer's own words, and the viewer
 * never says which. This decides. Pure, so the decision is testable.
 *
 * A message is looked up as a title when it reads like one: a few words, no question, nothing
 * that frames a request ("I want", "something", "show me") and no genre, running time or era.
 * Everything else is a conversation. A lookup that finds nothing is not the end: the screen then
 * sends the same message to the assistant, so the only cost of reading a request as a title is
 * one catalogue read.
 */

export type MessageIntent = "lookup" | "conversation";

/** Longer than this and it is a sentence, not a title. */
export const MAX_LOOKUP_WORDS = 6;

const REQUEST_CUES: ReadonlySet<string> = new Set([
  "i", "i'd", "i'm", "id", "im", "we", "we'd", "we're", "want", "wanna", "need", "fancy", "feel",
  "feeling", "mood", "something", "anything", "recommend", "recommendation", "suggest",
  "suggestion", "please", "show", "find", "watch", "tonight", "looking", "maybe", "similar",
  "vibe", "vibes",
]);

/** "a film with dogs", "movies about space": describing a film rather than naming one. */
const DESCRIBES_A_FILM = /^ (?:a|an|some|any) (?:film|movie|one)s? | (?:films?|movies?|ones?) (?:with|about|where|that|for|set|like) /;

export function messageIntent(text: string, { answering = false }: RequestContext = {}): MessageIntent {
  const words = wordsOf(text);
  if (words.length === 0 || words.length > MAX_LOOKUP_WORDS) return "conversation";
  // "Yes", "the first one", "neither": an answer to the question the assistant is waiting on.
  if (answering && words.some((word) => ANSWERS.has(word))) return "conversation";
  if (text.includes("?")) return "conversation";
  if (words.some((word) => REQUEST_CUES.has(word))) return "conversation";
  if (DESCRIBES_A_FILM.test(spaced(words))) return "conversation";
  if (detectPreferences(text).length > 0) return "conversation";
  return "lookup";
}
