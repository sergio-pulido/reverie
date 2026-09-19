import type { CatalogueTitle } from "../catalogue/contract";

/**
 * What "Start a Jam from this" puts in the new Jam's form: a title and an opening premise drawn
 * from the film's record, for the viewer to edit before anything is created. Pure.
 *
 * The Jam makes an original film, so the seed says it is inspired by the catalogue film and
 * never that it is that film, a copy of it, or a way to watch it. Both fit the form's limits.
 */

export const JAM_TITLE_MAX = 72;
export const JAM_PREMISE_MAX = 280;

export type JamSeed = { title: string; premise: string };

/** Cuts at a word boundary and marks the cut, so a long value never ends mid-word. */
function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** The synopsis's opening sentence: enough to set a scene, not the whole plot. */
function openingSentence(synopsis: string | undefined): string | null {
  const text = synopsis?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const end = text.search(/[.!?](\s|$)/);
  return end >= 0 ? text.slice(0, end + 1) : text;
}

export function jamSeedFrom(film: Pick<CatalogueTitle, "title" | "year" | "synopsis">): JamSeed {
  const name = film.year ? `${film.title} (${film.year})` : film.title;
  const lead = `An original story inspired by ${name}.`;
  const scene = openingSentence(film.synopsis);
  return {
    title: fit(`Inspired by ${film.title}`, JAM_TITLE_MAX),
    premise: fit(scene ? `${lead} It begins where that one does: ${scene}` : lead, JAM_PREMISE_MAX),
  };
}
