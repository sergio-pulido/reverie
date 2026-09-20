import type { CatalogueOk } from "../catalogue/contract";
import type { Line, ResultSet } from "../conversation/transcript";
import type { ShownShortlist } from "../discover/rankedShortlist";

/**
 * Turning what the catalogue and the ranking returned into the result set a turn keeps, and the
 * transcript into the blocks the screen draws. Pure.
 */

/** Posters one answer shows: a row to triage from the sofa, not a grid to browse. */
export const SNAPSHOT_SIZE = 12;

/**
 * A turn's films as they are shown now, frozen. The order is the one on screen; the picks and
 * reasons are kept only for titles in the row. A ranking still waiting on the assistant is the
 * scorer's order, and is labelled as the scorer's.
 */
export function snapshotOf(shown: ShownShortlist, total: number | null): ResultSet {
  const titles = shown.items.slice(0, SNAPSHOT_SIZE);
  const ids = new Set(titles.map(({ id }) => id));
  return {
    titles,
    pickIds: [...shown.pickIds].filter((id) => ids.has(id)),
    reasons: Object.fromEntries([...shown.reasons].filter(([id]) => ids.has(id))),
    critiques: {},
    source: shown.source === "assistant" ? "assistant" : "genre",
    note: shown.note,
    total,
  };
}

/** The films a title lookup found, in the catalogue's order, or null when it found none. */
export function lookupResults(response: CatalogueOk): ResultSet | null {
  if (response.items.length === 0) return null;
  return { titles: response.items.slice(0, SNAPSHOT_SIZE), pickIds: [], reasons: {}, critiques: {}, source: "lookup", note: null, total: response.total };
}

/** What a row says about itself: whose order it is, and how many films matched in all. */
export function captionOf(results: ResultSet): string {
  const order = results.source === "assistant" ? "Ranked by the assistant" : results.source === "genre" ? "Ranked by genre match" : "Title matches";
  const count = results.total === null ? null : `${results.total.toLocaleString("en")} ${results.total === 1 ? "film" : "films"}`;
  return [order, count].filter(Boolean).join(" · ");
}

export type TurnBlock = {
  turn: number;
  lines: readonly Line[];
  /** The films the turn produced, and the line that carries them. */
  answer: { lineId: number; results: ResultSet } | null;
};

/** The transcript as one block per turn, oldest first, each with its films if it has any. */
export function turnsOf(lines: readonly Line[]): TurnBlock[] {
  const byTurn = new Map<number, readonly Line[]>();
  for (const line of lines) byTurn.set(line.turn, [...(byTurn.get(line.turn) ?? []), line]);
  return [...byTurn].map(([turn, own]) => {
    const carrier = own.find(({ results }) => results);
    return { turn, lines: own, answer: carrier?.results ? { lineId: carrier.id, results: carrier.results } : null };
  });
}
