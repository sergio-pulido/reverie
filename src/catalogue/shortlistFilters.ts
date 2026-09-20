import type { PreferenceState, Predicate } from "../preferences/schema.js";
import { CATALOGUE_ID_PREFIX, CATALOGUE_LIMITS, type CatalogueFilters } from "./contract.js";
import { RUNTIME_ATTRIBUTE, YEAR_ATTRIBUTE, genreOfDimension, genreOfTag } from "./domain.js";
import type { GenreSlug } from "./genres.js";

type NumberPredicate = Extract<Predicate, { kind: "number" }>;
type Bounds = { min?: number; max?: number };

/** Above this a stated dimension counts as wanted; the shortlist then requires one of them. */
const WANTED_THRESHOLD = 0.5;
const PROVIDER_ID = new RegExp(`^${CATALOGUE_ID_PREFIX}(\\d{1,15})$`);

/** True when the viewer has stated anything that changes what Discover shows. */
export function isRefined(state: PreferenceState): boolean {
  return (
    Object.keys(state.constraints).length > 0 ||
    state.rejectedCandidateIds.length > 0 ||
    state.subject !== null ||
    wantedGenres(state).length > 0
  );
}

/**
 * One catalogue read for one state: the words to search the weighted document for, and the hard
 * filters. They are one value because they are one request and must never drift apart; a read
 * keyed on the filters alone would reuse an answer found for different words.
 */
export type ShortlistRead = { subject: string; filters: CatalogueFilters };

/**
 * What the viewer said the film is about, as a catalogue search term, or "" when they have not
 * said. Clamped to what the endpoint accepts, which only ever shortens the phrase.
 */
export function subjectSearch(state: PreferenceState): string {
  return state.subject ? state.subject.phrase.slice(0, CATALOGUE_LIMITS.queryMaxLength) : "";
}

/** The whole read a state asks for: its subject and its filters together. */
export function toShortlistRead(state: PreferenceState): ShortlistRead {
  return { subject: subjectSearch(state), filters: toShortlistFilters(state) };
}

/** Genres the viewer asked for, in the order they were first stated. */
export function wantedGenres(state: PreferenceState): GenreSlug[] {
  return Object.entries(state.dimensions).flatMap(([name, evidence]) => {
    const genre = genreOfDimension(name);
    return genre && evidence.value !== null && evidence.value > WANTED_THRESHOLD && evidence.confidence > 0 ? [genre] : [];
  });
}

/**
 * Every constraint in the state as a database filter, so the shortlist is computed in Postgres
 * over the whole catalogue rather than fetched and discarded. Both attributes are whole numbers,
 * so strict bounds become inclusive ones; several bounds on one attribute keep the tightest.
 */
export function toShortlistFilters(state: PreferenceState): CatalogueFilters {
  const runtime: Bounds = {};
  const year: Bounds = {};
  const excluded = new Set<GenreSlug>();

  for (const { predicate } of Object.values(state.constraints)) {
    if (predicate.kind === "number" && predicate.field === RUNTIME_ATTRIBUTE) tighten(runtime, predicate);
    if (predicate.kind === "number" && predicate.field === YEAR_ATTRIBUTE) tighten(year, predicate);
    if (predicate.kind === "excludeTag") {
      const genre = genreOfTag(predicate.tag);
      if (genre) excluded.add(genre);
    }
  }

  const included = wantedGenres(state).filter((genre) => !excluded.has(genre));
  const rejectedIds = state.rejectedCandidateIds
    .flatMap((id) => {
      const match = PROVIDER_ID.exec(id);
      return match ? [Number(match[1])] : [];
    })
    .slice(-CATALOGUE_LIMITS.maxExcludedIds);

  return {
    ...bound("minRuntime", runtime.min, CATALOGUE_LIMITS.runtimeMin, CATALOGUE_LIMITS.runtimeMax),
    ...bound("maxRuntime", runtime.max, CATALOGUE_LIMITS.runtimeMin, CATALOGUE_LIMITS.runtimeMax),
    ...bound("minYear", year.min, CATALOGUE_LIMITS.yearMin, CATALOGUE_LIMITS.yearMax),
    ...bound("maxYear", year.max, CATALOGUE_LIMITS.yearMin, CATALOGUE_LIMITS.yearMax),
    ...(included.length > 0 ? { includeGenres: included } : {}),
    ...(excluded.size > 0 ? { excludeGenres: [...excluded] } : {}),
    ...(rejectedIds.length > 0 ? { excludeIds: rejectedIds } : {}),
  };
}

function tighten(bounds: Bounds, { operator, value }: NumberPredicate): void {
  switch (operator) {
    case "lt":
      bounds.max = Math.min(bounds.max ?? Infinity, Math.ceil(value) - 1);
      return;
    case "lte":
      bounds.max = Math.min(bounds.max ?? Infinity, Math.floor(value));
      return;
    case "gt":
      bounds.min = Math.max(bounds.min ?? -Infinity, Math.floor(value) + 1);
      return;
    case "gte":
      bounds.min = Math.max(bounds.min ?? -Infinity, Math.ceil(value));
  }
}

/**
 * Clamped into what the endpoint accepts. Clamping can only loosen a bound that is already
 * outside the data, and the engine re-checks every row it receives, so nothing ineligible shows.
 */
function bound<K extends string>(key: K, value: number | undefined, min: number, max: number): Partial<Record<K, number>> {
  if (value === undefined || !Number.isFinite(value)) return {};
  return { [key]: Math.min(max, Math.max(min, value)) } as Partial<Record<K, number>>;
}
