import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_MESSAGE_CHARS } from "../conversation/decision";
import {
  EMPTY_CONVERSATION,
  answerLineOf,
  assistantReplied,
  attachResults,
  lookupAnswered,
  systemSaid,
  viewerSaid,
  type Conversation,
  type ResultSet,
} from "../conversation/transcript";
import type { PreferenceState, TurnInput } from "../preferences/schema";
import { useAssistant } from "./AssistantContext";

type Speaker = {
  sessionId: string;
  current: () => PreferenceState;
  say: (turn: TurnInput) => boolean;
};

export type SendOptions = {
  /**
   * Looks the message up as a title first. The assistant is asked only when this finds nothing,
   * so a lookup never dead-ends.
   */
  lookup?: (message: string) => Promise<ResultSet | null>;
};

export type SendOutcome =
  /** Nothing was sent: an empty message, one already on its way, or a session that ended. */
  | { kind: "ignored" }
  | { kind: "lookup"; turn: number }
  /** The assistant answered. `accepted` is whether the engine applied its turn here. */
  | { kind: "reply"; turn: number; answerLine: number | null; accepted: boolean };

/**
 * The viewer's side of the conversation for one session. A message opens a turn; it is looked up
 * as a title when asked to, and otherwise (or when the lookup finds nothing) sent to the server,
 * whose turn comes back and is applied through the same engine as a filter. "Start over" begins
 * a new session, which clears the conversation too.
 */
export function useConversation({ sessionId, current, say }: Speaker) {
  const { requestTurn } = useAssistant();
  const [conversation, setConversation] = useState<Conversation>(EMPTY_CONVERSATION);
  const [pending, setPending] = useState(false);
  // The latest conversation, so updates made across awaits build on each other.
  const latest = useRef(conversation);
  const busy = useRef(false);
  const session = useRef(sessionId);

  const commit = useCallback((next: Conversation) => {
    latest.current = next;
    setConversation(next);
  }, []);

  useEffect(() => {
    if (session.current === sessionId) return;
    session.current = sessionId;
    busy.current = false;
    commit(EMPTY_CONVERSATION);
    setPending(false);
  }, [sessionId, commit]);

  const send = useCallback(
    async (raw: string, { lookup }: SendOptions = {}): Promise<SendOutcome> => {
      const message = raw.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!message || busy.current) return { kind: "ignored" };
      const askedIn = session.current;
      busy.current = true;
      setPending(true);
      const opened = viewerSaid(latest.current, message);
      commit(opened);
      const turn = opened.turns;
      try {
        if (lookup) {
          const found = await lookup(message);
          if (session.current !== askedIn) return { kind: "ignored" };
          if (found) {
            commit(lookupAnswered(latest.current, message, found));
            return { kind: "lookup", turn };
          }
        }
        const reply = await requestTurn(message, current(), latest.current.openQuestion);
        if (session.current !== askedIn) return { kind: "ignored" };
        const accepted = reply?.status === "ok" ? say(reply.turn) : false;
        const answered = assistantReplied(latest.current, reply, accepted);
        commit(answered);
        return { kind: "reply", turn, answerLine: accepted ? answerLineOf(answered, turn) : null, accepted };
      } finally {
        if (session.current === askedIn) {
          busy.current = false;
          setPending(false);
        }
      }
    },
    [current, say, requestTurn, commit],
  );

  /** A turn's films, attached to its answer once; a later call for the same line changes nothing. */
  const attach = useCallback((lineId: number, results: ResultSet) => commit(attachResults(latest.current, lineId, results)), [commit]);
  /** Something the screen has to say about the current turn. */
  const notify = useCallback((text: string) => commit(systemSaid(latest.current, text)), [commit]);

  return { conversation, pending, send, attach, notify };
}
