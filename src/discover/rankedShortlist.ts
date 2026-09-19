import { toCandidates } from "../catalogue/candidates";
import type { CatalogueTitle } from "../catalogue/contract";
import { orderByAssistant, rankShortlist, type RankedShortlist } from "../catalogue/scorer";
import { PreferenceError } from "../preferences/errors";
import type { PreferenceState } from "../preferences/schema";

/**
 * Which ranking a refined shortlist is shown in, and the honest label for it. The model's order
 * is shown only when its ranking was made for exactly this shortlist and state and the engine
 * accepted it here; every other case is the deterministic scorer, labelled as such.
 */

export type RankingStatus =
  | { phase: "idle" }
  | { phase: "ranking"; key: string }
  | {
      phase: "ranked";
      key: string;
      stateVersion: number;
      ranking: readonly { candidateId: string; utility: number }[];
      reasons: readonly { candidateId: string; reason: string }[];
    }
  | { phase: "failed"; key: string; message: string };

export type RankingSource = "assistant" | "pending" | "fallback" | "genre";

export type ShownShortlist = {
  items: CatalogueTitle[];
  pickIds: ReadonlySet<string>;
  reasons: ReadonlyMap<string, string>;
  source: RankingSource;
  /** Why the assistant's order is not shown, when it was wanted. */
  note: string | null;
};

export const RANKED_BY: Record<RankingSource, string> = {
  assistant: "Ranked by the assistant",
  pending: "Ranking with the assistant…",
  fallback: "Ranked by genre match",
  genre: "Ranked by genre match",
};

/** Identifies one shortlist under one state: a ranking is valid for this key and no other. */
export function rankingKey(state: PreferenceState, items: readonly CatalogueTitle[]): string {
  return `${state.sessionId}|${state.stateVersion}|${items.map(({ id }) => id).join(",")}`;
}

export function orderShortlist(
  items: readonly CatalogueTitle[],
  state: PreferenceState,
  status: RankingStatus,
  wantsAssistant: boolean,
): ShownShortlist {
  const candidates = toCandidates(items);
  const key = rankingKey(state, items);
  const current = status.phase !== "idle" && status.key === key ? status : null;

  if (wantsAssistant && current?.phase === "ranked") {
    try {
      const ranked = orderByAssistant(candidates, state, current.stateVersion, current.ranking);
      const pickIds = new Set(ranked.picks.map(({ id }) => id));
      const reasons = new Map(current.reasons.filter(({ candidateId }) => pickIds.has(candidateId)).map(({ candidateId, reason }) => [candidateId, reason]));
      return shown(ranked, "assistant", null, pickIds, reasons);
    } catch (error) {
      if (!(error instanceof PreferenceError)) throw error;
      return scored(candidates, state, "fallback", "The assistant's ranking did not match these films.");
    }
  }
  if (wantsAssistant && current?.phase === "failed") return scored(candidates, state, "fallback", current.message);
  if (wantsAssistant) {
    // The scorer's order holds the grid still while the assistant ranks; nothing is marked as
    // a pick, because nothing has picked it yet.
    const { ordered } = rankShortlist(candidates, state);
    return { items: ordered.map(({ title }) => title), pickIds: new Set(), reasons: new Map(), source: "pending", note: null };
  }
  return scored(candidates, state, "genre", null);
}

function scored(candidates: ReturnType<typeof toCandidates>, state: PreferenceState, source: RankingSource, note: string | null): ShownShortlist {
  const ranked = rankShortlist(candidates, state);
  return shown(ranked, source, note, new Set(ranked.picks.map(({ id }) => id)), new Map());
}

function shown(
  ranked: RankedShortlist,
  source: RankingSource,
  note: string | null,
  pickIds: ReadonlySet<string>,
  reasons: ReadonlyMap<string, string>,
): ShownShortlist {
  return { items: ranked.ordered.map(({ title }) => title), pickIds, reasons, source, note };
}
