import { wordsOf } from "./words";

/**
 * Whether a phrase asks for anything. "Um", "I want", "something", a bare "or" are how people
 * start talking, not a request: they must not become a turn, reach the assistant or search for
 * anything. Pure, so the line is testable.
 *
 * A phrase carries a request when at least one of its words is not filler (the sounds of
 * hesitation) and not framing (the words every request is wrapped in). Anything else counts,
 * including a word this list has never seen, so a film title always gets through. A short answer
 * such as "yes" or "neither" carries meaning only while the assistant is waiting on a question.
 */

const FILLER: ReadonlySet<string> = new Set([
  "um", "umm", "ummm", "uh", "uhh", "uhm", "er", "erm", "hmm", "hm", "mm", "mmm", "ah", "ahh", "eh",
  "oh", "ooh", "well", "so", "okay", "ok", "right", "yeah", "hey", "hi", "hello", "basically",
  "literally", "anyway",
]);

const FRAMING: ReadonlySet<string> = new Set([
  "i", "i'd", "i'm", "id", "im", "we", "we'd", "we're", "me", "you", "your", "my", "our",
  "want", "wanna", "would", "could", "can", "will", "like", "love", "need", "fancy", "feel",
  "feeling", "mood", "in", "the", "a", "an", "and", "or", "but", "to", "for", "of", "on", "some",
  "something", "anything", "thing", "things", "kind", "sort", "just", "maybe", "please", "show",
  "find", "get", "give", "let", "let's", "lets", "look", "looking", "watch", "watching", "see",
  "movie", "movies", "film", "films", "one", "is", "be", "have", "what", "how", "about", "there",
  "any", "good", "tonight", "now", "again", "else", "more", "idea", "ideas", "think", "thinking", "too",
]);

/** Words that answer a question the assistant is waiting on, and nothing else. */
export const ANSWERS: ReadonlySet<string> = new Set([
  "yes", "yep", "yup", "no", "nope", "sure", "either", "neither", "both", "none", "nothing",
  "whatever", "first", "second", "last", "that", "this",
]);

/**
 * A number word straight after "want", "like" and the like is how a speech service hears a
 * trailing "or" ("I want four"), and is not a request. Anywhere else it counts: "a film for two",
 * a title said on its own ("Seven"), and digits ("1917") always.
 */
const NUMBER_WORDS: ReadonlySet<string> = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);
const REQUEST_VERBS: ReadonlySet<string> = new Set(["want", "wanna", "like", "love", "need", "fancy"]);

export type RequestContext = {
  /** The assistant asked a question and is waiting for the answer. */
  answering?: boolean;
};

export function carriesRequest(text: string, { answering = false }: RequestContext = {}): boolean {
  const words = wordsOf(text);
  return words.some((word, index) => {
    if (FILLER.has(word) || FRAMING.has(word)) return false;
    if (ANSWERS.has(word)) return answering;
    if (NUMBER_WORDS.has(word) && REQUEST_VERBS.has(words[index - 1])) return false;
    return true;
  });
}
