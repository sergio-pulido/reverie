import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isRefined, toShortlistFilters } from "../catalogue/shortlistFilters";
import { useCatalogueRead } from "../discover/CatalogueReadContext";
import { orderShortlist } from "../discover/rankedShortlist";
import { useAssistantRanking } from "../discover/useAssistantRanking";
import { useConversation } from "../discover/useConversation";
import { useRefinement } from "../discover/useRefinement";
import { carriesRequest } from "./filler";
import { messageIntent } from "./intent";
import { lookupResults, snapshotOf, SNAPSHOT_SIZE } from "./results";
import { useShortlist } from "./useShortlist";

/** How a message the viewer tried to send was taken. */
export type SendResult = "sent" | "filler" | "busy";

/**
 * One search session: the conversation, the preference state it narrows, and the films each
 * turn produced.
 *
 * A message is either looked up as a title or sent to the assistant, decided by `messageIntent`;
 * a lookup that finds nothing goes to the assistant too. Filler never leaves the screen. After the
 * assistant's turn is applied, the shortlist for the new state is read and ranked (by the
 * assistant once it has interpreted something, by the scorer otherwise), and the ranked films
 * are attached to that turn's answer as a snapshot. The engine, its grounding rule and its
 * version guard are the ones every turn has always gone through.
 *
 * The same shortlist is read live whenever anything narrows the results, for the strip's count and
 * the filter panel, ordered by the scorer: changing a filter never costs a model call and never
 * rewrites a turn's films.
 */
export function useSearch() {
  const refinement = useRefinement();
  const { state } = refinement;
  const talk = useConversation({ sessionId: state.sessionId, current: refinement.current, say: refinement.say });
  const { conversation, attach, notify } = talk;
  const read = useCatalogueRead();
  /** The answer line still waiting for its films. */
  const [awaiting, setAwaiting] = useState<number | null>(null);

  const refined = isRefined(state);
  const filters = useMemo(() => (refined ? toShortlistFilters(state) : null), [refined, state]);
  // Read whenever anything narrows, so the strip's count is live; only a turn's films are ranked by the model.
  const shortlist = useShortlist(filters, { enabled: refined });
  const response = shortlist.state?.phase === "ready" ? shortlist.state.response : null;
  const wantsAssistant = awaiting !== null && conversation.spoken && conversation.available;
  const ranking = useAssistantRanking(response?.items ?? null, state, wantsAssistant);
  const shown = useMemo(() => (response ? orderShortlist(response.items, state, ranking, wantsAssistant) : null), [response, state, ranking, wantsAssistant]);

  /** Once a waiting turn's films are read and ranked, they are attached to it for good. */
  useEffect(() => {
    if (awaiting === null) return;
    if (!refined) {
      setAwaiting(null);
      return;
    }
    const loaded = shortlist.state;
    if (!loaded || loaded.phase === "loading") return;
    if (loaded.phase === "ready") {
      if (!shown || shown.source === "pending") return;
      attach(awaiting, snapshotOf(shown, loaded.response.total));
    } else {
      notify(`Films could not be loaded. ${loaded.safeMessage}`);
    }
    setAwaiting(null);
  }, [awaiting, refined, shortlist.state, shown, attach, notify]);

  // Read at send time, when a turn still waiting must keep what is on screen for it now.
  const latest = useRef({ awaiting, shown, total: response?.total ?? null });
  latest.current = { awaiting, shown, total: response?.total ?? null };

  const lookup = useCallback(
    async (message: string) => {
      const found = await read({ query: message, page: 1, pageSize: SNAPSHOT_SIZE, filters: null }, new AbortController().signal);
      return found?.phase === "ready" ? lookupResults(found.response) : null;
    },
    [read],
  );

  const { send: say, pending } = talk;
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
      // A turn still waiting for its ranking keeps the scorer's order it has so far, labelled as such.
      const waiting = latest.current;
      if (waiting.awaiting !== null && waiting.shown) attach(waiting.awaiting, snapshotOf(waiting.shown, waiting.total));
      setAwaiting(null);

      const outcome = await say(message, messageIntent(message, { answering }) === "lookup" ? { lookup } : {});
      if (outcome.kind === "ignored") return "busy";
      if (outcome.kind === "reply" && outcome.answerLine !== null && isRefined(refinement.current())) setAwaiting(outcome.answerLine);
      return "sent";
    },
    [check, answering, attach, say, lookup, refinement],
  );

  return {
    refinement,
    conversation,
    pending,
    /** The answer line whose films are still on their way. */
    awaiting,
    check,
    send,
    /** The live shortlist, for the filter panel: null until the current filters are answered. */
    live: shown && response ? { shown, total: response.total } : null,
    liveFailure: shortlist.state && shortlist.state.phase !== "ready" && shortlist.state.phase !== "loading" ? shortlist.state.safeMessage : null,
    filters,
  };
}
