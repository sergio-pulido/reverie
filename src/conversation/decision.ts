import { z } from "zod";
import { YEAR_ATTRIBUTE, RUNTIME_ATTRIBUTE, genreDimension, genreOfDimension, genreOfTag, genreLabel } from "../catalogue/domain.js";
import { GENRES } from "../catalogue/genres.js";
import { CONSTRAINT_IDS, describePredicate, nextTurnId } from "../catalogue/refinements.js";
import { MAX_QUOTE_CHARS, MAX_SUBJECT_CHARS, type AcceptedTurn, type Constraint, type Evidence, type PreferenceState } from "../preferences/schema.js";

/**
 * What the model returns when it interprets one viewer message. It never sees the catalogue:
 * it can only point at genres, a runtime limit, an era and a subject — the viewer's own words
 * for what the film is about — and every point must quote the viewer's own words. The engine
 * then refuses any quote that is not literally in the message, and any subject word they did
 * not say.
 */

export const MAX_MESSAGE_CHARS = 500;
export const MAX_ASSISTANT_LINE_CHARS = 240;
const MAX_DECISION_DIMENSIONS = 8;

const GENRE_DIMENSIONS = GENRES.map(({ slug }) => genreDimension(slug)) as [string, ...string[]];

/** Constraint slots the model may set or clear. Genre refusals follow from dimensions instead. */
export const DECISION_CONSTRAINT_SLOTS = [CONSTRAINT_IDS.runtimeMax, CONSTRAINT_IDS.yearMin, CONSTRAINT_IDS.yearMax] as const;

const quoteSchema = z
  .string()
  .max(MAX_QUOTE_CHARS)
  .refine((quote) => quote.trim().length > 0, "Quote must not be blank");
const lineSchema = z.string().trim().min(1).max(MAX_ASSISTANT_LINE_CHARS);
const yearSchema = z.number().int().min(1870).max(2100);

export const decisionEvidenceSchema = z.strictObject({
  dimension: z.enum(GENRE_DIMENSIONS),
  /** 1 wants the genre, 0 refuses it, null says it no longer matters. */
  value: z.number().min(0).max(1).nullable(),
  confidence: z.number().min(0).max(1),
  quote: quoteSchema,
  explicit: z.boolean(),
});

export const decisionConstraintSchema = z.discriminatedUnion("slot", [
  z.strictObject({ slot: z.literal(CONSTRAINT_IDS.runtimeMax), minutes: z.number().int().min(20).max(400), quote: quoteSchema }),
  z.strictObject({ slot: z.literal(CONSTRAINT_IDS.yearMin), year: yearSchema, quote: quoteSchema }),
  z.strictObject({ slot: z.literal(CONSTRAINT_IDS.yearMax), year: yearSchema, quote: quoteSchema }),
]);

export const decisionSchema = z
  .strictObject({
    dimensions: z.array(decisionEvidenceSchema).max(MAX_DECISION_DIMENSIONS),
    /**
     * What the viewer said the film is about, in their words, or null when they said nothing
     * about it. Unlike the other fields it may be left out altogether, and then says nothing:
     * most messages have no subject, and refusing a reply for omitting it would spend a retry
     * on nothing.
     */
    subject: z.string().trim().max(MAX_SUBJECT_CHARS).nullable().default(null),
    setConstraints: z.array(decisionConstraintSchema).max(DECISION_CONSTRAINT_SLOTS.length),
    removeConstraints: z.array(z.enum(DECISION_CONSTRAINT_SLOTS)).max(DECISION_CONSTRAINT_SLOTS.length),
    acknowledgement: lineSchema,
    question: lineSchema.nullable(),
  })
  .refine(
    ({ dimensions }) => new Set(dimensions.map(({ dimension }) => dimension)).size === dimensions.length,
    "Each dimension may appear once",
  )
  .refine(
    ({ setConstraints }) => new Set(setConstraints.map(({ slot }) => slot)).size === setConstraints.length,
    "Each constraint slot may be set once",
  );

export type Decision = z.infer<typeof decisionSchema>;
export type DecisionConstraint = z.infer<typeof decisionConstraintSchema>;

/** A decision, turned into the turn the engine will judge, plus the lines to say back. */
export type Interpretation = {
  turn: AcceptedTurn;
  acknowledgement: string;
  question: string | null;
};

/**
 * Builds the engine turn for `message` from a decision. The mapping mirrors the chips exactly:
 * an explicitly refused genre is also excluded outright, and wanting a genre (or saying it no
 * longer matters) lifts an earlier refusal of it. Nothing here checks grounding; `applyTurn`
 * does, on this turn, and refuses it whole if any quote is not in the message.
 *
 * Two things are normalised rather than refused, and neither weakens what the engine checks:
 * an inference about a genre the viewer already stated outright is left out (what the viewer
 * said wins over what was guessed), and clearing a slot that is not set is a no-op.
 *
 * Asking for a genre outright retires the genres earlier guessed from a mood: "light" may have
 * suggested comedy, family and romance, and "a comedy" answers that, so family and romance stop
 * counting. They are set to "no direction", quoting the words that replaced them.
 *
 * A subject replaces whatever subject was in effect, and a decision that states none leaves
 * the standing one alone; the engine composes them, and the narrowing strip is where a viewer
 * takes one off. A blank subject states nothing rather than an empty search.
 *
 * The question is dropped when the turn states anything outright: a request with a clear
 * direction is answered, not questioned. Saying what a film is about is such a direction.
 */
export function decisionToTurn(decision: Decision, state: PreferenceState, message: string): Interpretation {
  const turnId = nextTurnId(state);
  const dimensions: [string, Evidence][] = [];
  const setConstraints: Constraint[] = [];
  const lifted = new Set<string>();

  for (const stated of decision.dimensions) {
    const existing = Object.hasOwn(state.dimensions, stated.dimension) ? state.dimensions[stated.dimension] : undefined;
    if (existing?.explicit && !stated.explicit) continue;
    const { dimension, ...rest } = stated;
    dimensions.push([dimension, { ...rest, sourceTurnId: turnId }]);

    const genre = genreOfDimension(dimension);
    if (!genre || !stated.explicit) continue;
    const excludeId = CONSTRAINT_IDS.excludeGenre(genre);
    if (stated.value !== null && stated.value < 0.5) {
      setConstraints.push({ id: excludeId, predicate: { kind: "excludeTag", tag: genre }, sourceTurnId: turnId, quote: stated.quote });
    } else if (Object.hasOwn(state.constraints, excludeId)) {
      lifted.add(excludeId);
    }
  }

  dimensions.push(...retiredGuesses(state, dimensions, turnId));
  for (const constraint of decision.setConstraints) setConstraints.push(toConstraint(constraint, turnId));

  const setIds = new Set(setConstraints.map(({ id }) => id));
  const removeConstraints = [...new Set([...decision.removeConstraints, ...lifted])].filter(
    (id) => Object.hasOwn(state.constraints, id) && !setIds.has(id),
  );

  const subject = decision.subject !== null && decision.subject.length > 0 ? decision.subject : null;
  const statesSomething =
    dimensions.some(([, evidence]) => evidence.explicit) || setConstraints.length > 0 || removeConstraints.length > 0 || subject !== null;

  return {
    turn: {
      sessionId: state.sessionId,
      turnId,
      expectedStateVersion: state.stateVersion,
      transcript: message,
      dimensions: Object.fromEntries(dimensions),
      setConstraints,
      removeConstraints,
      setSubject: subject,
      clearSubject: false,
    },
    acknowledgement: decision.acknowledgement,
    question: statesSomething ? null : decision.question,
  };
}

/** Earlier inferred wants this turn's outright request replaces, as "no direction" evidence. */
function retiredGuesses(state: PreferenceState, stated: readonly [string, Evidence][], turnId: string): [string, Evidence][] {
  const outright = stated.find(([name, evidence]) => genreOfDimension(name) && evidence.explicit && evidence.value !== null && evidence.value >= 0.5);
  if (!outright) return [];
  const addressed = new Set(stated.map(([name]) => name));
  return Object.entries(state.dimensions).flatMap(([name, evidence]): [string, Evidence][] => {
    const guessed = !evidence.explicit && evidence.value !== null && evidence.value >= 0.5;
    if (!guessed || addressed.has(name) || !genreOfDimension(name)) return [];
    return [[name, { value: null, confidence: 0, quote: outright[1].quote, explicit: false, sourceTurnId: turnId }]];
  });
}

function toConstraint(constraint: DecisionConstraint, turnId: string): Constraint {
  switch (constraint.slot) {
    case CONSTRAINT_IDS.runtimeMax:
      return {
        id: constraint.slot,
        predicate: { kind: "number", field: RUNTIME_ATTRIBUTE, operator: "lt", value: constraint.minutes },
        sourceTurnId: turnId,
        quote: constraint.quote,
      };
    case CONSTRAINT_IDS.yearMin:
      return {
        id: constraint.slot,
        predicate: { kind: "number", field: YEAR_ATTRIBUTE, operator: "gte", value: constraint.year },
        sourceTurnId: turnId,
        quote: constraint.quote,
      };
    case CONSTRAINT_IDS.yearMax:
      return {
        id: constraint.slot,
        predicate: { kind: "number", field: YEAR_ATTRIBUTE, operator: "lte", value: constraint.year },
        sourceTurnId: turnId,
        quote: constraint.quote,
      };
  }
}

const RECENT_TURNS = 6;

/**
 * The preference state as a few lines a model can read: what is wanted, refused, limited and
 * turned down, and the viewer's recent words. No catalogue data is in it.
 */
export function summarizeState(state: PreferenceState): string {
  const genres = Object.entries(state.dimensions).flatMap(([name, evidence]) => {
    const genre = genreOfDimension(name);
    if (!genre || evidence.value === null) return [];
    const direction = evidence.value >= 0.5 ? "wants" : "does not want";
    const how = evidence.explicit ? "said outright" : "inferred";
    return [`- ${direction} ${genreLabel(genre)} (${name}, ${how}, from "${evidence.quote}")`];
  });
  const constraints = Object.values(state.constraints)
    .filter(({ predicate }) => !(predicate.kind === "excludeTag" && genreOfTag(predicate.tag)))
    .map(({ id, predicate, quote }) => `- ${id}: ${describePredicate(predicate)} (from "${quote}")`);
  const turns = Object.values(state.processedTurns)
    .slice(-RECENT_TURNS)
    .map((transcript) => `- "${transcript}"`);

  return [
    "Genres:",
    ...(genres.length > 0 ? genres : ["- none stated"]),
    "Limits:",
    ...(constraints.length > 0 ? constraints : ["- none"]),
    `What the film is about: ${state.subject ? JSON.stringify(state.subject.phrase) : "not stated"}`,
    `Titles turned down: ${state.rejectedCandidateIds.length}`,
    "Earlier viewer turns, oldest first:",
    ...(turns.length > 0 ? turns : ["- none"]),
  ].join("\n");
}
