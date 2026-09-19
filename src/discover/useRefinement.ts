import { useCallback, useRef, useState } from "react";
import { CATALOGUE_CONFIGURATION } from "../catalogue/domain";
import {
  refinementTurn,
  refinementWithdrawal,
  withdrawalTurn,
  type ActiveRefinement,
  type Refinement,
} from "../catalogue/refinements";
import { PreferenceError, type PreferenceErrorCode } from "../preferences/errors";
import type { PreferenceState, TurnInput } from "../preferences/schema";
import { applyTurn, newState, rejectCandidate, restoreRejected } from "../preferences/state";

const NOTICES: Partial<Record<PreferenceErrorCode, string>> = {
  turn_limit_reached: "That is as much as one conversation holds. Start over to keep refining.",
  rejection_limit_reached: "That is as many titles as one session can turn down. Bring them back or start over.",
};
const FALLBACK_NOTICE = "That refinement could not be applied, so nothing changed.";

function newSession(): PreferenceState {
  return newState(`discover-${crypto.randomUUID()}`);
}

/**
 * The viewer's preference state for one Discover visit. Every change goes through the engine,
 * so a refused change leaves the state as it was and says why instead of half-applying.
 */
export function useRefinement() {
  const [state, setState] = useState<PreferenceState>(newSession);
  const [notice, setNotice] = useState<string | null>(null);
  // The latest state, so two quick presses build on each other instead of on the same render.
  const latest = useRef(state);

  const change = useCallback((next: (current: PreferenceState) => PreferenceState) => {
    try {
      const updated = next(latest.current);
      latest.current = updated;
      setState(updated);
      setNotice(null);
    } catch (error) {
      if (!(error instanceof PreferenceError)) throw error;
      setNotice(NOTICES[error.code] ?? FALLBACK_NOTICE);
    }
  }, []);

  const applyIfAny = (current: PreferenceState, turn: TurnInput | null) =>
    turn ? applyTurn(current, turn, CATALOGUE_CONFIGURATION) : current;

  const choose = useCallback(
    (refinement: Refinement) => change((current) => applyTurn(current, refinementTurn(refinement, current), CATALOGUE_CONFIGURATION)),
    [change],
  );
  const unchoose = useCallback(
    (refinement: Refinement) => change((current) => applyIfAny(current, refinementWithdrawal(refinement, current))),
    [change],
  );
  const withdraw = useCallback(
    (item: ActiveRefinement) => change((current) => applyIfAny(current, withdrawalTurn(current, item))),
    [change],
  );
  const reject = useCallback((candidateId: string) => change((current) => rejectCandidate(current, candidateId)), [change]);
  const restore = useCallback(() => change(restoreRejected), [change]);
  const reset = useCallback(() => change(newSession), [change]);

  return { state, notice, choose, unchoose, withdraw, reject, restore, reset };
}
