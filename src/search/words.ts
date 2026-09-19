/**
 * The words of something typed or said, as the search screen's decisions compare them: lower
 * case, split on anything that is not a letter, a digit or an apostrophe, and with curly
 * apostrophes made straight so "don’t" and "don't" are one word.
 */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** The words joined by single spaces, padded so a phrase can be found by its whole words. */
export function spaced(words: readonly string[]): string {
  return ` ${words.join(" ")} `;
}
