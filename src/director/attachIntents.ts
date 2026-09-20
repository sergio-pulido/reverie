/**
 * What a dropped image or clip could be to the film.
 *
 * Four labels, because a reference means nothing until someone says what it
 * is for: the same photograph is a palette, a face, a location or a framing,
 * and the film needs different things from each. Declaring the purpose before
 * the file is used is the rule live media already follows — there is no
 * implicit contribution, exactly as there is no implicit publish.
 */
export const ATTACH_INTENTS = [
  { id: "look", label: "The look", detail: "Its palette, grain and light." },
  { id: "character", label: "A character", detail: "Who is in the film." },
  { id: "place", label: "A place", detail: "Where the film happens." },
  { id: "shot", label: "A shot", detail: "How this frame is composed." },
] as const;

export type AttachIntentId = (typeof ATTACH_INTENTS)[number]["id"];

/**
 * Why a picked reference goes no further, today.
 *
 * There is no upload route, no reference store and no way to attach anything
 * but text to a turn: `jam_proposals.body` is text and nothing else. The fan
 * out is real and the choice is recorded here, and then it stops — which is
 * the honest shape of a half that has not been built, rather than a progress
 * bar that never completes.
 */
export const ATTACH_NOT_WIRED =
  "Nothing can carry this to the film yet: this build has no reference store, so an image or clip cannot reach the stream. Say what you want in words and it will.";
