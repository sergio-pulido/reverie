import type { Evidence, PreferenceState, Predicate, TurnInput } from "../preferences/schema";
import { RUNTIME_ATTRIBUTE, YEAR_ATTRIBUTE, genreDimension, genreLabel, genreOfTag } from "./domain";
import { GENRES, type GenreSlug } from "./genres";
import { wantedGenres } from "./shortlistFilters";

/**
 * Refinement chips: short things a viewer can say to Discover, each carrying the sentence it
 * stands for and the exact quotes cited from that sentence. The engine accepts a quote only if
 * it is a literal substring of the turn's transcript, so a chip whose quote is not in its own
 * sentence is refused rather than applied.
 *
 * Every chip maps to data the catalogue holds: genres, runtime and release year. There is no
 * mood, tone or pace chip because nothing in the catalogue could honour one.
 */

export type RefinementGroup = "genre" | "exclude" | "runtime" | "era";

type StatedDimension = { value: number; confidence: number; quote: string };
type StatedConstraint = { id: string; predicate: Predicate; quote: string };

export type Refinement = {
  id: string;
  group: RefinementGroup;
  /** What the viewer says by choosing the chip; it is also the chip's text and the transcript. */
  sentence: string;
  dimensions: Readonly<Record<string, StatedDimension>>;
  constraints: readonly StatedConstraint[];
  /** Constraints this chip supersedes, removed when present. */
  replaces: readonly string[];
};

/** Constraint ids are fixed per slot, so a new runtime or era limit replaces the old one. */
export const CONSTRAINT_IDS = {
  runtimeMax: "runtime.max",
  yearMin: "year.min",
  yearMax: "year.max",
  excludeGenre: (slug: GenreSlug) => `exclude.${slug}`,
} as const;

const GENRE_CONFIDENCE = 0.9;
const WITHDRAWN_PHRASE_MAX = 400;

function wantGenre(id: string, sentence: string, quote: string, slug: GenreSlug): Refinement {
  return {
    id,
    group: "genre",
    sentence,
    dimensions: { [genreDimension(slug)]: { value: 1, confidence: GENRE_CONFIDENCE, quote } },
    constraints: [],
    replaces: [CONSTRAINT_IDS.excludeGenre(slug)],
  };
}

function refuseGenre(id: string, sentence: string, slug: GenreSlug): Refinement {
  return {
    id,
    group: "exclude",
    sentence,
    dimensions: { [genreDimension(slug)]: { value: 0, confidence: GENRE_CONFIDENCE, quote: sentence } },
    constraints: [{ id: CONSTRAINT_IDS.excludeGenre(slug), predicate: { kind: "excludeTag", tag: slug }, quote: sentence }],
    replaces: [],
  };
}

function shorterThan(id: string, sentence: string, minutes: number): Refinement {
  return {
    id,
    group: "runtime",
    sentence,
    dimensions: {},
    constraints: [
      {
        id: CONSTRAINT_IDS.runtimeMax,
        predicate: { kind: "number", field: RUNTIME_ATTRIBUTE, operator: "lt", value: minutes },
        quote: sentence,
      },
    ],
    replaces: [],
  };
}

function era(
  id: string,
  sentence: string,
  quote: string,
  from: { operator: "gte"; year: number } | null,
  until: { operator: "lt" | "lte"; year: number } | null,
): Refinement {
  const constraints: StatedConstraint[] = [];
  if (from) {
    constraints.push({
      id: CONSTRAINT_IDS.yearMin,
      predicate: { kind: "number", field: YEAR_ATTRIBUTE, operator: from.operator, value: from.year },
      quote,
    });
  }
  if (until) {
    constraints.push({
      id: CONSTRAINT_IDS.yearMax,
      predicate: { kind: "number", field: YEAR_ATTRIBUTE, operator: until.operator, value: until.year },
      quote,
    });
  }
  const replaces: string[] = [
    ...(from ? [] : [CONSTRAINT_IDS.yearMin]),
    ...(until ? [] : [CONSTRAINT_IDS.yearMax]),
  ];
  return { id, group: "era", sentence, dimensions: {}, constraints, replaces };
}

export const REFINEMENTS: readonly Refinement[] = [
  wantGenre("want-horror", "Something scary", "scary", "horror"),
  wantGenre("want-comedy", "Make me laugh", "laugh", "comedy"),
  wantGenre("want-science-fiction", "Some science fiction", "science fiction", "science_fiction"),
  wantGenre("want-thriller", "A thriller", "thriller", "thriller"),
  wantGenre("want-animation", "Something animated", "animated", "animation"),
  wantGenre("want-romance", "A love story", "love story", "romance"),
  wantGenre("want-documentary", "A documentary", "documentary", "documentary"),
  refuseGenre("refuse-horror", "Nothing scary", "horror"),
  refuseGenre("refuse-animation", "No animation", "animation"),
  refuseGenre("refuse-romance", "No romance", "romance"),
  shorterThan("under-90", "Under 90 minutes", 90),
  shorterThan("under-120", "Under two hours", 120),
  era("recent", "Something recent, from 2015 on", "from 2015 on", { operator: "gte", year: 2015 }, null),
  era("nineties", "From the nineties", "the nineties", { operator: "gte", year: 1990 }, { operator: "lte", year: 1999 }),
  era("classic", "A classic, before 1980", "before 1980", null, { operator: "lt", year: 1980 }),
];

/**
 * What the search screen's filter panel offers: plain filters for a viewer who already knows what
 * they want, each stated in its own words and grounded in them exactly as a chip is. Choosing one
 * is an engine turn; choosing it again withdraws it. An era or a running time replaces the one in
 * effect, so each of those groups holds one choice at a time.
 */
export type FilterGroup = { id: "genre" | "era" | "runtime"; label: string; filters: readonly Refinement[] };

const DECADES = [1980, 1990, 2000, 2010] as const;

export const FILTER_GROUPS: readonly FilterGroup[] = [
  {
    id: "genre",
    label: "Genre",
    // "TV Movie" says how a film was made, not what it is like.
    filters: GENRES.filter(({ slug }) => slug !== "tv_movie").map(({ label, slug }) => wantGenre(`genre-${slug}`, label, label, slug)),
  },
  {
    id: "era",
    label: "Era",
    filters: [
      era("era-before-1980", "Before 1980", "Before 1980", null, { operator: "lt", year: 1980 }),
      ...DECADES.map((decade) => era(`era-${decade}s`, `${decade}s`, `${decade}s`, { operator: "gte", year: decade }, { operator: "lte", year: decade + 9 })),
      era("era-since-2020", "Since 2020", "Since 2020", { operator: "gte", year: 2020 }, null),
    ],
  },
  {
    id: "runtime",
    label: "Running time",
    filters: [shorterThan("runtime-90", "Under 90 min", 90), shorterThan("runtime-120", "Under 2 hours", 120), shorterThan("runtime-150", "Under 2½ hours", 150)],
  },
];

/** Turn ids are sequential within a session, so a replayed id is always the same turn. */
export function nextTurnId(state: PreferenceState): string {
  return `turn-${Object.keys(state.processedTurns).length + 1}`;
}

/** The turn a chip stands for, attributed to the next turn of `state`'s session. */
export function refinementTurn(refinement: Refinement, state: PreferenceState): TurnInput {
  const turnId = nextTurnId(state);
  const setIds = new Set(refinement.constraints.map(({ id }) => id));
  return {
    sessionId: state.sessionId,
    turnId,
    expectedStateVersion: state.stateVersion,
    transcript: refinement.sentence,
    dimensions: Object.fromEntries(
      Object.entries(refinement.dimensions).map(([name, stated]): [string, Evidence] => [
        name,
        { ...stated, sourceTurnId: turnId, explicit: true },
      ]),
    ),
    setConstraints: refinement.constraints.map((constraint) => ({ ...constraint, sourceTurnId: turnId })),
    removeConstraints: refinement.replaces.filter((id) => !setIds.has(id) && Object.hasOwn(state.constraints, id)),
  };
}

/** True when everything the chip states already holds, so choosing it again would change nothing. */
export function isApplied(refinement: Refinement, state: PreferenceState): boolean {
  const dimensionsHold = Object.entries(refinement.dimensions).every(
    ([name, { value }]) => Object.hasOwn(state.dimensions, name) && state.dimensions[name].value === value,
  );
  const constraintsHold = refinement.constraints.every(
    ({ id, predicate }) =>
      Object.hasOwn(state.constraints, id) && samePredicate(state.constraints[id].predicate, predicate),
  );
  const replacedGone = refinement.replaces.every((id) => !Object.hasOwn(state.constraints, id));
  return dimensionsHold && constraintsHold && replacedGone;
}

/** Something currently shaping the result, and what withdrawing it would clear. */
export type ActiveRefinement = {
  key: string;
  label: string;
  /** The words it was stated with, quoted back when the viewer withdraws it. */
  phrase: string;
  dimensions: readonly string[];
  constraints: readonly string[];
};

/** Everything in the state that narrows or orders the result, in a stable order. */
export function activeRefinements(state: PreferenceState): ActiveRefinement[] {
  const wanted = wantedGenres(state).map((genre): ActiveRefinement => {
    const name = genreDimension(genre);
    return { key: `dimension:${name}`, label: genreLabel(genre), phrase: state.dimensions[name].quote, dimensions: [name], constraints: [] };
  });
  const constraints = Object.values(state.constraints)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, predicate, quote }): ActiveRefinement => {
      const genre = predicate.kind === "excludeTag" ? genreOfTag(predicate.tag) : null;
      const paired = genre ? pairedAvoidance(state, genre) : [];
      return { key: `constraint:${id}`, label: describePredicate(predicate), phrase: quote, dimensions: paired, constraints: [id] };
    });
  return [...wanted, ...constraints];
}

/** A refused genre is also stated as unwanted; withdrawing the refusal clears both. */
function pairedAvoidance(state: PreferenceState, genre: GenreSlug): string[] {
  const name = genreDimension(genre);
  const evidence = Object.hasOwn(state.dimensions, name) ? state.dimensions[name] : undefined;
  return evidence && evidence.value !== null && evidence.value < 0.5 ? [name] : [];
}

/**
 * The turn that withdraws something: the constraints are removed and the dimensions are set
 * back to "no direction". Its transcript quotes what is being withdrawn, and so grounds its own
 * evidence. Null when nothing it names is still in effect.
 */
export function withdrawalTurn(
  state: PreferenceState,
  target: Pick<ActiveRefinement, "phrase" | "dimensions" | "constraints">,
): TurnInput | null {
  const turnId = nextTurnId(state);
  const quote = `Never mind "${target.phrase.slice(0, WITHDRAWN_PHRASE_MAX)}"`;
  const dimensions = target.dimensions.filter(
    (name) => Object.hasOwn(state.dimensions, name) && state.dimensions[name].value !== null,
  );
  const constraints = target.constraints.filter((id) => Object.hasOwn(state.constraints, id));
  if (dimensions.length === 0 && constraints.length === 0) return null;

  return {
    sessionId: state.sessionId,
    turnId,
    expectedStateVersion: state.stateVersion,
    transcript: `${quote}.`,
    dimensions: Object.fromEntries(
      dimensions.map((name): [string, Evidence] => [
        name,
        { value: null, confidence: 0, sourceTurnId: turnId, quote, explicit: true },
      ]),
    ),
    setConstraints: [],
    removeConstraints: constraints,
  };
}

/** The withdrawal of a chip that is currently applied. */
export function refinementWithdrawal(refinement: Refinement, state: PreferenceState): TurnInput | null {
  return withdrawalTurn(state, {
    phrase: refinement.sentence,
    dimensions: Object.keys(refinement.dimensions),
    constraints: refinement.constraints.map(({ id }) => id),
  });
}

export function describePredicate(predicate: Predicate): string {
  switch (predicate.kind) {
    case "excludeTag": {
      const genre = genreOfTag(predicate.tag);
      return genre ? `No ${genreLabel(genre)}` : `Not ${predicate.tag}`;
    }
    case "excludeFlag":
      return `Not ${predicate.flag}`;
    case "number":
      return predicate.field === RUNTIME_ATTRIBUTE
        ? describeBound(predicate, (value) => `${value} min`)
        : describeBound(predicate, String);
  }
}

function describeBound(predicate: Extract<Predicate, { kind: "number" }>, format: (value: number) => string): string {
  const isYear = predicate.field === YEAR_ATTRIBUTE;
  switch (predicate.operator) {
    case "lt":
      return `${isYear ? "Before" : "Under"} ${format(predicate.value)}`;
    case "lte":
      return `Up to ${format(predicate.value)}`;
    case "gt":
      return `${isYear ? "After" : "Over"} ${format(predicate.value)}`;
    case "gte":
      return isYear ? `From ${format(predicate.value)}` : `${format(predicate.value)} or more`;
  }
}

function samePredicate(a: Predicate, b: Predicate): boolean {
  switch (a.kind) {
    case "number":
      return b.kind === "number" && a.field === b.field && a.operator === b.operator && a.value === b.value;
    case "excludeTag":
      return b.kind === "excludeTag" && a.tag === b.tag;
    case "excludeFlag":
      return b.kind === "excludeFlag" && a.flag === b.flag;
  }
}

