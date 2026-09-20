import { useEffect, useMemo, useRef } from "react";
import { toShortlistRead } from "../catalogue/shortlistFilters";
import type { ResultSet } from "../conversation/transcript";
import { orderShortlist } from "../discover/rankedShortlist";
import { useAssistantRanking } from "../discover/useAssistantRanking";
import type { PreferenceState } from "../preferences/schema";
import { snapshotOf, widenedNote } from "./results";
import { useShortlist, type SharedRead } from "./useShortlist";

/** A turn whose films are still being read and ranked, for the state its reply left. */
export type WaitingTurn = {
  lineId: number;
  state: PreferenceState;
  /** The assistant had interpreted something and was answering, so it ranks these films. */
  ranked: boolean;
};

export type TurnOutcome = { results: ResultSet } | { failure: string };

type TurnFilmsProps = {
  turn: WaitingTurn;
  /** The live read of the current state, used when it is for the same filters. */
  shared: SharedRead;
  onSettled: (turn: WaitingTurn, outcome: TurnOutcome) => void;
};

/**
 * Prepares one turn's films and hands them over once, then has nothing more to do. It reads and
 * ranks for the state the turn's reply left, not for whatever the state has become since: a
 * filter changed, or another message sent, while this turn's films are on their way never changes
 * what this turn shows. It draws nothing; the turn's row shows it is waiting.
 *
 * When the subject the turn asked about matched nothing, the read widens to the filters alone and
 * the row keeps a note saying so, so the answer is never silently broader than the question.
 */
export function TurnFilms({ turn, shared, onSettled }: TurnFilmsProps) {
  const read = useMemo(() => toShortlistRead(turn.state), [turn.state]);
  const shortlist = useShortlist(read, { enabled: true, shared });
  const response = shortlist.state?.phase === "ready" ? shortlist.state.response : null;
  const ranking = useAssistantRanking(response?.items ?? null, turn.state, turn.ranked);
  const shown = useMemo(() => (response ? orderShortlist(response.items, turn.state, ranking, turn.ranked) : null), [response, turn.state, ranking, turn.ranked]);

  const settled = useRef(false);
  useEffect(() => {
    const loaded = shortlist.state;
    if (settled.current || !loaded || loaded.phase === "loading") return;
    if (loaded.phase !== "ready") {
      settled.current = true;
      onSettled(turn, { failure: loaded.safeMessage });
      return;
    }
    if (!shown || shown.source === "pending") return;
    settled.current = true;
    const missed = shortlist.widened && turn.state.subject ? widenedNote(turn.state.subject.phrase) : null;
    onSettled(turn, { results: snapshotOf(shown, loaded.response.total, missed) });
  }, [shortlist.state, shortlist.widened, shown, turn, onSettled]);

  return null;
}
