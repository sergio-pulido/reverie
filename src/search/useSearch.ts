import { useCallback, useEffect, useMemo, useState } from "react";
import { isRefined, toShortlistFilters } from "../catalogue/shortlistFilters";
import { useCatalogueRead } from "../discover/CatalogueReadContext";
import { orderShortlist, type RankingStatus } from "../discover/rankedShortlist";
import { useConversation } from "../discover/useConversation";
import { useRefinement } from "../discover/useRefinement";
import { carriesRequest } from "./filler";
import { messageIntent } from "./intent";
import { lookupResults, SNAPSHOT_SIZE } from "./results";
import type { TurnOutcome, WaitingTurn } from "./TurnFilms";
import { useShortlist } from "./useShortlist";

/** How a message the viewer tried to send was taken. */
export type SendResult = "sent" | "filler" | "busy";

const NOT_RANKED: RankingStatus = { phase: "idle" };

/**
 * One search session: the conversation, the preference state it narrows, and the films each
 * turn produced.
 *
 * A message is either looked up as a title or sent to the assistant, decided by `messageIntent`;
 * a lookup that finds nothing goes to the assistant too. Filler never leaves the screen. Once the
 * assistant's turn is applied and anything narrows the results, the turn waits for its films:
 * `waiting` lists such turns, each with the state its reply left, and the screen prepares each one
 * (`TurnFilms`) and hands the ranked films back through `settle`, where they are attached to the
 * turn for good. The engine, its grounding rule and its version guard are the ones every turn has
 * always gone through.
 *
 * The shortlist for the current state is also read live whenever anything narrows the results, for
 * the strip's count and the filter panel, ordered by the scorer: changing a filter never costs a
 * model call and never changes a turn's films.
 */
export function useSearch() {
  const refinement = useRefinement();
  const { state } = refinement;
  const talk = useConversation({ sessionId: state.sessionId, current: refinement.current, say: refinement.say });
  const { conversation, attach, notify, send: say, pending } = talk;
  const read = useCatalogueRead();
  const [waiting, setWaiting] = useState<readonly WaitingTurn[]>([]);

  // A new session starts with nothing waiting.
  useEffect(() => setWaiting((current) => (current.length === 0 ? current : [])), [state.sessionId]);

  const refined = isRefined(state);
  const filters = useMemo(() => (refined ? toShortlistFilters(state) : null), [refined, state]);
  const shortlist = useShortlist(filters, { enabled: refined });
  const response = shortlist.state?.phase === "ready" ? shortlist.state.response : null;
  const shown = useMemo(() => (response ? orderShortlist(response.items, state, NOT_RANKED, false) : null), [response, state]);

  const { current } = refinement;
  const settle = useCallback(
    (turn: WaitingTurn, outcome: TurnOutcome) => {
      setWaiting((turns) => turns.filter(({ lineId }) => lineId !== turn.lineId));
      // Line ids start again in a new session: films for a turn of an ended one go nowhere.
      if (turn.state.sessionId !== current().sessionId) return;
      if ("results" in outcome) attach(turn.lineId, outcome.results);
      else notify(`Films could not be loaded. ${outcome.failure}`);
    },
    [attach, notify, current],
  );

  const lookup = useCallback(
    async (message: string) => {
      const found = await read({ query: message, page: 1, pageSize: SNAPSHOT_SIZE, filters: null }, new AbortController().signal);
      return found?.phase === "ready" ? lookupResults(found.response) : null;
    },
    [read],
  );

  const answering = conversation.openQuestion !== null;

  /** Whether `message` would be sent now: filler never is, and nothing goes while a turn is on its way. */
  const check = useCallback(
    (message: string): SendResult => (!carriesRequest(message, { answering }) ? "filler" : pending ? "busy" : "sent"),
    [answering, pending],
  );

  const send = useCallback(
    async (message: string): Promise<SendResult> => {
      const verdict = check(message);
      if (verdict !== "sent") return verdict;
      const outcome = await say(message, messageIntent(message, { answering }) === "lookup" ? { lookup } : {});
      if (outcome.kind === "ignored") return "busy";
      const after = current();
      if (outcome.kind === "reply" && outcome.answerLine !== null && isRefined(after)) {
        const turn: WaitingTurn = { lineId: outcome.answerLine, state: after, ranked: outcome.canRank };
        setWaiting((turns) => [...turns, turn]);
      }
      return "sent";
    },
    [check, answering, say, lookup, current],
  );

  return {
    refinement,
    conversation,
    pending,
    /** Turns whose films are still on their way, each for the state its reply left. */
    waiting,
    settle,
    check,
    send,
    /** The live read of the current state, which a waiting turn with the same filters shares. */
    shared: { key: shortlist.key, state: shortlist.state },
    /** The live shortlist, for the strip and the filter panel: null until the current filters are answered. */
    live: shown && response ? { shown, total: response.total } : null,
    liveFailure: shortlist.state && shortlist.state.phase !== "ready" && shortlist.state.phase !== "loading" ? shortlist.state.safeMessage : null,
    filters,
  };
}
