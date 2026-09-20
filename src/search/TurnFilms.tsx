import { useEffect, useMemo, useRef } from "react";
import { toShortlistRead } from "../catalogue/shortlistFilters";
import type { Critique } from "../conversation/contract";
import type { ResultSet } from "../conversation/transcript";
import { critiquePicks } from "../discover/critiques";
import { orderShortlist } from "../discover/rankedShortlist";
import { useAssistantCritique } from "../discover/useAssistantCritique";
import { useAssistantRanking } from "../discover/useAssistantRanking";
import type { PreferenceState } from "../preferences/schema";
import { snapshotOf, widenedNote, SNAPSHOT_SIZE } from "./results";
import { useShortlist, type SharedRead } from "./useShortlist";

/** A turn whose films are still being read and ranked, for the state its reply left. */
export type WaitingTurn = {
  lineId: number;
  state: PreferenceState;
  /** The assistant had interpreted something and was answering, so it ranks these films. */
  ranked: boolean;
};

/**
 * What a turn hands back, in the order it can. The films come first and the turn's row fills
 * with them; the critic's notes on its picks follow, and either way the last of the three ends
 * the turn. A turn whose films could not be read ends at once with the failure.
 */
export type TurnOutcome = { results: ResultSet } | { critiques: Readonly<Record<string, Critique>> } | { failure: string };

type TurnFilmsProps = {
  turn: WaitingTurn;
  /** The live read of the current state, used when it is for the same filters. */
  shared: SharedRead;
  onSettled: (turn: WaitingTurn, outcome: TurnOutcome) => void;
};

/**
 * Prepares one turn's films, hands them over, then waits out the critic and hands over what it
 * wrote. It reads, ranks and critiques for the state the turn's reply left, not for whatever the
 * state has become since: a filter changed, or another message sent, while this turn's films are
 * on their way never changes what this turn shows.
 *
 * The films are handed over the moment they are ranked, so the row fills at the speed it always
 * did and the critic's extra call is never in front of the posters. It draws nothing; the turn's
 * row shows it is waiting.
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

  // The critic writes about the row exactly as it is shown, and only when the assistant's own
  // order is what is shown: an order that fell back to the scorer has no picks of its to enlarge
  // on. The request goes out in the same commit that hands the films over, never after it.
  const row = useMemo(() => (shown?.source === "assistant" ? shown.items.slice(0, SNAPSHOT_SIZE) : null), [shown]);
  const picks = useMemo(() => (row && shown ? critiquePicks(row, shown.pickIds) : null), [row, shown]);
  const critique = useAssistantCritique(picks, row, turn.state, turn.ranked);

  const settled = useRef(false);
  const noted = useRef(false);
  useEffect(() => {
    const loaded = shortlist.state;
    if (settled.current || !loaded || loaded.phase === "loading") return;
    if (loaded.phase !== "ready") {
      settled.current = true;
      // Nothing was shown, so there is nothing for the critic to have written about.
      noted.current = true;
      onSettled(turn, { failure: loaded.safeMessage });
      return;
    }
    if (!shown || shown.source === "pending") return;
    settled.current = true;
    const missed = shortlist.widened && turn.state.subject ? widenedNote(turn.state.subject.phrase) : null;
    onSettled(turn, { results: snapshotOf(shown, loaded.response.total, missed) });
  }, [shortlist.state, shortlist.widened, shown, turn, onSettled]);

  useEffect(() => {
    if (noted.current || !settled.current || critique.phase !== "done") return;
    noted.current = true;
    onSettled(turn, { critiques: critique.critiques });
  }, [critique, turn, onSettled]);

  return null;
}
