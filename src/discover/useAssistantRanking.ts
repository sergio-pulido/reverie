import { useEffect, useRef, useState } from "react";
import { toCandidates } from "../catalogue/candidates";
import type { CatalogueTitle } from "../catalogue/contract";
import { isEligible } from "../preferences/eligibility";
import type { PreferenceState } from "../preferences/schema";
import { requestRanking } from "./assistantClient";
import { rankingKey, type RankingStatus } from "./rankedShortlist";

/**
 * Asks the assistant to rank a refined shortlist once per shortlist and state. A newer shortlist
 * aborts the older request, and an answer for anything but the current key is never shown.
 * `titles` is null while the shortlist is loading, so nothing is ranked against a stale one.
 */
export function useAssistantRanking(titles: readonly CatalogueTitle[] | null, state: PreferenceState, enabled: boolean): RankingStatus {
  const [status, setStatus] = useState<RankingStatus>({ phase: "idle" });
  const controller = useRef<AbortController | null>(null);
  const key = titles ? rankingKey(state, titles) : null;

  // `key` encodes the session, the state version and every shortlisted id, so `titles` and
  // `state` cannot change under the same key; they are read here, not listed as dependencies.
  useEffect(() => {
    // Whatever was asked before is no longer wanted: a reload, a new state or switching off.
    controller.current?.abort();
    controller.current = null;
    if (!enabled || !key || !titles) return;
    const eligible = new Set(toCandidates(titles).filter((candidate) => isEligible(candidate, state)).map(({ id }) => id));
    const candidates = titles.filter(({ id }) => eligible.has(id));
    if (candidates.length === 0) {
      setStatus({ phase: "failed", key, message: "Nothing here is left to rank." });
      return;
    }

    const request = new AbortController();
    controller.current = request;
    setStatus({ phase: "ranking", key });

    void requestRanking(state, candidates, request.signal).then((reply) => {
      if (!reply || request.signal.aborted) return;
      if (reply.status === "ok") {
        setStatus({ phase: "ranked", key, stateVersion: reply.stateVersion, ranking: reply.ranking, reasons: reply.reasons });
      } else {
        setStatus({ phase: "failed", key, message: reply.safeMessage });
      }
    });
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => controller.current?.abort(), []);

  return status;
}
