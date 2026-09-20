/**
 * Starting premises the create form opens on, so a room can be started without
 * typing one. Ten, one sentence each, none naming a real film, and each a
 * situation rather than a genre so the screenwriter has something to answer.
 * The form draws one when it opens and another each time the door is used
 * again; the person can always replace it.
 */
export const STARTING_PREMISES: readonly string[] = [
  "A signal changes what the room thinks is possible.",
  "A lighthouse keeper receives a letter addressed to someone who has not been born yet.",
  "Two strangers share a taxi and realise they are heading to the same funeral, for different reasons.",
  "The last night shift at a factory that closes tomorrow, and one machine will not stop.",
  "A child draws a door on the wall, and in the morning it has a handle.",
  "A translator is hired for a negotiation in a language nobody else in the room admits to speaking.",
  "The tide goes out further than it ever has, and something is standing on the seabed.",
  "A wedding photographer notices the same guest in every photograph she has ever taken.",
  "Three neighbours hear the same song through the wall at exactly the same hour, from three different flats.",
  "A retired pilot finds her old plane in a field, fuelled, with the engine still warm.",
];

/** One premise, chosen at random; `except` avoids handing back the one already on screen. */
export function randomPremise(except?: string): string {
  const pool = STARTING_PREMISES.filter((premise) => premise !== except);
  return pool[Math.floor(Math.random() * pool.length)] ?? STARTING_PREMISES[0];
}
