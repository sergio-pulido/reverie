import type { Configuration } from "../preferences/schema.js";
import { GENRES, type GenreDimensionKey, type GenreSlug } from "./genres.js";

/**
 * The vocabulary the preference engine may use for the film catalogue, and nothing else.
 *
 * A genre is deliberately both a dimension and a tag. As the dimension `genre.<slug>` it carries
 * "I want horror"; as the tag `<slug>` it is what an `excludeTag` constraint refuses, which is the
 * only way to express "nothing scary". Mood, tone and pace are absent because the catalogue
 * carries no data for them: a vocabulary word the data cannot back would filter nothing.
 */

export const RUNTIME_ATTRIBUTE = "runtimeMinutes";
export const YEAR_ATTRIBUTE = "year";
export const CATALOGUE_ATTRIBUTES = [RUNTIME_ATTRIBUTE, YEAR_ATTRIBUTE] as const;
export type CatalogueAttribute = (typeof CATALOGUE_ATTRIBUTES)[number];

export const LANGUAGE_TAG_PREFIX = "lang.";

/**
 * Original-language codes a title can be tagged with: ISO 639-1, plus the three codes the TMDB
 * data uses outside it (`cn` Cantonese, `sh` Serbo-Croatian, `xx` no language).
 */
export const LANGUAGE_CODES: readonly string[] = (
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch cn co cr cs cu cv cy " +
  "da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy " +
  "hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li " +
  "ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa " +
  "pi pl ps pt qu rm rn ro ru rw sa sc sd se sg sh si sk sl sm sn so sq sr ss st su sv sw ta te tg " +
  "th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh xx yi yo za zh zu"
).split(" ");

const KNOWN_LANGUAGES: ReadonlySet<string> = new Set(LANGUAGE_CODES);

export function genreDimension(slug: GenreSlug): GenreDimensionKey {
  return `genre.${slug}`;
}

/** The genre a `genre.<slug>` dimension names, or null for any other name. */
export function genreOfDimension(name: string): GenreSlug | null {
  return GENRES.find(({ slug }) => genreDimension(slug) === name)?.slug ?? null;
}

/** The genre a tag names, or null when the tag is not a genre. */
export function genreOfTag(tag: string): GenreSlug | null {
  return GENRES.find(({ slug }) => slug === tag)?.slug ?? null;
}

export function genreLabel(slug: GenreSlug): string {
  return GENRES.find((genre) => genre.slug === slug)?.label ?? slug;
}

/** `lang.<code>` for a known code, otherwise null: an unknown language is not tagged. */
export function languageTag(code: string | undefined): string | null {
  return code && KNOWN_LANGUAGES.has(code) ? `${LANGUAGE_TAG_PREFIX}${code}` : null;
}

export const CATALOGUE_CONFIGURATION: Configuration = Object.freeze({
  dimensions: GENRES.map(({ slug }) => genreDimension(slug)),
  attributes: [...CATALOGUE_ATTRIBUTES],
  tags: [...GENRES.map(({ slug }) => slug), ...LANGUAGE_CODES.map((code) => `${LANGUAGE_TAG_PREFIX}${code}`)],
  flags: [],
});
