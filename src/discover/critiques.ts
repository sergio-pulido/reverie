import type { CatalogueTitle } from "../catalogue/contract";
import { CONVERSATION_LIMITS, type Critique, type CritiqueResponse } from "../conversation/contract";
import type { PreferenceState } from "../preferences/schema";

/**
 * The browser's boundary for what the critic wrote. The server checked the critique against the
 * rules the critic works under; this checks only what the browser can see and what would hurt
 * if it were wrong — a note shown under the wrong poster, or a note written for a state the row
 * no longer reflects. Nothing here touches the preference state, because a critique never can:
 * it is prose attached to a poster and proposes nothing.
 */

/** Identifies one set of picks under one state: a critique is valid for this key and no other. */
export function critiqueKey(state: PreferenceState, picks: readonly CatalogueTitle[]): string {
  return `${state.sessionId}|${state.stateVersion}|${picks.map(({ id }) => id).join(",")}`;
}

/** The picks a critique may be asked for: the top few of the row, and never more. */
export function critiquePicks(items: readonly CatalogueTitle[], pickIds: ReadonlySet<string>): CatalogueTitle[] {
  return items.filter(({ id }) => pickIds.has(id)).slice(0, CONVERSATION_LIMITS.maxCritiquePicks);
}

/** Every other title in the row: the critic is not shown these and may not name one. */
export function withheldTitles(items: readonly CatalogueTitle[], picks: readonly CatalogueTitle[]): string[] {
  const shown = new Set(picks.map(({ id }) => id));
  return items.filter(({ id }) => !shown.has(id)).map(({ title }) => title);
}

/**
 * What of a reply may be shown, by title id. A reply for another state version is dropped whole:
 * the picks it was written about are not the picks on screen. A note for a film that is not one
 * of these picks is dropped on its own, and a film is only ever noted once.
 */
export function acceptCritiques(
  reply: CritiqueResponse | null,
  state: PreferenceState,
  picks: readonly CatalogueTitle[],
): Record<string, Critique> {
  if (!reply || reply.status !== "ok" || reply.stateVersion !== state.stateVersion) return {};
  const shown = new Set(picks.map(({ id }) => id));
  const accepted: Record<string, Critique> = {};
  for (const critique of reply.critiques) {
    if (!shown.has(critique.candidateId) || accepted[critique.candidateId]) continue;
    accepted[critique.candidateId] = critique;
  }
  return accepted;
}
