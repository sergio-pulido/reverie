/**
 * Starting premises the create form opens on, so a room can be started without
 * typing one. Twenty, each a title and two sentences of situation — never a
 * genre, never a real film — so the screenwriter has something to answer and
 * the title on the form already belongs to the story under it. The form draws
 * one when it opens and another each time the door is used; the person can
 * always replace either half.
 */
export interface StartingPremise {
  readonly title: string;
  readonly premise: string;
}

export const STARTING_PREMISES: readonly StartingPremise[] = [
  { title: "The Signal", premise: "A night-shift radio operator picks up a transmission that answers questions before she asks them. By the third night it has started asking its own." },
  { title: "Letter to Tomorrow", premise: "A lighthouse keeper receives a letter addressed to someone who has not been born yet. He decides to keep it safe, and the lighthouse begins to keep him." },
  { title: "Same Road, Different Reasons", premise: "Two strangers share a taxi through the rain and realise they are heading to the same funeral. Neither will say who the dead man was to them, and the meter keeps running." },
  { title: "Last Shift", premise: "It is the final night at a factory that closes tomorrow, and one machine will not stop. The foreman has an hour to decide whether to pull the plug or listen to what it is making." },
  { title: "The Door That Grew", premise: "A lonely child draws a door on the bedroom wall, and by morning it has a handle. Every night it is a little larger, and something on the other side has learned her name." },
  { title: "The Unspoken Tongue", premise: "A translator is hired for a negotiation in a language nobody else in the room admits to speaking. Halfway through she realises both sides understand every word." },
  { title: "Low Tide", premise: "The tide goes out further than it ever has, and something is standing on the seabed, facing the town. The people who walk out to it do not come back wet." },
  { title: "Every Wedding", premise: "A wedding photographer notices the same guest in every photograph she has ever taken, always at the edge, always looking at the camera. Tonight she has been hired again." },
  { title: "Through the Wall", premise: "Three neighbours in three flats hear the same song through the wall at exactly the same hour. None of them owns a record of it, and the building has no fourth flat." },
  { title: "Engine Still Warm", premise: "A retired pilot finds her old plane in a field, fuelled, with the engine still warm. There is a flight plan on the seat, in her handwriting, for a place she has never been." },
  { title: "The Understudy", premise: "An understudy is told the lead has fallen ill an hour before curtain. Then the lead walks in, sits in the front row, and asks to see how it should have been done." },
  { title: "Night Audit", premise: "A hotel night auditor finds a room on the ledger that the floor plan does not have. The guest in it has been paying, in cash, since before the hotel was built." },
  { title: "The Second Bell", premise: "A village church rings its bell twice at midnight, once for the living and once for the dead. Tonight it rang three times, and the priest is counting the congregation." },
  { title: "Dead Reckoning", premise: "A cargo ship's navigator wakes to find the stars in the wrong places and the crew unbothered. The captain says they are on course, and asks her not to look at the charts." },
  { title: "Open All Hours", premise: "A petrol station on a mountain road stays open through a storm for a single customer who never arrives. The attendant keeps the coffee hot and the lights on, and the storm keeps its distance." },
  { title: "The Inheritance", premise: "A woman inherits a house from an aunt she never met, on the condition that she never opens the cellar. The keys are in the cellar." },
  { title: "Twelve Minutes Late", premise: "A commuter misses her train by twelve minutes every day for a week, and every day the same man is on the platform apologising for it. On the eighth day he is early." },
  { title: "Still Life", premise: "A restorer cleaning a seventeenth-century painting uncovers a figure the catalogue never listed. The next morning the figure is a step closer to the front." },
  { title: "The Long Table", premise: "A family gathers for the reading of a will that turns out to be a dinner invitation from the deceased. The courses arrive on time, and the empty chair is at the head." },
  { title: "Frequency", premise: "A ham radio hobbyist makes contact with a station that claims to be his own house, forty years ago. His younger self wants advice, and does not like what he hears." },
];

/** One premise, chosen at random; `except` avoids handing back the one already on screen. */
export function randomPremise(except?: string): StartingPremise {
  const pool = STARTING_PREMISES.filter((candidate) => candidate.premise !== except);
  return pool[Math.floor(Math.random() * pool.length)] ?? STARTING_PREMISES[0];
}
